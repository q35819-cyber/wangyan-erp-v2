#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { projectLibrary, projectionContentSha256 } = require('../auth/category-attribute-projection');
const { sha256File } = require('../auth/private-object-store');

function arg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : '';
}

function versionLabel(value) {
  const timestamp = new Date(value || 0);
  if (!Number.isFinite(timestamp.getTime())) throw new Error('category source timestamp is invalid');
  return timestamp.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  const input = path.resolve(arg('input') || '');
  const outputDir = path.resolve(arg('output-dir') || '');
  if (!arg('input') || !arg('output-dir') || !fs.existsSync(input) || !fs.statSync(input).isFile()) {
    throw new Error('--input must name an existing snapshot and --output-dir is required');
  }
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const sourceSnapshotSha256 = await sha256File(input);
  const source = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const projection = projectLibrary(source, { sourceSnapshotSha256 });
  const baseName = `ozon-category-attributes-${versionLabel(projection.sourceUpdatedAt)}-${sourceSnapshotSha256.slice(0, 12)}`;
  const target = path.join(outputDir, `${baseName}.json`);
  const temporary = `${target}.${crypto.randomUUID()}.partial`;
  const body = JSON.stringify(projection) + '\n';
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) { /* partial output only */ }
    throw error;
  }
  const sha256 = await sha256File(target);
  const sidecar = `${target}.sha256`;
  fs.writeFileSync(sidecar, `${sha256}  ${path.basename(target)}\n`, { flag: 'wx', encoding: 'ascii', mode: 0o600 });
  const manifest = {
    version: 1,
    file: path.basename(target),
    bytes: fs.statSync(target).size,
    sha256,
    projectionContentSha256: projectionContentSha256(projection),
    sourceFile: path.basename(input),
    sourceSnapshotSha256,
    generatedAt: projection.generatedAt,
    sourceUpdatedAt: projection.sourceUpdatedAt,
    counts: projection.counts,
    containsTenantOrUserScope: false,
    containsFailureState: false
  };
  fs.writeFileSync(`${target}.manifest.json`, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', encoding: 'utf8', mode: 0o600 });
  console.log(target);
}

main().catch(error => { console.error(`Category projection failed: ${error.message}`); process.exitCode = 1; });
