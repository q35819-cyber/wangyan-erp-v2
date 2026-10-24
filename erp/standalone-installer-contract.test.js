'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('fresh GUI installer has explicit one-shot default and hash validation', () => {
  const init = read('installer/Initialize.ps1');
  const bootstrap = read('erp/scripts/bootstrap-admin.ps1');
  const js = read('erp/scripts/bootstrap-admin.js');
  const verify = read('erp/scripts/verify-standalone-admin.js');
  assert.match(init, /-LocalDefaultPassword/);
  assert.match(init, /verify-standalone-admin\.js/);
  assert.match(bootstrap, /\$LocalDefaultPassword/);
  assert.match(bootstrap, /\$env:WYERP_STANDALONE_MODE -ne '1'/);
  assert.match(js, /c\.users!==0\|\|c\.tenants!==0\|\|c\.memberships!==0/);
  assert.match(js, /process\.env\.WYERP_BOOTSTRAP_LOCAL_DEFAULT==='1'/);
  assert.match(js, /process\.env\.WYERP_STANDALONE_MODE==='1'/);
  assert.match(verify, /verifyPassword\('123456'/);
  assert.match(verify, /adminCount\.rows\[0\]\.n !== 1/);
});

test('single-machine service does not probe SaaS cluster ports', () => {
  const init = read('installer/Initialize.ps1');
  const control = read('installer/Control.ps1');
  const recover = read('installer/Recover-Existing.ps1');
  const run = read('installer/Run-Server.ps1');
  assert.doesNotMatch(init, /ERP_CLUSTER_BASE_PORT|没有可用的独立集群端口区间/);
  assert.doesNotMatch(control, /内部集群端口|\$internalPorts|\$settings\.ClusterBasePort/);
  assert.doesNotMatch(recover, /ClusterBasePort/);
  assert.match(control, /\$ports=@\(\$appPort\)/);
  assert.match(run, /ERP_CLUSTER_ENABLED='0'/);
  assert.match(run, /WYERP_STANDALONE_MODE='1'/);
});

test('installed desktop manager resolves its own installation data root', () => {
  const init = read('installer/Initialize.ps1');
  const control = read('installer/Control.ps1');
  assert.match(init, /installer\/instance-location\.json/);
  assert.match(init, /DataRoot=\$data/);
  assert.match(control, /Get-Content -LiteralPath \$instanceFile/);
  assert.match(control, /\$DataRoot=\[string\]\$instance\.DataRoot/);
  assert.match(control, /\$instance\.InstallRoot/);
  assert.match(control, /\$settings\.InstallRoot/);
});

test('manager has per-instance mutex and visible plugin installation guide', () => {
  const manager = read('installer/WyerpERP-Manager.cs');
  const guide = read('installer/WyerpPluginGuide.cs');
  const control = read('installer/Control.ps1');
  const installer = read('tools/Install-Collector.ps1');
  const build = read('installer/Build-Manager.ps1');
  assert.match(manager, /WyerpCommunityManager-.*instanceKey/);
  assert.match(manager, /WyerpPluginGuide\.Show\(this, installRoot, InvokeControl\)/);
  assert.match(guide, /打开 Edge 扩展页/);
  assert.match(guide, /复制插件路径/);
  assert.match(guide, /检查插件文件/);
  assert.match(guide, /ShowDialog\(owner\)/);
  assert.match(control, /'PluginCheck'/);
  assert.match(installer, /\$ErpUrl/);
  assert.match(build, /WyerpPluginGuide\.cs/);
});

test('stale QA service auto cleanup is scoped to verified disposable QA installs', () => {
  const control = read('installer/Control.ps1');
  const cleaner = read('installer/Cleanup-StaleQA-Services.ps1');
  assert.match(control, /Clear-StaleQAOnStart/);
  assert.match(control, /-IncludeLegacyQA -Apply/);
  assert.match(cleaner, /WyerpIsolatedDeployQA-/);
  assert.match(cleaner, /if\(\$number -ge \$keepId\)/);
  assert.match(cleaner, /\$oldConfigPath/);
  assert.match(cleaner, /\$guiPaths/);
  assert.match(cleaner, /sc\.exe delete \$item\.Name/);
  assert.doesNotMatch(cleaner, /Remove-Item -LiteralPath \$oldRoot/);
});

test('standalone collection does not depend on disabled membership routes', () => {
  const quota = read('erp/assets/membership-quota.js');
  const collection = read('erp/assets/product-collection-page.js');
  const server = read('erp/server.js');
  assert.match(quota, /requester\('\/api\/local\/standalone-mode'\)/);
  assert.match(quota, /mode\.standalone !== true/);
  assert.match(quota, /localOnly: true/);
  assert.match(collection, /collectionQuota\.localOnly \? '采集箱商品'/);
  assert.match(server, /STANDALONE_MODE \|\| action === 'package-facts'/);
  assert.match(server, /key === 'erp_collected_products' && !STANDALONE_MODE/);
});

test('SaaS-only UI and APIs are off only on local single mode', () => {
  const server = read('erp/server.js');
  const ui = read('erp/assets/standalone-ui.js');
  assert.match(server, /STANDALONE_MODE = process\.env\.WYERP_STANDALONE_MODE === '1'/);
  assert.match(server, /\['127\.0\.0\.1', '::1', 'localhost'\]\.includes\(HOST\)/);
  assert.match(server, /STANDALONE_UNAVAILABLE_ROUTES/);
  assert.match(server, /if \(!STANDALONE_MODE\) \{\s*maybeAutoSyncOverview\(\)/);
  assert.match(ui, /123456/);
  assert.match(ui, /forgotPassword/);
});