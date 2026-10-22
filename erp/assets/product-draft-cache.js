(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.WYERP_PRODUCT_DRAFT_CACHE = factory(root.indexedDB);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (indexedDB) {
  'use strict';

  var DB_NAME = 'wyerp-product-drafts';
  var STORE_NAME = 'drafts';
  var MAX_AGE = 72 * 60 * 60 * 1000;
  var MAX_CREATE_PER_SCOPE = 300;
  var MAX_EDIT_PER_SCOPE = 30;

  function text(value) { return String(value == null ? '' : value).trim(); }
  function recordKey(scope, draftId) { return text(scope) + '|' + text(draftId); }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function valid(scope, draftId) { return Boolean(text(scope) && /^draft_[\w-]+$|^edit:[\w:.-]+$/.test(text(draftId))); }

  function run(mode, operation) {
    return new Promise(function (resolve) {
      if (!indexedDB) { resolve({ ok: false, value: null }); return; }
      var db = null, tx = null, done = false;
      var timeout = setTimeout(function () { if (tx) try { tx.abort(); } catch (_) {} finish(false, null); }, 2000);
      function finish(ok, value) {
        if (done) return;
        done = true; clearTimeout(timeout);
        if (db) db.close();
        resolve({ ok: ok, value: value == null ? null : value });
      }
      try {
        var opening = indexedDB.open(DB_NAME, 1);
        opening.onupgradeneeded = function () {
          if (!opening.result.objectStoreNames.contains(STORE_NAME)) opening.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        };
        opening.onerror = opening.onblocked = function () { finish(false, null); };
        opening.onsuccess = function () {
          db = opening.result;
          if (done) { db.close(); return; }
          db.onversionchange = function () { db.close(); };
          try {
            tx = db.transaction(STORE_NAME, mode);
            var result;
            tx.oncomplete = function () { finish(true, result); };
            tx.onerror = tx.onabort = function () { finish(false, null); };
            operation(tx.objectStore(STORE_NAME), function (value) { result = value; });
          } catch (_) { finish(false, null); }
        };
      } catch (_) { finish(false, null); }
    });
  }

  function draftKind(draftId) { return text(draftId).indexOf('edit:') === 0 ? 'edit' : 'create'; }

  function activeCreate(draft) {
    var phase = text(draft && draft.ozonCreate && draft.ozonCreate.phase);
    return ['queued', 'preparing', 'submitting', 'pending', 'verifying', 'unknown'].indexOf(phase) >= 0;
  }

  function browserProtected(draft) {
    if (!draft || typeof draft !== 'object') return false;
    if (activeCreate(draft)) return true;
    if (draft.draftRetention && draft.draftRetention.protected === true) return true;
    return Array.isArray(draft.combinationRelations) && draft.combinationRelations.length > 0;
  }

  function retentionBase(draft, fallback) {
    var parsed = Date.parse(draft && (draft.updatedAt || draft.savedAt) || '');
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function browserExpired(item, now) {
    if (!item || browserProtected(item.draft)) return false;
    var expiresAt = Number(item && item.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now;
  }

  function overflowKeys(items, scope) {
    return ['create', 'edit'].reduce(function (keys, kind) {
      var limit = kind === 'create' ? MAX_CREATE_PER_SCOPE : MAX_EDIT_PER_SCOPE;
      return keys.concat(items.filter(function (item) {
        return item && item.scope === scope && draftKind(item.draftId) === kind;
      }).sort(function (a, b) { return b.savedAt - a.savedAt; })
        .slice(limit)
        .map(function (item) { return item.key; }));
    }, []);
  }

  function prune(store, scope) {
    var kept = [], request = store.openCursor(), now = Date.now();
    request.onsuccess = function () {
      var cursor = request.result;
      if (!cursor) {
        overflowKeys(kept, scope).forEach(function (key) { store.delete(key); });
        return;
      }
      var item = cursor.value;
      if (!item || browserExpired(item, now)) cursor.delete();
      else kept.push({ key: item.key, scope: item.scope, draftId: item.draftId, savedAt: item.savedAt });
      cursor.continue();
    };
  }

  function put(scope, draftId, draft) {
    if (!valid(scope, draftId) || !draft || typeof draft !== 'object') return Promise.resolve(false);
    var copy;
    try { copy = clone(draft); } catch (_) { return Promise.resolve(false); }
    if (JSON.stringify(copy).length > 1500000) return Promise.resolve(false);
    return run('readwrite', function (store) {
      var now = Date.now(), basis = retentionBase(copy, now);
      store.put({ key: recordKey(scope, draftId), scope: text(scope), draftId: text(draftId), savedAt: now, expiresAt: basis + MAX_AGE, draft: copy });
      prune(store, text(scope));
    }).then(function (result) { return result.ok; });
  }

  function get(scope, draftId) {
    if (!valid(scope, draftId)) return Promise.resolve(null);
    return run('readwrite', function (store, setResult) {
      var request = store.get(recordKey(scope, draftId));
      request.onsuccess = function () {
        var item = request.result;
        if (!item || item.scope !== text(scope) || item.draftId !== text(draftId) || browserExpired(item, Date.now())) {
          if (item) store.delete(item.key);
          setResult(null); return;
        }
        try { setResult({ draft: clone(item.draft), savedAt: item.savedAt }); } catch (_) { setResult(null); }
      };
    }).then(function (result) { return result.ok ? result.value : null; });
  }

  function list(scope) {
    if (!text(scope)) return Promise.resolve([]);
    return run('readwrite', function (store, setResult) {
      var records = [], request = store.openCursor(), now = Date.now();
      request.onsuccess = function () {
        var cursor = request.result;
        if (!cursor) {
          setResult(records.sort(function (left, right) { return right.savedAt - left.savedAt; }));
          return;
        }
        var item = cursor.value;
        if (!item || browserExpired(item, now)) cursor.delete();
        else if (item.scope === text(scope)) {
          try { records.push({ draftId: item.draftId, savedAt: item.savedAt, draft: clone(item.draft) }); } catch (_) {}
        }
        cursor.continue();
      };
    }).then(function (result) { return result.ok && Array.isArray(result.value) ? result.value : []; });
  }

  function remove(scope, draftId) {
    if (!valid(scope, draftId)) return Promise.resolve(false);
    return run('readwrite', function (store) { store.delete(recordKey(scope, draftId)); }).then(function (result) { return result.ok; });
  }

  return {
    put: put, get: get, list: list, remove: remove, recordKey: recordKey, overflowKeys: overflowKeys,
    dbName: DB_NAME, storeName: STORE_NAME,
    maxCreatePerScope: MAX_CREATE_PER_SCOPE, maxEditPerScope: MAX_EDIT_PER_SCOPE, maxAgeMs: MAX_AGE,
    browserProtected: browserProtected, browserExpired: browserExpired, retentionBase: retentionBase
  };
});
