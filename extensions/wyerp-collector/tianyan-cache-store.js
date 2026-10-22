'use strict';

(function() {
  const DB_NAME = 'wyerp-tianyan-cache';
  const DB_VERSION = 1;
  const STORE_NAME = 'snapshots';

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'cacheKey' });
          store.createIndex('by_shop_date', ['shopId', 'dateFrom'], { unique: false });
          store.createIndex('by_captured_at', 'capturedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('天眼缓存数据库打开失败。'));
    });
  }

  function cleanScalar(value) {
    if (value == null) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return String(value).slice(0, 500);
  }

  function cleanRows(rows) {
    return (Array.isArray(rows) ? rows.slice(0, 1500) : []).map(row => ({
      sku: String(row && row.sku || '').slice(0, 160),
      product: String(row && row.product || '').slice(0, 400),
      productId: String(row && row.productId || '').slice(0, 100),
      values: row && row.values && typeof row.values === 'object'
        ? Object.fromEntries(Object.entries(row.values).slice(0, 50).map(([key, value]) => [
            String(key).slice(0, 120),
            cleanScalar(value)
          ]))
        : {},
      raw: Array.isArray(row && row.raw)
        ? row.raw.slice(0, 50).map(cleanScalar)
        : []
    })).filter(row => row.sku || row.product);
  }

  async function saveYesterday(payload, resolvedShopId) {
    if (!payload || payload.schemaVersion !== 1 || payload.datePreset !== 'yesterday') {
      throw new Error('昨天缓存格式无效。');
    }
    const dateFrom = String(payload.dateFrom || '');
    const dateTo = String(payload.dateTo || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || dateFrom !== dateTo) {
      throw new Error('昨天缓存日期无效。');
    }
    const rows = cleanRows(payload.rows);
    if (!rows.length) throw new Error('昨天页面还没有可缓存的商品数据。');
    const headers = Array.isArray(payload.headers)
      ? payload.headers.slice(0, 40).map(value => String(value || '').slice(0, 120))
      : [];
    const shopId = /^[1-9]\d{2,19}$/.test(String(resolvedShopId || ''))
      ? String(resolvedShopId)
      : 'unknown';
    const capturedAt = String(payload.capturedAt || new Date().toISOString()).slice(0, 60);
    const cacheKey = [shopId, dateFrom, 'yesterday'].join('|');
    const record = {
      cacheKey,
      schemaVersion: 1,
      datePreset: 'yesterday',
      dateFrom,
      dateTo,
      shopId,
      sourceUrl: String(payload.sourceUrl || '').slice(0, 1200),
      capturedAt,
      headers,
      rows,
      rowCount: rows.length,
      totalCount: Number.isFinite(Number(payload.totalCount)) ? Number(payload.totalCount) : rows.length,
      pageCount: Number.isFinite(Number(payload.pageCount)) ? Number(payload.pageCount) : null
    };
    if (JSON.stringify(record).length > 3500000) {
      throw new Error('昨天缓存数据过大，已停止写入。');
    }

    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(record);
        if (shopId !== 'unknown') store.delete(['unknown', dateFrom, 'yesterday'].join('|'));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('天眼缓存写入失败。'));
        tx.onabort = () => reject(tx.error || new Error('天眼缓存写入被中止。'));
      });
    } finally {
      try { db.close(); } catch (_) {}
    }

    const status = {
      cacheKey, shopId, dateFrom, dateTo, rowCount: rows.length,
      totalCount: record.totalCount, pageCount: record.pageCount, capturedAt
    };
    try { await chrome.storage.local.set({ wyerp_tianyan_cache_status_v1: status }); } catch (_) {}
    return status;
  }

  async function readYesterday(shopId, dateFrom) {
    const key = [String(shopId || 'unknown'), String(dateFrom || ''), 'yesterday'].join('|');
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('天眼缓存读取失败。'));
      });
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  globalThis.WyTianyanCacheStore = Object.freeze({ saveYesterday, readYesterday });
})();
