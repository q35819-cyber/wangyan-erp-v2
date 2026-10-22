/* 网研ERP — 分析页当天浏览器缓存（天眼 / Seerfar） */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_SHOP_ANALYSIS_CACHE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var DB_NAME = 'wyerp-shop-analysis-cache';
  var STORE_NAME = 'snapshots';
  var DB_VERSION = 1;

  function today(now) {
    var d = now instanceof Date ? now : new Date(now || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function scopeKey(input) {
    input = input || {};
    var userId = text(input.userId || input.username);
    var tenantId = text(input.tenantId);
    if (!userId || !tenantId) return '';
    return userId + ':' + tenantId;
  }
  function recordKey(record) {
    return [
      text(record.scope),
      text(record.acquiredDate),
      text(record.source),
      text(record.shopId),
      text(record.rangeKey)
    ].join('|');
  }
  function openDb() {
    return new Promise(function (resolve) {
      if (!root || !root.indexedDB) { resolve(null); return; }
      var request;
      try { request = root.indexedDB.open(DB_NAME, DB_VERSION); } catch (_) { resolve(null); return; }
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      };
      request.onerror = request.onblocked = function () { resolve(null); };
      request.onsuccess = function () { resolve(request.result); };
    });
  }
  function withStore(mode, action, fallback) {
    return openDb().then(function (db) {
      if (!db) return fallback;
      return new Promise(function (resolve) {
        var tx, store, result = fallback;
        try {
          tx = db.transaction(STORE_NAME, mode);
          store = tx.objectStore(STORE_NAME);
          action(store, function (value) { result = value; });
        } catch (_) {
          db.close();
          resolve(fallback);
          return;
        }
        tx.oncomplete = function () { db.close(); resolve(result); };
        tx.onerror = tx.onabort = function () { db.close(); resolve(fallback); };
      });
    });
  }
  function put(input) {
    input = input || {};
    var record = {
      schemaVersion: 1,
      scope: text(input.scope),
      acquiredDate: text(input.acquiredDate || today()),
      source: text(input.source),
      shopId: text(input.shopId),
      rangeKey: text(input.rangeKey),
      fetchedAt: text(input.fetchedAt || new Date().toISOString()),
      payload: input.payload == null ? null : input.payload
    };
    if (!record.scope || !record.source || !record.shopId || !record.rangeKey || !record.acquiredDate) return Promise.resolve(false);
    record.key = recordKey(record);
    return withStore('readwrite', function (store, setResult) { store.put(record); setResult(true); }, false);
  }
  function listDay(scope, acquiredDate) {
    scope = text(scope);
    acquiredDate = text(acquiredDate || today());
    if (!scope) return Promise.resolve([]);
    return withStore('readonly', function (store, setResult) {
      var request = store.getAll();
      request.onsuccess = function () {
        var rows = Array.isArray(request.result) ? request.result : [];
        setResult(rows.filter(function (row) {
          return row && row.schemaVersion === 1 && row.scope === scope && row.acquiredDate === acquiredDate;
        }));
      };
      request.onerror = function () { setResult([]); };
    }, []);
  }
  return {
    DB_NAME: DB_NAME,
    STORE_NAME: STORE_NAME,
    today: today,
    scopeKey: scopeKey,
    recordKey: recordKey,
    put: put,
    listDay: listDay
  };
});
