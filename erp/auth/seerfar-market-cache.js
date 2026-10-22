'use strict';

const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const PRODUCT_NOT_FOUND_TTL_MS = 3 * DAY_MS;
const PRODUCT_RANGES = new Set([
  'past_7_days', 'past_14_days', 'past_30_days', 'past_60_days',
  'past_90_days', 'past_180_days', 'past_365_days'
]);

function codedError(code, message, status, originalMessage) {
  const error = new Error(message);
  error.publicCode = code;
  error.status = status;
  const original = String(originalMessage || '').trim();
  if (original) error.upstreamMessage = original.slice(0, 900);
  return error;
}

function useful(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && Object.keys(value).length > 0;
}

function inspectProductPayload(payload, sku) {
  if (!payload || Number(payload.code) !== 200 || !payload.data || typeof payload.data !== 'object') {
    return { valid: false, code: 'seerfar_product_not_found', message: 'Seerfar未收录该商品，暂时没有可用数据。', usefulCount: 0 };
  }
  const product = payload.data.product;
  if (!product || typeof product !== 'object') {
    return { valid: false, code: 'seerfar_product_not_found', message: 'Seerfar未收录该商品，暂时没有可用数据。', usefulCount: 0 };
  }
  const returnedSku = String(product.sku || '').trim();
  if (returnedSku !== sku) {
    return { valid: false, code: 'seerfar_sku_mismatch', message: 'Seerfar返回的商品与请求SKU不一致，数据已拒绝。', usefulCount: 0 };
  }
  const values = [
    product.sku, product.title, product.url, product.imageUrl, product.brand,
    product.seller, product.fulfillment, product.weight, product.upTime,
    product.upDays, product.price, product.reviews, product.categoryInfo,
    product.volume, product.dimension, product.sessionCount,
    product.sessionCountSearch, product.drr, product.convToCartSearch,
    product.discount, product.promoRevenueShare, product.convViewToOrder,
    product.convToCartPdp, product.returnCancellationRate,
    payload.data.totalSales, payload.data.totalRevenue,
    payload.data.stock, payload.data.salesTrendVOList
  ];
  const usefulCount = values.filter(useful).length;
  return usefulCount >= 10
    ? { valid: true, usefulCount }
    : { valid: false, code: 'seerfar_payload_sparse', message: 'Seerfar返回字段过少，未达到有效数据标准。', usefulCount };
}

function validateProductPayload(payload, sku) {
  return inspectProductPayload(payload, sku).valid;
}

function validateShopPayload(payload) {
  if (!payload || Number(payload.code) !== 200 || !payload.data || typeof payload.data !== 'object') return false;
  const products = payload.data.products || payload.data.list || payload.data.records;
  if (Array.isArray(products) && products.length) return true;
  return Object.values(payload.data).filter(useful).length >= 5;
}

function safePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

