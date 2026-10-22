'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeLibrary, summarizeLibrary } = require('./category-attribute-library');

const VERSION_RE = /^v1-[a-f0-9]{24}$/;
const ID_RE = /^\d{1,24}$/;
const PUBLIC_FIELDS = ['key', 'path', 'pathText', 'descriptionCategoryId', 'typeId', 'disabled',
  'required', 'optional', 'fetchedAt', 'sourceLanguage'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function publicCategory(item) {
  const output = {};
  for (const key of PUBLIC_FIELDS) if (Object.prototype.hasOwnProperty.call(item, key)) output[key] = item[key];
  return output;
}

function catalogItem(item) {
  return {
    key: item.key,
    descriptionCategoryId: String(item.descriptionCategoryId || item.path?.[1]?.id || ''),
    typeId: String(item.typeId || item.path?.[2]?.id || ''),
    disabled: Boolean(item.disabled),
    path: Array.isArray(item.path) ? item.path.map(level => ({
      id: String(level.id || ''), name: String(level.name || ''), level: Number(level.level || 0)
    })) : []
  };
}

function matcherCategory(item) {
  function names(attributes) {
    return (Array.isArray(attributes) ? attributes : [])
      .filter(row => row && (row.required || row.categoryDependent))
      .map(row => ({ name: row.name, required: row.required, categoryDependent: row.categoryDependent }));
  }
  return { key: item.key, descriptionCategoryId: item.descriptionCategoryId,
    typeId: item.typeId, path: item.path, pathText: item.pathText, disabled: item.disabled,
    required: names(item.required), optional: names(item.optional) };
}

async function writeJson(dir, name, value) {
  const body = JSON.stringify(value);
  await fs.promises.writeFile(path.join(dir, name), body, 'utf8');
  return { sha256: sha256(body), bytes: Buffer.byteLength(body) };
}

// Offline migration only. Never call on an HTTP request: a full legacy source
// is intentionally parsed once outside the running SaaS process.
async function buildPublicCategoryCatalog({ sourceFile, rootDir, activate = false }) {
  if (!sourceFile || !rootDir) throw new Error('请明确指定待审核的类目快照文件和公共类目输出目录。');
  const sourceBody = await fs.promises.readFile(sourceFile);
  const legacy = normalizeLibrary(JSON.parse(sourceBody.toString('utf8')));
  if (legacy.status !== 'done' || legacy.failures.length || !Object.keys(legacy.categories).length) {
    throw new Error('只能把已完成、没有失败类目的官方参考快照发布为公共类目。');
  }
  const sourceSha256 = sha256(sourceBody);
  const version = 'v1-' + sha256('public-category-v1:' + sourceSha256).slice(0, 24);
  const versions = path.join(rootDir, 'versions');
  const targetDir = path.join(versions, version);
  await fs.promises.mkdir(versions, { recursive: true });
  const stage = await fs.promises.mkdtemp(path.join(rootDir, '.build-'));
  try {
    await fs.promises.mkdir(path.join(stage, 'categories'));
    const shards = new Map(), matcherCategories = {}, catalogItems = [];
    for (const [fallbackKey, original] of Object.entries(legacy.categories)) {
      const item = publicCategory(original);
      const [keyDescriptionId, keyTypeId] = fallbackKey.split(':');
      const descriptionId = String(item.descriptionCategoryId || keyDescriptionId || '');
      const typeId = String(item.typeId || keyTypeId || '');
      if (!ID_RE.test(descriptionId) || !ID_RE.test(typeId) || !Array.isArray(item.path)) {
        throw new Error('待发布类目包含无效编号或类目路径，禁止生成不完整索引。');
      }
      const key = `${descriptionId}:${typeId}`;
      if (key !== fallbackKey) throw new Error('类目编号与来源键不一致，不能自动修正公开目录。');
      if (!shards.has(descriptionId)) shards.set(descriptionId, {});
      shards.get(descriptionId)[key] = item;
      matcherCategories[key] = matcherCategory(item);
      catalogItems.push(catalogItem(item));
    }
    const fileHashes = {};
    fileHashes['catalog.json'] = await writeJson(stage, 'catalog.json', {
      items: catalogItems, libraryUpdatedAt: legacy.updatedAt
    });
    fileHashes['matcher.json'] = await writeJson(stage, 'matcher.json', {
      updatedAt: legacy.updatedAt, categories: matcherCategories
    });
    const shardHashes = {};
    for (const [descriptionId, items] of shards) {
      const name = `categories/${descriptionId}.json`;
      shardHashes[descriptionId] = await writeJson(stage, name, items);
    }
    const manifest = {
      schemaVersion: 1, version, sourceSha256, builtAt: new Date().toISOString(),
      summary: summarizeLibrary(legacy), source: legacy.source, sourceLanguage: legacy.sourceLanguage,
      startedAt: legacy.startedAt, updatedAt: legacy.updatedAt, completedAt: legacy.completedAt,
      categoryCount: catalogItems.length, shardCount: shards.size,
      files: fileHashes, shards: shardHashes, failures: []
    };
    await writeJson(stage, 'manifest.json', manifest);
    try { await fs.promises.rename(stage, targetDir); }
    catch (error) {
      // Windows may report EPERM when the destination directory exists.
      // Treat it as a replay only after checking the already-published files.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      const existing = JSON.parse(await fs.promises.readFile(path.join(targetDir, 'manifest.json'), 'utf8'));
      if (existing.version !== version || existing.sourceSha256 !== sourceSha256) throw new Error('目标版本已存在但摘要不同，不能覆盖。');
      for (const [relative, check] of Object.entries({ ...existing.files,
        ...Object.fromEntries(Object.entries(existing.shards).map(([id, hash]) => [`categories/${id}.json`, hash])) })) {
        const body = await fs.promises.readFile(path.join(targetDir, relative));
        if (sha256(body) !== check.sha256 || body.length !== check.bytes) throw new Error('现有公共类目版本校验失败，不允许激活。');
      }
    }
    if (activate) {
      const tmp = path.join(rootDir, `active-${process.pid}-${crypto.randomUUID()}.tmp`);
      await fs.promises.writeFile(tmp, JSON.stringify({ version }), 'utf8');
      await fs.promises.rename(tmp, path.join(rootDir, 'active.json'));
    }
    return { ...manifest, activated: Boolean(activate) };
  } finally {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

function createPublicCategoryCatalog(rootDir) {
  let current = null, expireAt = 0, pending = null;
  let cachedCatalog = null, cachedMatcher = null;
  const cachedShards = new Map();

  async function active() {
    if (Date.now() < expireAt) return current;
    if (pending) return pending;
    pending = (async () => {
      let pointer;
      try { pointer = JSON.parse(await fs.promises.readFile(path.join(rootDir, 'active.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (!VERSION_RE.test(String(pointer.version || ''))) throw new Error('公共类目版本指针不正确，拒绝使用未验证文件。');
      if (current && current.version === pointer.version) return current;
      const versionDir = path.join(rootDir, 'versions', pointer.version);
      const manifest = JSON.parse(await fs.promises.readFile(path.join(versionDir, 'manifest.json'), 'utf8'));
      if (manifest.version !== pointer.version || manifest.schemaVersion !== 1 || !manifest.categoryCount || !manifest.shards) {
        throw new Error('公共类目清单无效，拒绝使用不完整文件。');
      }
      cachedCatalog = null; cachedMatcher = null; cachedShards.clear();
      return { version: pointer.version, versionDir, manifest };
    })();
    try { current = await pending; expireAt = Date.now() + 3000; return current; }
    finally { pending = null; }
  }

  async function checkedJson(info, name, expected) {
    const body = await fs.promises.readFile(path.join(info.versionDir, name));
    if (!expected || sha256(body) !== expected.sha256 || body.length !== expected.bytes) {
      throw new Error('公共类目文件校验失败，请恢复之前的有效版本。');
    }
    return JSON.parse(body.toString('utf8'));
  }

  async function summary() {
    const info = await active();
    return info ? { summary: info.manifest.summary, failures: info.manifest.failures || [], version: info.version } : null;
  }

  async function catalog() {
    const info = await active();
    if (!info) return null;
    if (cachedCatalog && cachedCatalog.version === info.version) return cachedCatalog.payload;
    const payload = await checkedJson(info, 'catalog.json', info.manifest.files?.['catalog.json']);
    if (payload.items.length !== info.manifest.categoryCount) throw new Error('公共类目条数校验失败。');
    cachedCatalog = { version: info.version, payload };
    return payload;
  }

  async function matcher() {
    const info = await active();
    if (!info) return null;
    if (cachedMatcher && cachedMatcher.version === info.version) return cachedMatcher.payload;
    const payload = await checkedJson(info, 'matcher.json', info.manifest.files?.['matcher.json']);
    if (Object.keys(payload.categories || {}).length !== info.manifest.categoryCount) throw new Error('公共匹配索引条数校验失败。');
    cachedMatcher = { version: info.version, payload };
    return payload;
  }

  async function category(descriptionId, typeId) {
    const info = await active();
    if (!info) return null;
    if (!ID_RE.test(String(descriptionId)) || !ID_RE.test(String(typeId))) return null;
    const expected = info.manifest.shards[String(descriptionId)];
    if (!expected) return { item: null, updatedAt: info.manifest.updatedAt };
    const key = info.version + ':' + descriptionId;
    let shard = cachedShards.get(key);
    if (!shard) {
      shard = await checkedJson(info, `categories/${descriptionId}.json`, expected);
      if (cachedShards.size >= 8) cachedShards.delete(cachedShards.keys().next().value);
      cachedShards.set(key, shard);
    }
    return { item: shard[`${descriptionId}:${typeId}`] || null, updatedAt: info.manifest.updatedAt };
  }
  return { active, summary, catalog, matcher, category };
}

module.exports = { buildPublicCategoryCatalog, createPublicCategoryCatalog };
