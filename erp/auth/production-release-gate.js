'use strict';

const fs = require('fs');
const path = require('path');
const { inspectProductionReadiness } = require('./production-readiness');
const { inspectContinuity } = require('./production-continuity');
const { inspectRolloutPolicy } = require('./production-rollout');

function readJson(file, code, issues) {
  if (!file || !fs.existsSync(file)) {
    issues.push({ code, message: `缺少证据文件: ${file || '(未配置)'}` });
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    issues.push({ code: `${code}_json`, message: `证据 JSON 无效: ${error.message}` });
    return null;
  }
}

function inspectReleaseEvidence(environment = process.env, options = {}) {
  const issues = [];
  const readiness = inspectProductionReadiness(environment, options);
  for (const issue of readiness.issues) issues.push({ source: 'readiness', ...issue });
  const continuity = inspectContinuity(environment);
  for (const issue of continuity.backup.issues) issues.push({ source: 'backup', ...issue });
  for (const issue of continuity.release.issues) issues.push({ source: 'release', ...issue });
  const rollout = inspectRolloutPolicy(environment.ERP_ROLLOUT_POLICY);
  for (const issue of rollout.issues) issues.push({ source: 'rollout', ...issue });

  const release = continuity.release.manifest || null;
  const p3 = readJson(environment.ERP_P3_REPORT, 'p3_report', issues);
  if (p3) {
    if (p3.result !== 'passed') issues.push({ source: 'p3', code: 'p3_failed', message: 'P3 安全验收结果不是 passed' });
    if (!p3.source || p3.source.clean !== true) issues.push({ source: 'p3', code: 'p3_dirty_source', message: 'P3 必须基于干净源码树' });
    const vulnerabilities = p3.dependencyVulnerabilities || {};
    if (Number(vulnerabilities.high || 0) > 0 || Number(vulnerabilities.critical || 0) > 0) issues.push({ source: 'p3', code: 'p3_dependency_risk', message: 'P3 仍存在 high/critical 生产依赖漏洞' });
    if (release && p3.source && String(p3.source.commit || '') !== String(release.sourceCommit || '')) issues.push({ source: 'p3', code: 'p3_commit_mismatch', message: 'P3 验收提交与发布候选提交不一致' });
  }

  const restore = readJson(environment.ERP_RESTORE_EVIDENCE, 'restore_evidence', issues);
  if (restore) {
    if (restore.result !== 'passed') issues.push({ source: 'restore', code: 'restore_failed', message: '干净恢复演练结果不是 passed' });
    if (!restore.backup || restore.backup !== continuity.backup.backup) issues.push({ source: 'restore', code: 'restore_backup_mismatch', message: '恢复演练使用的备份不是当前放行检查的最新完整备份' });
    if (!/^[a-f0-9]{64}$/i.test(String(restore.backupSha256 || ''))) issues.push({ source: 'restore', code: 'restore_hash_missing', message: '恢复演练缺少有效备份 SHA-256' });
  }

  const migration = readJson(environment.ERP_MIGRATION_EVIDENCE, 'migration_evidence', issues);
  if (migration) {
    if (migration.result !== 'passed') issues.push({ source: 'migration', code: 'migration_failed', message: '迁移/切换验收结果不是 passed' });
    if (migration.authoritative !== 'postgresql') issues.push({ source: 'migration', code: 'migration_authority', message: '权威业务数据源必须明确为 postgresql' });
    if (migration.reconciled !== true) issues.push({ source: 'migration', code: 'migration_reconciliation', message: '迁移证据必须明确全量对账通过' });
  }

  const load = readJson(environment.ERP_LOAD_EVIDENCE, 'load_evidence', issues);
  const staging = readJson(environment.ERP_STAGING_EVIDENCE, 'staging_evidence', issues);
  if (staging) {
    if (staging.result !== 'passed') issues.push({ source: 'staging', code: 'staging_failed', message: '预发布探针结果不是 passed' });
    if (staging.origin !== environment.PUBLIC_ORIGIN) issues.push({ source: 'staging', code: 'staging_origin_mismatch', message: '预发布探针地址与 PUBLIC_ORIGIN 不一致' });
    if (staging.securityHeaders !== true) issues.push({ source: 'staging', code: 'staging_security_headers', message: '预发布安全响应头未通过' });
    if (staging.httpRedirect !== true) issues.push({ source: 'staging', code: 'staging_https_redirect', message: '预发布 HTTP→HTTPS 跳转未通过' });
    if (!staging.health || staging.health.live !== 200 || staging.health.ready !== 200) issues.push({ source: 'staging', code: 'staging_health', message: '预发布 live/ready 未同时返回 200' });
  }

  if (load) {
    if (load.result !== 'passed') issues.push({ source: 'load', code: 'load_failed', message: '容量/负载验收结果不是 passed' });
    if (Number(load.errorRate || 0) < 0 || Number(load.errorRate || 0) > 0.01) issues.push({ source: 'load', code: 'load_error_rate', message: '容量验收错误率超过 1% 放行上限' });
    if (!Number.isFinite(Number(load.p95Ms)) || !Number.isFinite(Number(load.p99Ms))) issues.push({ source: 'load', code: 'load_latency_missing', message: '容量证据必须包含 p95Ms/p99Ms' });
  }

  return { ok: issues.length === 0, issues, readiness, continuity, rollout, p3, restore, migration, load, staging };
}

function main() {
  const result = inspectReleaseEvidence(process.env);
  if (!result.ok) {
    console.error('[production-release-gate] FAIL');
    for (const issue of result.issues) console.error(`- ${issue.source || 'gate'}/${issue.code}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[production-release-gate] PASS release=${result.continuity.release.manifest.releaseId} backup=${result.continuity.backup.backup}`);
  console.log('全部证据只表示候选满足自动门禁；是否真实公网放量仍需独立测试与人工放行。');
}

if (require.main === module) main();
module.exports = { readJson, inspectReleaseEvidence };
