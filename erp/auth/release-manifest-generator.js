'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function git(cwd, args) {
  return String(execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })).trim();
}

function buildReleaseManifest(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const artifact = path.resolve(options.artifact || '');
  const output = path.resolve(options.output || '');
  const releaseId = String(options.releaseId || '').trim();
  const rollbackReleaseId = String(options.rollbackReleaseId || '').trim();
  const rollbackSourceCommit = String(options.rollbackSourceCommit || '').trim();
  if (!releaseId) throw new Error('releaseId is required');
  if (!rollbackReleaseId) throw new Error('rollbackReleaseId is required');
  if (!/^[a-f0-9]{7,64}$/i.test(rollbackSourceCommit)) throw new Error('rollbackSourceCommit must be a Git commit hash');
  if (!artifact || !fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) throw new Error('artifact file not found');
  if (!output) throw new Error('output path is required');

  const porcelain = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (porcelain) throw new Error('release candidate source tree must be clean');
  const sourceCommit = git(cwd, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(sourceCommit)) throw new Error('unable to resolve current Git commit');
  if (sourceCommit.toLowerCase() === rollbackSourceCommit.toLowerCase()) throw new Error('rollback commit must differ from current release commit');
  if (releaseId === rollbackReleaseId) throw new Error('rollback release must differ from current release');

  const manifest = {
    releaseId,
    sourceCommit,
    rollbackReleaseId,
    rollbackSourceCommit,
    artifact: path.basename(artifact),
    artifactBytes: fs.statSync(artifact).size,
    artifactSha256: sha256(artifact),
    createdAt: new Date().toISOString(),
    sourceTreeClean: true
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, output);
  return manifest;
}

function parse(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function main() {
  try {
    const args = parse(process.argv.slice(2));
    const manifest = buildReleaseManifest({
      cwd: args.cwd || path.resolve(__dirname, '..', '..'),
      artifact: args.artifact,
      output: args.output,
      releaseId: args.release,
      rollbackReleaseId: args['rollback-release'],
      rollbackSourceCommit: args['rollback-commit']
    });
    console.log(`[release-manifest] PASS release=${manifest.releaseId} commit=${manifest.sourceCommit} sha256=${manifest.artifactSha256}`);
  } catch (error) {
    console.error(`[release-manifest] FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { sha256, git, buildReleaseManifest };
