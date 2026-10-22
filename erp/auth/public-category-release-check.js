'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createPublicCategoryCatalog } = require('./public-category-catalog');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

// Offline preflight: validates every immutable shard. Never changes the active
// version, touches the database, or represents a complete release permission.
async function verifyPublicCatalogFiles({ rootDir, sourceFile }) {
  if (!rootDir) throw new Error('必须明确指定待检查的公共类目目录。');
  const store = createPublicCategoryCatalog(path.resolve(rootDir));
  const active = await store.active();
  if (!active) throw new Error('没有激活的公共类目版本，暂不允许发布。');
  const { manifest, versionDir } = active;
  if (sourceFile) {
    const sourceHash = await fileSha256(path.resolve(sourceFile));
    if (sourceHash !== manifest.sourceSha256) throw new Error('原始类目来源摘要不一致，禁止切换公共目录。');
  }
  const listing = await store.catalog();
  const matcher = await store.matcher();
  const uniqueKeys = new Set();
  const indexByDescription = new Map();
  for (const item of listing.items) {
    if (!item.key || uniqueKeys.has(item.key)) throw new Error('公共类目目录存在重复或空类目编号。');
    uniqueKeys.add(item.key);
    const descriptionId = String(item.descriptionCategoryId || '');
    if (!/^\d{1,24}$/.test(descriptionId)) throw new Error('公共类目存在非法描述类目编号。');
    if (!indexByDescription.has(descriptionId)) indexByDescription.set(descriptionId, new Set());
    indexByDescription.get(descriptionId).add(item.key);
  }
  if (uniqueKeys.size !== manifest.categoryCount || Object.keys(matcher.categories || {}).length !== manifest.categoryCount) {
    throw new Error('公共类目目录和匹配索引数量不一致。');
  }
  let verifiedFiles = 2, verifiedShards = 0, totalShardBytes = 0;
  for (const [id, check] of Object.entries(manifest.shards || {})) {
    if (!/^\d{1,24}$/.test(id)) throw new Error('公共类目分片文件名不合法。');
    const filename = path.join(versionDir, 'categories', `${id}.json`);
    const bytes = await fs.promises.readFile(filename);
    if (bytes.length !== Number(check.bytes) || sha256(bytes) !== check.sha256) throw new Error('公共类目分片校验失败。');
    const data = JSON.parse(bytes.toString('utf8'));
    const expected = indexByDescription.get(id);
    if (!expected || Object.keys(data).length !== expected.size) throw new Error('公共类目分片条目与索引不一致。');
    for (const key of Object.keys(data)) {
      if (!expected.has(key) || !Object.hasOwn(matcher.categories, key)) throw new Error('公共类目分片或匹配索引缺少对应条目。');
    }
    verifiedShards++;
    verifiedFiles++;
    totalShardBytes += bytes.length;
  }
  if (verifiedShards !== manifest.shardCount || verifiedShards !== indexByDescription.size) throw new Error('公共类目分片总数不一致。');
  return {
    status: 'static_files_verified_only',
    version: active.version,
    sourceSha256: manifest.sourceSha256,
    categories: uniqueKeys.size,
    shards: verifiedShards,
    verifiedFiles,
    shardBytes: totalShardBytes,
    releaseApproved: false,
    remainingGates: ['所有租户现有类目差异只读对账', '独立PostgreSQL/浏览器端到端联测', '唯一Release集成权限及回滚演练']
  };
}

module.exports = { verifyPublicCatalogFiles };
