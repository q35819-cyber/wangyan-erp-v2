'use strict';

const {
  flattenThirdLevelCategories,
  splitAttributes,
  chineseFailureReason,
  normalizeLibrary,
  summarizeLibrary,
  mapLocalizedCategoryTrees
} = require('./category-attribute-library');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }

async function withRetry(request, endpoint, body, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 5);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await request(endpoint, body); }
    catch (error) {
      lastError = error;
      if (error && error.retryable === false) break;
      if (attempt >= attempts) break;
      const delay = Math.max(Number(error && error.retryAfterMs) || 0, Math.min(30000, 900 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 350));
      await sleep(delay);
    }
  }
  throw lastError || new Error('OZON 请求失败');
}

async function requestChineseFirst(request, endpoint, body, options) {
  try {
    return { data: await withRetry(request, endpoint, { ...body, language: 'ZH_HANS' }, options), language: 'ZH_HANS' };
  } catch (chineseError) {
    try { return { data: await withRetry(request, endpoint, { ...body, language: 'DEFAULT' }, options), language: 'DEFAULT' }; }
    catch (defaultError) { defaultError.chineseError = chineseError; throw defaultError; }
  }
}

async function syncCategoryAttributes(options) {
  const request = options && options.request;
  const persist = options && options.persist;
  const progress = options && options.progress || (async () => {});
  if (typeof request !== 'function' || typeof persist !== 'function') throw new Error('类目属性同步缺少请求或保存函数');
  const existing = normalizeLibrary(options.existing);
  const startedAt = new Date().toISOString();
  const treeResponse = await requestChineseFirst(request, '/v1/description-category/tree', {}, { attempts: 5 });
  const rawTree = treeResponse.data && treeResponse.data.result;
  if (!Array.isArray(rawTree)) throw new Error('OZON 没有返回有效的三级类目树');
  let russianTree = [];
  if (treeResponse.language === 'ZH_HANS') {
    try {
      const russianResponse = await withRetry(request, '/v1/description-category/tree', { language: 'DEFAULT' }, { attempts: 5 });
      if (Array.isArray(russianResponse && russianResponse.result)) russianTree = russianResponse.result;
    } catch (_) {}
  } else {
    russianTree = rawTree;
  }
  const catalog = flattenThirdLevelCategories(rawTree);
  if (!catalog.length) throw new Error('OZON 类目树中没有可采集的三级类目');
  const activeKeys = new Set(catalog.map(item => item.key));
  const categories = {};
  for (const [key, value] of Object.entries(existing.categories)) if (activeKeys.has(key)) categories[key] = value;
  const failures = new Map(existing.failures.filter(item => item && activeKeys.has(item.key)).map(item => [item.key, item]));
  const library = {
    schemaVersion: 1,
    status: 'running',
    source: 'OZON /v1/description-category/tree + /v1/description-category/attribute',
    sourceLanguage: treeResponse.language,
    startedAt,
    updatedAt: startedAt,
    completedAt: null,
    totalCategories: catalog.length,
    processedCategories: 0,
    categories,
    failures: Array.from(failures.values())
  };
  const treeDocument = mapLocalizedCategoryTrees(rawTree, russianTree);
  await persist(library, treeDocument);
  const force = options.force === true;
  const delayMs = Math.max(250, Number(options.delayMs) || 650);
  const batchSize = Math.max(1, Number(options.batchSize) || 10);
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency) || 1));
  let changedSinceSave = 0;

  async function collect(category) {
    try {
      const response = await requestChineseFirst(request, '/v1/description-category/attribute', {
        description_category_id: Number(category.descriptionCategoryId), type_id: Number(category.typeId)
      }, { attempts: 5 });
      const rawAttributes = response.data && (response.data.result || response.data.attributes);
      if (!Array.isArray(rawAttributes) || !rawAttributes.length) throw new Error('OZON 没有返回该类目的属性列表');
      const split = splitAttributes(rawAttributes);
      categories[category.key] = {
        key: category.key,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        disabled: category.disabled,
        path: category.path,
        pathText: category.path.map(item => item.name || item.id).join(' > '),
        sourceLanguage: response.language,
        required: split.required,
        optional: split.optional,
        fetchedAt: new Date().toISOString()
      };
      failures.delete(category.key);
    } catch (error) {
      failures.set(category.key, {
        key: category.key,
        descriptionCategoryId: category.descriptionCategoryId,
        typeId: category.typeId,
        path: category.path,
        pathText: category.path.map(item => item.name || item.id).join(' > '),
        reason: chineseFailureReason(error),
        failedAt: new Date().toISOString()
      });
    }
    return failures.has(category.key) ? '获取失败' : '获取成功';
  }

  for (let cursor = 0; cursor < catalog.length; cursor += concurrency) {
    const chunk = catalog.slice(cursor, cursor + concurrency);
    const stages = await Promise.all(chunk.map(async category => {
      const saved = categories[category.key];
      if (!force && saved && Array.isArray(saved.required) && Array.isArray(saved.optional) && saved.required.length + saved.optional.length > 0) {
        failures.delete(category.key);
        return '已存在，跳过重复采集';
      }
      return collect(category);
    }));
    for (let offset = 0; offset < chunk.length; offset += 1) {
      const category = chunk[offset];
      const stage = stages[offset];
      library.processedCategories = cursor + offset + 1;
      library.failures = Array.from(failures.values());
      library.updatedAt = new Date().toISOString();
      if (stage !== '已存在，跳过重复采集') changedSinceSave += 1;
      await progress(library, category, stage);
    }
    if (changedSinceSave >= batchSize || cursor + chunk.length >= catalog.length) {
      await persist(library, treeDocument);
      changedSinceSave = 0;
    }
    if (cursor + chunk.length < catalog.length && stages.some(stage => stage !== '已存在，跳过重复采集')) await sleep(delayMs);
  }

  library.failures = Array.from(failures.values());
  library.status = library.failures.length ? 'partial' : 'done';
  library.processedCategories = catalog.length;
  library.updatedAt = new Date().toISOString();
  library.completedAt = library.updatedAt;
  await persist(library, treeDocument);
  return { library, treeDocument, summary: summarizeLibrary(library) };
}

module.exports = { sleep, withRetry, requestChineseFirst, syncCategoryAttributes };
