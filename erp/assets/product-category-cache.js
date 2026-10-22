/* Rebuildable public category metadata only. Never pass product records or credentials here. */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_PRODUCT_CATEGORY_CACHE = api.create();
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var VERSION = 2, DB = 'wyerp-public-product-categories', STORE = 'entries', DAY = 86400000;
  function text(v) { return String(v == null ? '' : v).slice(0, 20000); }
  function list(v) { if (!Array.isArray(v)) throw new Error('公共类目缓存格式无效'); return v; }
  function id(v) { var s = String(v == null ? '' : v); if (!/^\d+$/.test(s)) throw new Error('公共类目编号无效'); return s; }
  function path(v) { return list(v || []).map(function (p) { return { id: text(p.id), name: text(p.name), level: Number(p.level) || 0 }; }); }
  function attribute(a) {
    var result = { id: id(a.id || a.attribute_id), name: text(a.name || a.attribute_name) };
    ['description','type','groupName','group_name','complexId','attribute_complex_id','groupId','group_id'].forEach(function (key) { if (a[key] != null) result[key] = text(a[key]); });
    ['dictionaryId','dictionary_id','maxValueCount','max_value_count'].forEach(function (key) { if (a[key] != null) result[key] = id(a[key]); });
    ['required','is_required','collection','is_collection','categoryDependent','category_dependent','is_aspect','aspect','complexCollection'].forEach(function (key) { if (a[key] != null) result[key] = Boolean(a[key]); });
    return result;
  }
  function sanitize(kind, data) {
    if (kind === 'colorOptions') return { items: list(data.items).map(function (v) {
      if (v.sourceLanguage !== 'RU' || !text(v.value).trim() || /[\u3400-\u9fff]/.test(text(v.value))) throw new Error('俄文颜色原值缺失');
      return { id: id(v.id), value: text(v.value), info: text(v.info), labelZh: text(v.labelZh), sourceLanguage: 'RU' };
    }), hasNext: false, cursor: 0 };
    if (kind === 'optionLabels') return { items: list(data.items).map(function (v) { return { id: id(v.id), value: text(v.value), labelZh: text(v.labelZh) }; }) };
    if (kind === 'options') return { items: list(data.items).map(function (v) {
      var value = text(v.value), labelZh = text(v.labelZh);
      if (v.sourceLanguage !== 'RU' || !value.trim() || /[\u3400-\u9fff]/.test(value)) throw new Error('俄文选项原值缺失');
      if (labelZh && (!/[\u3400-\u9fff]/.test(labelZh) || /[\u0400-\u04ff]/.test(labelZh))) throw new Error('中文选项标签无效');
      return { id: id(v.id), value: value, info: text(v.info), labelZh: labelZh, sourceLanguage: 'RU' };
    }), hasNext: data.hasNext === true, cursor: Number(data.cursor) || 0 };
    if (kind === 'catalog') return { libraryUpdatedAt: text(data.libraryUpdatedAt), items: list(data.items).map(function (c) { return { descriptionCategoryId: id(c.descriptionCategoryId), typeId: id(c.typeId), disabled: Boolean(c.disabled), path: path(c.path) }; }) };
    if (kind === 'definition') {
      if (!data.item) throw new Error('公共类目属性缺失');
      return { libraryUpdatedAt: text(data.libraryUpdatedAt), item: { requiredAttributes: list(data.item.requiredAttributes).map(attribute), optionalAttributes: list(data.item.optionalAttributes).map(attribute) } };
    }
    throw new Error('不允许缓存此类数据');
  }
  function create(config) {
    config = config || {};
    var indexedDB = config.indexedDB || root.indexedDB, crypto = config.crypto || root.crypto, now = config.now || Date.now;
    var pendingDb = null;
    function digest(value) {
      if (!crypto || !crypto.subtle) return Promise.reject(new Error('当前环境不支持安全缓存摘要'));
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)).then(function (bytes) { return Array.from(new Uint8Array(bytes)).map(function (v) { return v.toString(16).padStart(2, '0'); }).join(''); });
    }
    function open() {
      if (pendingDb) return pendingDb;
      pendingDb = new Promise(function (resolve, reject) {
        if (!indexedDB) return reject(new Error('当前环境不支持本地缓存'));
        var request = indexedDB.open(DB, VERSION), finished = false;
        var timer = setTimeout(function () { finished = true; reject(new Error('打开本地缓存超时')); }, 1500);
        request.onupgradeneeded = function () {
          var db = request.result;
          var store = db.objectStoreNames.contains(STORE) ? request.transaction.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'key' });
          if (!store.indexNames.contains('expiresAt')) store.createIndex('expiresAt', 'expiresAt');
        };
        request.onsuccess = function () { clearTimeout(timer); if (finished) return request.result.close(); var db = request.result; db.onversionchange = function () { db.close(); pendingDb = null; }; resolve(db); };
        request.onerror = function () { clearTimeout(timer); reject(request.error); };
      }).catch(function (error) { pendingDb = null; throw error; });
      return pendingDb;
    }
    function transaction(mode, action) {
      if (config.storage) return config.storage(mode, action);
      return open().then(function (db) { return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode), value, timer = setTimeout(function () { try { tx.abort(); } catch (_) {} reject(new Error('本地缓存访问超时')); }, 1500);
        var request = action(tx.objectStore(STORE));
        request.onsuccess = function () { value = request.result; };
        tx.oncomplete = function () { clearTimeout(timer); resolve(value); };
        tx.onerror = tx.onabort = function () { clearTimeout(timer); reject(tx.error || new Error('本地缓存写入失败')); };
      }); });
    }
    function keyFor(kind, key) { return digest(JSON.stringify([VERSION, kind, key])); }
    function get(kind, key) {
      return keyFor(kind, key).then(function (hash) { return transaction('readonly', function (store) { return store.get(hash); }); }).then(function (record) {
        if (!record || record.version !== VERSION || record.kind !== kind || !Number.isFinite(record.expiresAt) || !Number.isFinite(record.savedAt) || record.expiresAt <= now() || record.savedAt > now()) return null;
        return digest(JSON.stringify(record.data)).then(function (hash) { return hash === record.sha256 ? sanitize(kind, record.data) : null; });
      }).catch(function () { return null; });
    }
    function put(kind, key, data) {
      return Promise.resolve().then(function () { var clean = sanitize(kind, data); return Promise.all([keyFor(kind, key), digest(JSON.stringify(clean))]).then(function (hashes) {
        var time = now(), record = { key: hashes[0], kind: kind, version: VERSION, savedAt: time, expiresAt: time + (kind === 'catalog' ? DAY : 7 * DAY), sha256: hashes[1], data: clean };
        return transaction('readwrite', function (store) { return store.put(record); }).then(function () { return true; });
      }); }).catch(function () { return false; });
    }
    return { get: get, put: put };
  }
  return { create: create, sanitize: sanitize, database: DB };
});
