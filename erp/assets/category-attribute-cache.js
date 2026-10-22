/* 网研ERP — 类目属性库浏览器本地缓存（IndexedDB） */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_CATEGORY_ATTRIBUTE_CACHE = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var DB_NAME = 'wyerp-category-attributes';
  var STORE_NAME = 'libraries';

  function scope() {
    var username = root.erpStorage && root.erpStorage.getCurrentUser ? root.erpStorage.getCurrentUser() : 'anonymous';
    var tenant = root.erpStorage && root.erpStorage.getSelectedTenantId ? root.erpStorage.getSelectedTenantId() : '';
    return String(username || 'anonymous') + '@' + String(tenant || 'own');
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('当前浏览器不支持 IndexedDB'));
      var request = root.indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () { if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'scope' }); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('打开本地类目属性库失败')); };
    });
  }

  function transaction(mode, action) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, mode), store = tx.objectStore(STORE_NAME), request = action(store);
        request.onsuccess = function () { resolve(request.result || null); };
        request.onerror = function () { reject(request.error || new Error('本地类目属性库操作失败')); };
        tx.oncomplete = function () { db.close(); };
        tx.onabort = tx.onerror = function () { db.close(); };
      });
    });
  }

  function save(library) { return transaction('readwrite', function (store) { return store.put({ scope: scope(), savedAt: new Date().toISOString(), library: library }); }); }
  function load() { return transaction('readonly', function (store) { return store.get(scope()); }).then(function (record) { return record && record.library || null; }); }
  function remove() { return transaction('readwrite', function (store) { return store.delete(scope()); }); }

  return { save: save, load: load, remove: remove, scope: scope };
});