function createSeerfarMarketCache(options = {}) {
  const cacheDir = path.resolve(options.cacheDir || path.join(process.cwd(), 'data', 'cache', 'seerfar'));
  const fetcher = options.fetch || globalThis.fetch;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const wait = typeof options.wait === 'function' ? options.wait : ms => new Promise(resolve => setTimeout(resolve, ms));
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? Math.max(0, options.minIntervalMs) : 3100;
  const apiBaseUrl = String(options.apiBaseUrl || 'https://api.seerfar.cn').replace(/\/+$/, '');
  const inFlight = new Map();
  const recentFailures = new Map();
  const memoryCache = new Map();
  const memoryMaxEntries = Number.isFinite(options.memoryMaxEntries) ? Math.max(1, options.memoryMaxEntries) : 256;
  const memoryMaxBytes = Number.isFinite(options.memoryMaxBytes) ? Math.max(1024, options.memoryMaxBytes) : 32 * 1024 * 1024;
  let memoryBytes = 0;
  const metrics = { memoryHits: 0, diskHits: 0, cacheMisses: 0, upstreamCalls: 0, queuedTasks: 0, suppressedFailures: 0 };
  let queue = Promise.resolve();
  let lastRequestAt = 0;

  function remember(file, entry) {
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    const previous = memoryCache.get(file);
    if (previous) memoryBytes -= previous.bytes;
    memoryCache.delete(file);
    memoryCache.set(file, { entry, bytes });
    memoryBytes += bytes;
    while (memoryCache.size > memoryMaxEntries || memoryBytes > memoryMaxBytes) {
      const oldest = memoryCache.entries().next().value;
      if (!oldest) break;
      memoryBytes -= oldest[1].bytes;
      memoryCache.delete(oldest[0]);
    }
  }

  function readApiKey() {
    const direct = String(typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey || '').trim();
    if (direct) return direct;
    const file = String(options.apiKeyFile || '').trim();
    if (!file || !fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  }

  function cacheFile(entityType, entityId, variant) {
    return path.join(cacheDir, safePart(entityType) + '-' + safePart(entityId) + '-' + safePart(variant) + '.json');
  }

  function failureFile(file) {
    return file + '.failure.json';
  }

  async function persistProductNotFound(file, failure) {
    const target = failureFile(file);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temp = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    const entry = {
      schemaVersion: 1,
      code: 'seerfar_product_not_found',
      at: failure.at,
      retryAfterMs: PRODUCT_NOT_FOUND_TTL_MS,
      message: failure.message,
      status: failure.status
    };
    await fs.promises.writeFile(temp, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temp, target);
  }

  async function loadPersistedProductNotFound(file) {
    const target = failureFile(file);
    try {
      const entry = JSON.parse(await fs.promises.readFile(target, 'utf8'));
      const ageMs = now().getTime() - Number(entry.at);
      if (entry.schemaVersion !== 1 || entry.code !== 'seerfar_product_not_found' || !Number.isFinite(ageMs) || ageMs < 0 || ageMs >= PRODUCT_NOT_FOUND_TTL_MS) {
        await fs.promises.unlink(target).catch(() => undefined);
        return null;
      }
      return {
        at: Number(entry.at),
        retryAfterMs: PRODUCT_NOT_FOUND_TTL_MS,
        code: 'seerfar_product_not_found',
        message: String(entry.message || 'Seerfar未收录该商品，三天内不再重复查询。'),
        status: Number(entry.status) || 502
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async function readCache(file, validator) {
    try {
      const hot = memoryCache.get(file);
      if (hot) {
        memoryCache.delete(file);
        memoryCache.set(file, hot);
        const fetchedAt = Date.parse(hot.entry.fetchedAt || '');
        if (Number.isFinite(fetchedAt) && validator(hot.entry.payload)) { metrics.memoryHits += 1; return { entry: hot.entry, fetchedAt }; }
        memoryBytes -= hot.bytes;
        memoryCache.delete(file);
      }
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size < 20 || stat.size > 4 * 1024 * 1024) return null;
      const entry = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const fetchedAt = Date.parse(entry.fetchedAt || '');
      if (entry.schemaVersion !== 1 || entry.provider !== 'seerfar' || !Number.isFinite(fetchedAt) || !validator(entry.payload)) return null;
      remember(file, entry);
      metrics.diskHits += 1;
      return { entry, fetchedAt };
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) { metrics.cacheMisses += 1; return null; }
      throw error;
    }
  }

  async function writeCache(file, entry) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    await fs.promises.writeFile(temp, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temp, file);
    remember(file, entry);
  }

  function schedule(task) {
    const run = queue.then(async () => {
      const delay = Math.max(0, minIntervalMs - (Date.now() - lastRequestAt));
      if (delay) await wait(delay);
      lastRequestAt = Date.now();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  }

  async function upstream(endpoint, body) {
    const key = readApiKey();
    if (!key) throw codedError('seerfar_not_configured', 'Seerfar API Key未配置。', 503);
    if (key.length > 2048) throw codedError('seerfar_not_configured', 'Seerfar API Key格式无效。', 503);
    metrics.upstreamCalls += 1;
    return schedule(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetcher(apiBaseUrl + endpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        if (error && error.name === 'AbortError') throw codedError('seerfar_timeout', 'Seerfar接口20秒内未返回。', 504, error.message);
        throw codedError('seerfar_network_failed', 'Seerfar接口网络请求失败。', 502, error && error.message);
      } finally {
        clearTimeout(timer);
      }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw codedError('seerfar_response_too_large', 'Seerfar返回数据过大。', 502);
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; } catch (_) { /* normalized below */ }
      const message = String(payload.msg || payload.message || '');
      if (Number(payload.code) === 8000 || (response.status === 403 && /limit exhausted|credit|积分/i.test(message))) {
        throw codedError('seerfar_quota_exhausted', 'Seerfar积分不足，请充值后重试。', 402, message || raw);
      }
      if (response.status === 429) throw codedError('seerfar_rate_limited', 'Seerfar请求过于频繁，请稍后重试。', 429, message || raw || response.statusText);
      if (!response.ok) throw codedError('seerfar_upstream_failed', 'Seerfar数据源暂时不可用。', 502, message || raw || response.statusText);
      if (Number(payload.code) !== 200) throw codedError('seerfar_upstream_failed', 'Seerfar数据源暂时不可用。', 502, message || raw);
      return payload;
    });
  }

  function result(entry, status, ageMs, warning) {
    return {
      provider: 'seerfar',
      entityType: entry.entityType,
      entityId: entry.entityId,
      variant: entry.variant,
      fetchedAt: entry.fetchedAt,
      data: entry.payload.data,
      cache: { status, ageSeconds: Math.max(0, Math.floor(ageMs / 1000)), freshSeconds: 86400, hardExpirySeconds: 604800 },
      warnings: warning ? [warning] : []
    };
  }

  function queuedResult(spec) {
    const retryAfterSeconds = Math.max(2, Math.min(10, 2 + Math.floor(inFlight.size / 16)));
    return {
      provider: 'seerfar', entityType: spec.entityType, entityId: spec.entityId, variant: spec.variant,
      queued: true, retryAfterSeconds,
      cache: { status: 'queued', freshSeconds: 86400, hardExpirySeconds: 604800 }, warnings: []
    };
  }

  function refreshEntity(spec, file, cached) {
    if (inFlight.has(file)) return inFlight.get(file);
    metrics.queuedTasks += 1;
    const operation = (async () => {
      try {
        const payload = await upstream(spec.endpoint, spec.body);
        const inspection = typeof spec.inspect === 'function'
          ? spec.inspect(payload)
          : { valid: spec.validator(payload), code: 'seerfar_empty_result', message: 'Seerfar仅返回0项有效数据，未写入缓存。' };
        if (!inspection.valid) throw codedError(inspection.code, inspection.message, 502);
        const entry = {
          schemaVersion: 1,
          provider: 'seerfar',
          platform: 'ozon',
          entityType: spec.entityType,
          entityId: spec.entityId,
          variant: spec.variant,
          fetchedAt: now().toISOString(),
          payload
        };
        await writeCache(file, entry);
        recentFailures.delete(file);
        await fs.promises.unlink(failureFile(file)).catch(() => undefined);
        return result(entry, cached ? 'refreshed' : 'miss_filled', 0);
      } catch (error) {
        const failureCode = String(error.publicCode || 'seerfar_upstream_failed');
        const retryAfterMs = failureCode === 'seerfar_product_not_found' ? PRODUCT_NOT_FOUND_TTL_MS
          : ['seerfar_sku_mismatch', 'seerfar_payload_sparse', 'seerfar_empty_result'].includes(failureCode) ? 30 * 60 * 1000
          : failureCode === 'seerfar_rate_limited' ? 8000
          : ['seerfar_upstream_failed', 'seerfar_timeout', 'seerfar_network_failed'].includes(failureCode) ? 1000
            : 30000;
        const failure = {
          at: now().getTime(), retryAfterMs, code: failureCode,
          message: String(error.message || 'Seerfar数据源暂时不可用。'), status: Number(error.status) || 502
        };
        recentFailures.set(file, failure);
        if (failureCode === 'seerfar_product_not_found') await persistProductNotFound(file, failure);
        throw error;
      }
    })().finally(() => inFlight.delete(file));
    inFlight.set(file, operation);
    return operation;
  }

  async function throwRecentFailure(file, forceRefresh) {
    let failure = recentFailures.get(file);
    if (!failure) {
      failure = await loadPersistedProductNotFound(file);
      if (failure) recentFailures.set(file, failure);
    }
    if (!failure) return;
    if (now().getTime() - failure.at > Number(failure.retryAfterMs || 30000)) { recentFailures.delete(file); return; }
    if (forceRefresh && failure.code !== 'seerfar_product_not_found') return;
    metrics.suppressedFailures += 1;
    throw codedError(failure.code, failure.message, failure.status);
  }

  async function getEntity(spec, forceRefresh) {
    const file = cacheFile(spec.entityType, spec.entityId, spec.variant);
    const cached = await readCache(file, spec.validator);
    const currentMs = now().getTime();
    const ageMs = cached ? Math.max(0, currentMs - cached.fetchedAt) : Infinity;
    const refresh = () => refreshEntity(spec, file, cached);
    if (!forceRefresh && cached && ageMs <= DAY_MS) return result(cached.entry, 'fresh', ageMs);
    if (!forceRefresh && cached && ageMs <= 3 * DAY_MS) {
      refresh().catch(() => undefined);
      return result(cached.entry, 'stale_refreshing', ageMs, '缓存已超过24小时，服务器正在后台刷新。');
    }
    if (cached && ageMs <= 7 * DAY_MS) {
      try { return await refresh(); }
      catch (_) { return result(cached.entry, 'stale_fallback', ageMs, '实时刷新失败，已返回7天有效期内最后一份有效数据。'); }
    }
    await throwRecentFailure(file, forceRefresh);
    return refresh();
  }

  async function getEntityQueued(spec, forceRefresh) {
    const file = cacheFile(spec.entityType, spec.entityId, spec.variant);
    if (inFlight.has(file)) return queuedResult(spec);
    const cached = await readCache(file, spec.validator);
    const currentMs = now().getTime();
    const ageMs = cached ? Math.max(0, currentMs - cached.fetchedAt) : Infinity;
    if (!forceRefresh && cached && ageMs <= DAY_MS) return result(cached.entry, 'fresh', ageMs);
    if (cached && ageMs <= 7 * DAY_MS) {
      refreshEntity(spec, file, cached).catch(() => undefined);
      return result(cached.entry, 'stale_refreshing', ageMs, '缓存已超过24小时，服务器正在后台排队刷新。');
    }
    if (!inFlight.has(file)) {
      await throwRecentFailure(file, forceRefresh);
      if (inFlight.size >= 500) throw codedError('seerfar_queue_full', 'Seerfar服务器队列已满，请稍后重试。', 503);
      refreshEntity(spec, file, cached).catch(() => undefined);
    }
    return queuedResult(spec);
  }

  async function getProduct(input = {}) {
    const sku = String(input.sku || '').trim();
    const dateRange = String(input.dateRange || 'past_60_days').trim();
    if (!/^\d{4,24}$/.test(sku)) throw codedError('seerfar_invalid_sku', 'Ozon SKU格式无效。', 400);
    if (!PRODUCT_RANGES.has(dateRange)) throw codedError('seerfar_invalid_date_range', 'Seerfar日期范围无效。', 400);
    return getEntity({
      entityType: 'product', entityId: sku, variant: dateRange,
      endpoint: '/open-api/product/detail/search/ozon', body: { sku, dateRange },
      validator: payload => validateProductPayload(payload, sku),
      inspect: payload => inspectProductPayload(payload, sku)
    }, input.forceRefresh === true);
  }

  async function requestProduct(input = {}) {
    const sku = String(input.sku || '').trim();
    const dateRange = String(input.dateRange || 'past_60_days').trim();
    if (!/^\d{4,24}$/.test(sku)) throw codedError('seerfar_invalid_sku', 'Ozon SKU格式无效。', 400);
    if (!PRODUCT_RANGES.has(dateRange)) throw codedError('seerfar_invalid_date_range', 'Seerfar日期范围无效。', 400);
    return getEntityQueued({
      entityType: 'product', entityId: sku, variant: dateRange,
      endpoint: '/open-api/product/detail/search/ozon', body: { sku, dateRange },
      validator: payload => validateProductPayload(payload, sku),
      inspect: payload => inspectProductPayload(payload, sku)
    }, input.forceRefresh === true);
  }

  async function requestProducts(input = {}) {
    const rawItems = Array.isArray(input.items) ? input.items : [];
    if (!rawItems.length || rawItems.length > 8) throw codedError('seerfar_invalid_batch', 'Seerfar批量请求必须包含1到8个SKU。', 400);
    const seen = new Set();
    const uniqueItems = [];
    for (const raw of rawItems) {
      const sku = String(raw?.sku || '').trim();
      const dateRange = String(raw?.dateRange || 'past_60_days').trim();
      const identity = sku + '|' + dateRange;
      if (seen.has(identity)) continue;
      seen.add(identity);
      uniqueItems.push({ raw, sku, dateRange });
    }
    const items = await Promise.all(uniqueItems.map(async ({ raw, sku, dateRange }) => {
      try {
        const value = await requestProduct({ sku, dateRange, forceRefresh: raw?.forceRefresh === true });
        return value.queued
          ? { sku, dateRange, status: 'queued', retryAfterSeconds: value.retryAfterSeconds || 2 }
          : { sku, dateRange, status: 'ready', result: value };
      } catch (error) {
        return {
          sku, dateRange, status: 'failed',
          error: String(error.publicCode || 'seerfar_upstream_failed'),
          message: String(error.message || 'Seerfar数据源暂时不可用。').slice(0, 180)
        };
      }
    }));
    return {
      provider: 'seerfar', items, queued: items.some(item => item.status === 'queued'),
      retryAfterSeconds: Math.max(2, ...items.map(item => Number(item.retryAfterSeconds) || 0))
    };
  }

  async function getShop(input = {}) {
    const shopId = String(input.shopId || '').trim();
    const pageNumber = Number(input.pageNumber || 1);
    if (!/^\d{1,24}$/.test(shopId)) throw codedError('seerfar_invalid_shop', 'Ozon店铺ID格式无效。', 400);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) throw codedError('seerfar_invalid_page', '店铺页码无效。', 400);
    return getEntity({
      entityType: 'shop', entityId: shopId, variant: 'page-' + pageNumber,
      endpoint: '/open-api/shop/detail/search/ozon',
      body: {
        id: Number(shopId),
        reviewCount: { min: null, max: null }, drr: { min: null, max: null },
        reviewRating: { min: null, max: null }, questionsAndAnswers: { min: null, max: null },
        price: { min: null, max: null }, monthlyRevenue: { min: null, max: null },
        monthlySales: { min: null, max: null }, monthlySalesRate: { min: null, max: null },
        weight: { min: null, max: null }, volume: { min: null, max: null },
        grossMargin: { min: null, max: null }, variants: { min: null, max: null },
        convToCartPdp: { min: null, max: null }, returnCancellationRate: { min: null, max: null },
        creationDate: null, categoryIds: null, fulfillment: [], skus: [],
        brand: { type: 0, brandName: [] }, labels: [], keywords: [],
        filterRemoveProduct: true, tag: '',
        page: { pageNumber, pageSize: 100, orders: [{ field: 'revenue', direction: 'DESC' }] }
      },
      validator: validateShopPayload
    }, input.forceRefresh === true);
  }

  async function requestShop(input = {}) {
    const shopId = String(input.shopId || '').trim();
    const pageNumber = Number(input.pageNumber || 1);
    if (!/^\d{1,24}$/.test(shopId)) throw codedError('seerfar_invalid_shop', 'Ozon店铺ID格式无效。', 400);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) throw codedError('seerfar_invalid_page', '店铺页码无效。', 400);
    return getEntityQueued({
      entityType: 'shop', entityId: shopId, variant: 'page-' + pageNumber,
      endpoint: '/open-api/shop/detail/search/ozon',
      body: {
        id: Number(shopId),
        reviewCount: { min: null, max: null }, drr: { min: null, max: null },
        reviewRating: { min: null, max: null }, questionsAndAnswers: { min: null, max: null },
        price: { min: null, max: null }, monthlyRevenue: { min: null, max: null },
        monthlySales: { min: null, max: null }, monthlySalesRate: { min: null, max: null },
        weight: { min: null, max: null }, volume: { min: null, max: null },
        grossMargin: { min: null, max: null }, variants: { min: null, max: null },
        convToCartPdp: { min: null, max: null }, returnCancellationRate: { min: null, max: null },
        creationDate: null, categoryIds: null, fulfillment: [], skus: [],
        brand: { type: 0, brandName: [] }, labels: [], keywords: [],
        filterRemoveProduct: true, tag: '',
        page: { pageNumber, pageSize: 100, orders: [{ field: 'revenue', direction: 'DESC' }] }
      },
      validator: validateShopPayload
    }, input.forceRefresh === true);
  }

  function getState() {
    return {
      queue: { inFlight: inFlight.size, recentFailures: recentFailures.size },
      memory: { entries: memoryCache.size, bytes: memoryBytes, maxEntries: memoryMaxEntries, maxBytes: memoryMaxBytes },
      counters: { ...metrics }
    };
  }

  return { getProduct, requestProduct, requestProducts, getShop, requestShop, getState, cacheDir };
}

module.exports = { DAY_MS, PRODUCT_NOT_FOUND_TTL_MS, PRODUCT_RANGES, createSeerfarMarketCache, inspectProductPayload, validateProductPayload, validateShopPayload };
