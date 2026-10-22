'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function canonicalCompleteBackups(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^wyerp-\d{8}T\d{6}Z\.dump$/.test(name))
    .sort().reverse()
    .filter(name => fs.existsSync(path.join(directory, `${name}.sha256`)) && fs.existsSync(path.join(directory, `${name}.json`)));
}

function inspectBackupReplica(localDirectory, replicaDirectory) {
  const issues = [];
  const localRoot = path.resolve(String(localDirectory || ''));
  const replicaRoot = path.resolve(String(replicaDirectory || ''));
  if (!localDirectory) issues.push({ code: 'backup_dir', message: '缺少本地备份目录' });
  if (!replicaDirectory) issues.push({ code: 'replica_dir', message: '缺少异机/异账号副本目录' });
  if (issues.length) return { ok: false, issues };
  if (localRoot === replicaRoot) issues.push({ code: 'same_root', message: '备份目录与副本目录不能是同一路径' });
  const local = canonicalCompleteBackups(localRoot);
  if (!local.length) issues.push({ code: 'local_backup_missing', message: '没有完整 PostgreSQL 备份组' });
  if (issues.length) return { ok: false, issues };
  const name = local[0];
  const localDump = path.join(localRoot, name);
  const replicaDump = path.join(replicaRoot, name);
  for (const suffix of ['', '.sha256', '.json']) {
    if (!fs.existsSync(path.join(replicaRoot, name + suffix))) issues.push({ code: 'replica_group_incomplete', message: `副本缺少 ${name + suffix}` });
  }
  if (!issues.length) {
    const localHash = sha256(localDump);
    const replicaHash = sha256(replicaDump);
    if (localHash !== replicaHash) issues.push({ code: 'replica_hash_mismatch', message: '副本 dump SHA-256 与本地备份不一致' });
    const expected = fs.readFileSync(localDump + '.sha256', 'utf8').trim().split(/\s+/)[0].toLowerCase();
    if (expected !== localHash) issues.push({ code: 'local_hash_mismatch', message: '本地备份 SHA-256 证据与 dump 不一致' });
  }
  return { ok: issues.length === 0, issues, backup: name };
}

function inspectReleaseManifest(file) {
  const issues = [];
  if (!file || !fs.existsSync(file)) return { ok: false, issues: [{ code: 'release_manifest', message: '缺少发布候选清单' }] };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { ok: false, issues: [{ code: 'release_manifest_json', message: `发布清单无效: ${error.message}` }] }; }
  const required = ['releaseId', 'sourceCommit', 'rollbackReleaseId', 'rollbackSourceCommit', 'artifactSha256', 'createdAt'];
  for (const key of required) if (!String(manifest[key] || '').trim()) issues.push({ code: `manifest_${key}`, message: `发布清单缺少 ${key}` });
  if (manifest.releaseId === manifest.rollbackReleaseId) issues.push({ code: 'rollback_same_release', message: '当前版本与回滚版本不能相同' });
  if (manifest.sourceCommit === manifest.rollbackSourceCommit) issues.push({ code: 'rollback_same_commit', message: '当前提交与回滚提交不能相同' });
  if (manifest.artifactSha256 && !/^[a-f0-9]{64}$/i.test(manifest.artifactSha256)) issues.push({ code: 'artifact_sha256', message: 'artifactSha256 格式无效' });
  if (manifest.createdAt && !Number.isFinite(Date.parse(manifest.createdAt))) issues.push({ code: 'created_at', message: 'createdAt 不是有效时间' });
  return { ok: issues.length === 0, issues, manifest };
}

function inspectContinuity(environment = process.env) {
  const backup = inspectBackupReplica(environment.ERP_BACKUP_DIR, environment.ERP_BACKUP_REPLICA_DIR);
  const release = inspectReleaseManifest(environment.ERP_RELEASE_MANIFEST);
  return { ok: backup.ok && release.ok, backup, release };
}

function main() {
  const result = inspectContinuity(process.env);
  if (!result.ok) {
    console.error('[production-continuity] FAIL');
    for (const issue of [...result.backup.issues, ...result.release.issues]) console.error(`- ${issue.code}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[production-continuity] PASS backup=${result.backup.backup} release=${result.release.manifest.releaseId} rollback=${result.release.manifest.rollbackReleaseId}`);
}

if (require.main === module) main();
module.exports = { sha256, canonicalCompleteBackups, inspectBackupReplica, inspectReleaseManifest, inspectContinuity };
