'use strict';

const fs = require('fs');
const path = require('path');

function inside(parent, child) {
  const base = path.resolve(parent) + path.sep;
  const target = path.resolve(child) + path.sep;
  return target.startsWith(base);
}

function nonEmpty(value) {
  return String(value || '').trim();
}

function existingSecret(environment, inlineName, fileName) {
  if (nonEmpty(environment[inlineName])) return true;
  const file = nonEmpty(environment[fileName]);
  if (!file) return false;
  try { return fs.statSync(path.resolve(file)).isFile() && nonEmpty(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (_) { return false; }
}

function inspectProductionReadiness(environment = process.env, options = {}) {
  const appRoot = path.resolve(options.appRoot || path.join(__dirname, '..'));
  const issues = [];
  const requireValue = (condition, code, message) => { if (!condition) issues.push({ code, message }); };

  requireValue(environment.NODE_ENV === 'production', 'node_env', 'NODE_ENV 必须为 production');
  const host = nonEmpty(environment.ERP_HOST) || '127.0.0.1';
  requireValue(['127.0.0.1', '::1', 'localhost'].includes(host), 'loopback_bind', '生产 Node 必须只监听回环地址并由反向代理对外提供 HTTPS');
  requireValue(nonEmpty(environment.ERP_TRUST_PROXY) === '1', 'trust_proxy', '同机反向代理生产部署必须设置 ERP_TRUST_PROXY=1');

  let publicOrigin = null;
  try { publicOrigin = new URL(nonEmpty(environment.PUBLIC_ORIGIN)); } catch (_) {}
  requireValue(Boolean(publicOrigin) && publicOrigin.protocol === 'https:', 'public_origin', 'PUBLIC_ORIGIN 必须是有效的 https:// 地址');

  requireValue(nonEmpty(environment.ERP_CSRF_SECRET).length >= 32 || existingSecret(environment, 'ERP_CSRF_SECRET', 'ERP_CSRF_SECRET_FILE'), 'csrf_secret', '必须注入至少 32 字符的 CSRF Secret 或有效 Secret 文件');
  requireValue(existingSecret(environment, 'ERP_CREDENTIALS_KEY', 'ERP_CREDENTIALS_KEY_FILE'), 'credentials_key', '必须注入店铺凭证加密密钥或有效密钥文件');
  const smtpUser = nonEmpty(environment.SMTP_USER);
  const smtpPass = String(environment.SMTP_PASS || '');
  const alertEmail = nonEmpty(environment.BUG_REPORT_EMAIL);
  requireValue(Boolean(smtpUser && smtpPass), 'smtp_alerting', '生产环境必须配置 SMTP_USER/SMTP_PASS，确保接口与安全告警可发送');
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail), 'alert_recipient', 'BUG_REPORT_EMAIL 必须配置为有效告警邮箱');

  const dataDir = nonEmpty(environment.ERP_DATA_DIR);
  const privateDir = nonEmpty(environment.ERP_PRIVATE_OBJECT_DIR);
  const backupDir = nonEmpty(environment.ERP_BACKUP_DIR);
  const backupReplicaDir = nonEmpty(environment.ERP_BACKUP_REPLICA_DIR);
  const backupReplicaClass = nonEmpty(environment.ERP_BACKUP_REPLICA_CLASS);
  const runtimeLogDir = nonEmpty(environment.ERP_RUNTIME_LOG_DIR);
  for (const [code, value, label] of [
    ['data_dir', dataDir, 'ERP_DATA_DIR'],
    ['private_object_dir', privateDir, 'ERP_PRIVATE_OBJECT_DIR'],
    ['backup_dir', backupDir, 'ERP_BACKUP_DIR'],
    ['backup_replica_dir', backupReplicaDir, 'ERP_BACKUP_REPLICA_DIR'],
    ['runtime_log_dir', runtimeLogDir, 'ERP_RUNTIME_LOG_DIR']
  ]) {
    requireValue(Boolean(value), code, `${label} 必须显式配置`);
    if (value) requireValue(!inside(appRoot, value), `${code}_outside_app`, `${label} 必须位于应用目录之外`);
  }
  if (backupDir && backupReplicaDir) requireValue(path.resolve(backupDir) !== path.resolve(backupReplicaDir), 'backup_replica_separate', 'ERP_BACKUP_REPLICA_DIR 必须与 ERP_BACKUP_DIR 不同');
  requireValue(['remote-machine', 'remote-account', 'offline-media'].includes(backupReplicaClass), 'backup_replica_class', 'ERP_BACKUP_REPLICA_CLASS 必须为 remote-machine、remote-account 或 offline-media');

  requireValue(nonEmpty(environment.ERP_LEGACY_JSON_LAZY_IMPORT) !== '1', 'legacy_lazy_import', '生产环境禁止旧 JSON 懒迁移');
  requireValue(nonEmpty(environment.ERP_PUBLIC_LAUNCH) !== '1', 'public_launch_gate', '当前准备阶段必须保持公网放量开关关闭，独测/预发布通过后才能单独切换');
  requireValue(nonEmpty(environment.ERP_CHARGING_ENABLED) !== '1', 'charging_gate', '第一阶段公网内测必须保持真实收费关闭');
  requireValue(nonEmpty(environment.ERP_AGENT_AUTO_PENALTY) !== '1', 'agent_penalty_gate', '第一阶段公网内测必须保持代理自动处罚关闭');

  return { ok: issues.length === 0, issues, appRoot };
}

function main() {
  const result = inspectProductionReadiness(process.env);
  if (!result.ok) {
    console.error('[production-readiness] FAIL');
    for (const issue of result.issues) console.error(`- ${issue.code}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('[production-readiness] PASS');
  console.log('生产准备配置通过静态门禁；这不等于已完成 TLS、反向代理、恢复演练或公网放量。');
}

if (require.main === module) main();
module.exports = { inside, existingSecret, inspectProductionReadiness };
