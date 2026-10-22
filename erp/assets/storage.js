/* 网研ERP — 数据存储桥
   用户登录后，从服务器载入该用户数据，读写均通过服务端 API。
   数据路径：服务端当前租户业务存储
   首次登录新电脑会自动从服务器拉取该用户数据。 */
(function (global) {
  'use strict';

  var KEYS = [
    'erp_shops_data',
    'erp_orders_data',
    'erp_accrual_types',
    'erp_accruals_data',
    'erp_acquiring_data',
    'erp_rate',
    'erp_fee_manual',
    'erp_amount_fix_v1',
    'erp_online_products',
    'erp_product_drafts',
    'erp_online_product_manual',
    'erp_collected_products',
    'erp_favorite_products',
    'erp_message_templates',
    'erp_message_blacklist',
    'erp_message_sendlog',
    'erp_promotion_rules',
    'erp_watermark_templates',
    'erp_shop_groups',
    'erp_bug_reports',
    'erp_online_categories',
    'erp_category_tree',
    'erp_dev_manual_backup',
    'erp_ai_analysis_rules'
  ];

  var USERNAME_STORAGE_KEY = 'erp_auth_username';
  var LEGACY_TOKEN_STORAGE_KEY = 'erp_auth_token';
  var csrfToken = '';

  var cache = {};
  var cacheVersions = {};
  // A failed server read must never be misrepresented as a legitimate empty tenant dataset.
  var loadFailures = {};
  var queues = {};
  var authPromise = null;
  var currentAccount = null;
  var exchangeRateStatus = null;
  var exchangeRateRefreshPromise = null;
  var exchangeRateRefreshTimer = null;
  var exchangeRateRefreshEnabled = false;
  var SYSTEM_TENANT_KEY = 'erp_system_tenant_id';
  var WORKSPACE_TABS_KEY = 'wyerp_workspace_tabs_v1';
  var BUSINESS_ROW_KEYS = ['erp_orders_data', 'erp_online_products', 'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1'];
  var storageChannel = null;
  var storageInstanceId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { if (typeof BroadcastChannel !== 'undefined') storageChannel = new BroadcastChannel('wyerp-storage-updates'); } catch (e) {}

  // Non-authoritative mirror of server-confirmed orders only. Never loaded as
  // an offline fallback, used for authorization, or uploaded back to the server.
  var ORDER_CACHE_DB = 'wyerp-order-cache';
  var ORDER_CACHE_STORE = 'snapshots';
  var ORDER_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;
  var orderCacheEpoch = 0;
  var orderCachePaused = false;
  var orderCacheWarned = false;

  function orderCacheScope() {
    if (!currentAccount || orderCachePaused) return null;
    var userId = String(currentAccount.userId || '');
    var tenantId = selectedTenantId() || String(currentAccount.tenantId || '');
    if (!/^\d+$/.test(userId) || !/^\d+$/.test(tenantId)) return null;
    return { key: userId + ':' + tenantId, userId: userId, tenantId: tenantId, epoch: orderCacheEpoch };
  }

  function sameOrderScope(scope) {
    var current = orderCacheScope();
    return Boolean(scope && current && scope.key === current.key && scope.epoch === current.epoch);
  }

  function withOrderCache(operation) {
    return new Promise(function (resolve) {
      var db = null, transaction = null, finished = false;
      var timeout = setTimeout(function () {
        if (transaction) try { transaction.abort(); } catch (e) {}
        finish(false);
      }, 2000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (db) db.close();
        if (!ok && !orderCacheWarned) {
          orderCacheWarned = true;
          console.warn('[storage] 浏览器订单缓存不可用；服务器保存不受影响。');
        }
        resolve(ok);
      }
      try {
        if (!global.indexedDB) { finish(false); return; }
        var opening = global.indexedDB.open(ORDER_CACHE_DB, 1);
        opening.onupgradeneeded = function () {
          if (finished) { opening.transaction.abort(); return; }
          if (!opening.result.objectStoreNames.contains(ORDER_CACHE_STORE)) {
            opening.result.createObjectStore(ORDER_CACHE_STORE, { keyPath: 'scope' });
          }
        };
        opening.onerror = opening.onblocked = function () { finish(false); };
        opening.onsuccess = function () {
          db = opening.result;
          if (finished) { db.close(); return; }
          db.onversionchange = function () { db.close(); };
          try {
            transaction = db.transaction(ORDER_CACHE_STORE, 'readwrite');
            transaction.oncomplete = function () { finish(true); };
            transaction.onerror = transaction.onabort = function () { finish(false); };
            operation(transaction.objectStore(ORDER_CACHE_STORE));
          } catch (e) {
            if (transaction) try { transaction.abort(); } catch (ignored) {}
            finish(false);
          }
        };
      } catch (e) { finish(false); }
    });
  }

  function pruneOrderCache(store, userId) {
    var kept = [];
    var cursorRequest = store.openCursor();
    cursorRequest.onsuccess = function () {
      var cursor = cursorRequest.result;
      if (!cursor) {
        kept.sort(function (a, b) { return b.cachedAt - a.cachedAt; });
        kept.slice(8).forEach(function (record) { store.delete(record.scope); });
        return;
      }
      var record = cursor.value;
      if (record.userId !== userId || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) cursor.delete();
      else kept.push({ scope: record.scope, cachedAt: record.cachedAt });
      cursor.continue();
    };
  }

  function clearOrderCache(scope) {
    return withOrderCache(function (store) {
      if (scope) store.delete(scope.key);
      else store.clear();
    });
  }

  function cacheConfirmedOrders(scope, payload, version) {
    if (!sameOrderScope(scope) || !Array.isArray(payload) || !Number.isInteger(version) || version < 0) return Promise.resolve(false);
    var snapshot;
    try { snapshot = JSON.parse(JSON.stringify(payload)); } catch (e) { return Promise.resolve(false); }
    return withOrderCache(function (store) {
      if (!sameOrderScope(scope)) return;
      if (Number.isInteger(cacheVersions.erp_orders_data) && cacheVersions.erp_orders_data > version) return;
      var now = Date.now();
      store.put({
        scope: scope.key, userId: scope.userId, tenantId: scope.tenantId,
        version: version, cachedAt: now, expiresAt: now + ORDER_CACHE_MAX_AGE,
        payload: snapshot
      });
      pruneOrderCache(store, scope.userId);
    });
  }

  function switchTenant(tenantId) {
    var previousScope = orderCacheScope();
    orderCacheEpoch += 1;
    orderCachePaused = true;
    return clearOrderCache(previousScope).then(function () {
      // Keep queued old-page server writes scoped to the old tenant until the
      // actual navigation; never switch their target during async cache cleanup.
      try {
        if (tenantId) sessionStorage.setItem(SYSTEM_TENANT_KEY, String(tenantId));
        else sessionStorage.removeItem(SYSTEM_TENANT_KEY);
      } catch (e) {}
      location.reload();
    });
  }

  function selectedTenantId() {
    if (!currentAccount || !currentAccount.isSystemAdmin) return '';
    try {
      var explicit = String(new URLSearchParams(location.search).get('tenantId') || '').trim();
      if (/^\d+$/.test(explicit)) return explicit;
      var value = sessionStorage.getItem(SYSTEM_TENANT_KEY) || '';
      return /^\d+$/.test(value) ? value : '';
    } catch (e) { return ''; }
  }

  function getUsername() {
    try { return localStorage.getItem(USERNAME_STORAGE_KEY) || ''; } catch (e) { return ''; }
  }
  function setIdentity(username, csrf) {
    csrfToken = csrf || '';
    try {
      localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
      localStorage.setItem(USERNAME_STORAGE_KEY, username || '');
    } catch (e) {}
  }
  function clearSessionScopedState() {
    // 会话级选择状态不得跨账号残留；服务器待确认的本地草稿属服务端存储，不在此清除。
    try { sessionStorage.removeItem(SYSTEM_TENANT_KEY); sessionStorage.removeItem(WORKSPACE_TABS_KEY); } catch (e) {}
  }
  function clearAuth() {
    csrfToken = '';
    currentAccount = null;
    authPromise = null;
    exchangeRateStatus = null;
    exchangeRateRefreshEnabled = false;
    if (exchangeRateRefreshTimer) clearInterval(exchangeRateRefreshTimer);
    exchangeRateRefreshTimer = null;
    orderCacheEpoch += 1;
    if (storageChannel) try { storageChannel.postMessage({ source: storageInstanceId, action: 'clear-order-cache' }); } catch (e) {}
    try { localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY); localStorage.removeItem(USERNAME_STORAGE_KEY); } catch (e) {}
    clearSessionScopedState();
    return clearOrderCache();
  }
  function loginReturnRoute() {
    var next = location.pathname + location.search + location.hash;
    try {
      if (window.top !== window && new URLSearchParams(location.search).get('workspace') === '1') {
        var child = new URL(location.href);
        child.searchParams.delete('workspace');
        var route = child.pathname + (child.search ? child.search : '') + (child.hash ? child.hash : '');
        return '/workspace.html?open=' + encodeURIComponent(route);
      }
    } catch (error) {}
    return next;
  }
  function replaceTopLevel(url) {
    if (window.top !== window) {
      try { window.top.location.replace(url); return; } catch (error) {}
    }
    location.replace(url);
  }
  function goToLogin() {
    var next = loginReturnRoute();
    cache = {};
    cacheVersions = {};
    loadFailures = {};
    clearAuth().then(function () { replaceTopLevel('/login.html?next=' + encodeURIComponent(next)); });
  }

  function apiUrl(key, includeSelectedTenant) {
    var url = '/api/data/' + encodeURIComponent(key);
    var selected = includeSelectedTenant ? selectedTenantId() : '';
    return selected ? url + '?tenantId=' + encodeURIComponent(selected) : url;
  }

  function auditEntityKey(key, entity) {
    if (!entity || typeof entity !== 'object') return '';
    if (key === 'erp_orders_data') return String(entity.posting || entity.posting_number || '');
    if (key === 'erp_shops_data') return String(entity.clientId || entity.externalShopId || entity.id || entity.name || '');
    if (key === 'erp_online_products') return String(entity.clientId || entity.shopId || entity.shop || '') + '::' + String(entity.id || entity.productId || entity.sku || entity.article || entity.offer_id || '');
    return '';
  }

  function mergeAuditPayload(key, payload) {
    if (!Array.isArray(cache[key]) || !Array.isArray(payload)) return;
    var serverById = {};
    payload.forEach(function (entity) { var id = auditEntityKey(key, entity); if (id) serverById[id] = entity; });
    cache[key].forEach(function (entity) {
      var server = serverById[auditEntityKey(key, entity)];
      if (!server) return;
      ['changeLog', 'lastOperator', 'lastOperatorIdentity', 'lastOperatorUserId', 'lastOperation', 'lastOperatedAt'].forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(server, field)) entity[field] = server[field];
        else delete entity[field];
      });
    });
  }

  function fetchWithAuth(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = Object.assign({}, options.headers || {});
    var method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && csrfToken) options.headers['X-CSRF-Token'] = csrfToken;
    return fetch(url, options);
  }

  function refreshTodayExchangeRate() {
    if (!exchangeRateRefreshEnabled) return Promise.resolve(null);
    if (exchangeRateRefreshPromise) return exchangeRateRefreshPromise;
    exchangeRateRefreshPromise = fetchWithAuth('/api/exchange-rates/cny-rub')
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.message || '本地数据同步失败，请稍后重试。');
          var rubPerCny = Number(data.rate);
          if (!(rubPerCny > 0) || !Number.isFinite(rubPerCny)) throw new Error('人民币卢布汇率暂时取不到，已按上次汇率继续计算，请稍后刷新重试。');
          return data;
        });
      })
      .catch(function () {
        var previousRubPerCny = Number(cache.erp_rate) > 0 ? 1 / Number(cache.erp_rate) : 0;
        if (previousRubPerCny > 0 && Number.isFinite(previousRubPerCny)) {
          return {
            rate: previousRubPerCny,
            source: 'browser_previous',
            fallback: true,
            stale: true,
            requestedDate: exchangeRateStatus && exchangeRateStatus.requestedDate || '',
            effectiveDate: exchangeRateStatus && exchangeRateStatus.effectiveDate || '',
            reason: 'exchange_rate_request_failed'
          };
        }
        return { rate: 12, source: 'fallback', fallback: true, stale: false, requestedDate: '', effectiveDate: '', reason: 'exchange_rate_request_failed' };
      })
      .then(function (data) {
        var previousRate = Number(cache.erp_rate);
        var previousDate = exchangeRateStatus && exchangeRateStatus.requestedDate;
        cache.erp_rate = 1 / Number(data.rate);
        exchangeRateStatus = data;
        if (previousRate !== cache.erp_rate || previousDate !== data.requestedDate) {
          try { document.dispatchEvent(new CustomEvent('erp-storage-audit-updated', { detail: { key: 'erp_rate', automatic: true } })); } catch (e) {}
        }
        exchangeRateRefreshPromise = null;
        return data;
      });
    return exchangeRateRefreshPromise;
  }

  function startExchangeRateRefresh() {
    if (exchangeRateRefreshTimer) return;
    exchangeRateRefreshTimer = setInterval(refreshTodayExchangeRate, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshTodayExchangeRate();
    });
  }

  function queueWrite(key, snapshot, options, retryVersion) {
    options = options || {};
    var confirmedScope = orderCacheScope();
    var writeEpoch = orderCacheEpoch;
    var writeTenant = selectedTenantId();
    var prev = queues[key] || Promise.resolve();
    var result = prev.then(function () {
      var expectedVersion = retryVersion !== undefined ? retryVersion : (Object.prototype.hasOwnProperty.call(cacheVersions, key) ? cacheVersions[key] : 0);
      return new Promise(function (resolve, reject) {
        var attempts = 0;
        function failure(error) {
          error.storageWrite = true;
          if (error.status === 401) { reject(error); goToLogin(); return; }
          if (error.status !== 409 && error.status !== 403 && attempts < 3) {
            setTimeout(attempt, attempts * 500);
            return;
          }
          var message = error.status === 409
            ? '数据版本冲突，未覆盖服务器。待保存快照仅保留在本页内存，刷新前请核对修改。'
            : '保存到服务器失败，当前修改尚未持久化，待保存快照仅保留在本页内存。';
          showStorageState('failed', message, function () {
            if (writeEpoch !== orderCacheEpoch || writeTenant !== selectedTenantId()) {
              showStorageState('failed', '账号或租户已改变，不能重试原空间的数据。', null, null, key);
              return;
            }
            // A retry is a new queued operation, never a continuation of a settled Promise.
            // Keep the original version: an old snapshot must not overwrite a newer save.
            queueWrite(key, snapshot, options, expectedVersion);
          }, '重试保存', key);
          reject(error);
        }
        function attempt() {
          if (writeEpoch !== orderCacheEpoch || writeTenant !== selectedTenantId()) {
            var scopeError = new Error('账号或租户已改变，保存已停止');
            scopeError.status = 403;
            failure(scopeError);
            return;
          }
          attempts += 1;
          showStorageState('saving', attempts > 1 ? '保存失败，正在自动重试…' : '正在保存…', null, null, key);
          var headers = { 'Content-Type': 'application/json', 'If-Match': String(expectedVersion) };
          if (options.source === 'sync') headers['X-ERP-Operation-Source'] = 'sync';
          var isBusinessRows = BUSINESS_ROW_KEYS.indexOf(key) >= 0;
          var commandUrl = '/api/domain/commands/business-rows';
          var selected = selectedTenantId();
          if (selected) commandUrl += '?tenantId=' + encodeURIComponent(selected);
          var requestBody = snapshot;
          if (isBusinessRows) requestBody = JSON.stringify({
            key: key,
            payload: JSON.parse(snapshot),
            expectedVersion: expectedVersion,
            source: options.source === 'sync' ? 'sync' : 'manual'
          });
          fetchWithAuth(isBusinessRows ? commandUrl : apiUrl(key, true), {
            method: 'POST',
            headers: headers,
            body: requestBody
          }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (data) {
              if (!res.ok) {
                var productMessage = data && typeof data.message === 'string' ? data.message.trim() : '';
                var safeProductMessage = productMessage.length <= 200 && /[\u3400-\u9fff]/.test(productMessage) && !/[A-Za-z_\\\/<>]/.test(productMessage.replace(/Ozon/g, ''));
                var error = new Error(key === 'erp_online_products'
                  ? (safeProductMessage ? productMessage : '在线商品保存失败或结果无法确认，请刷新列表核对后重试。')
                  : (productMessage.length <= 200 && /[\u3400-\u9fff]/.test(productMessage) ? productMessage : '数据保存失败，请稍后重试或刷新后核对结果。'));
                error.status = res.status;
                throw error;
              }
              if (Number.isFinite(Number(data.version))) cacheVersions[key] = Number(data.version);
              // Capture the confirmed response before render listeners mutate cache[key].
              var orderMirror = key === 'erp_orders_data'
                ? cacheConfirmedOrders(confirmedScope, data.payload, Number(data.version)) : null;
              if (Object.prototype.hasOwnProperty.call(data, 'payload')) {
                if (isBusinessRows || key === 'erp_collected_products' || key === 'erp_favorite_products' || key === 'erp_bug_reports' || key === 'erp_product_drafts') cache[key] = data.payload;
                else mergeAuditPayload(key, data.payload);
                try { document.dispatchEvent(new CustomEvent('erp-storage-audit-updated', { detail: { key: key } })); } catch (e) {}
              }
              if (storageChannel) {
                try { storageChannel.postMessage({ source: storageInstanceId, key: key, tenant: selectedTenantId() }); } catch (e) {}
              }
              showStorageState('saved', '已保存', null, null, key);
              if (orderMirror) orderMirror.then(function () { resolve(data); });
              else resolve(data);
            });
          }).catch(function (e) {
            console.warn('[storage] 写入服务器失败:', key, e && e.message);
            failure(e);
          });
        }
        attempt();
      });
    });
    // Keep the queue usable after failure. The caller still receives the rejection;
    // fire-and-forget legacy callers are covered by the visible failure state.
    queues[key] = result.catch(function () {});
    return result;
  }

  function showStorageState(state, message, action, actionLabel, storageKey) {
    var old = document.getElementById('erp-storage-state');
    // Do not let an unrelated successful write hide another key's failure.
    // A newer write for the same key does supersede the old failed snapshot,
    // so its stale retry button must disappear instead of conflicting forever.
    if (old && old.dataset && old.dataset.state === 'failed' && state !== 'failed' &&
      String(old.dataset.key || '') !== String(storageKey || '')) return;
    if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'erp-storage-state';
    el.dataset.state = state;
    if (storageKey) el.dataset.key = String(storageKey);
    var label = document.createElement('span');
    label.textContent = message;
    el.appendChild(label);
    if (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = actionLabel || '重试';
      button.onclick = function () { el.remove(); action(); };
      el.appendChild(button);
    }
    document.body.appendChild(el);
    if (state === 'saved') setTimeout(function () { if (el.parentNode) el.remove(); }, 1500);
  }

  function loadAll(keys, strict) {
    return Promise.all((keys || KEYS).map(function (key) {
      var confirmedScope = orderCacheScope();
      var confirmedVersion = null;
      return fetchWithAuth(apiUrl(key, true))
        .then(function (res) {
          if (res.status === 401) { goToLogin(); throw new Error('登录状态已失效，请重新登录后再试。'); }
          if (res.ok) {
            delete loadFailures[key];
            var version = Number(res.headers.get('X-Data-Version'));
            if (Number.isFinite(version)) confirmedVersion = version;
            return res.json();
          }
          loadFailures[key] = res.status === 403
            ? '当前账号没有读取此类业务数据的权限，请检查店铺范围与账号权限。'
            : (res.status === 404 ? '服务器尚未找到此类业务数据，请检查当前租户和数据库是否正确。'
              : '服务器业务数据读取失败，请检查数据库连接和服务状态后刷新页面。');
          if (strict) {
            var readFailure = new Error(loadFailures[key]);
            readFailure.status = res.status;
            throw readFailure;
          }
          if (res.status === 404) cacheVersions[key] = 0;
          return null;
        })
        .then(function (data) {
          if (strict && (data === null || data === undefined)) throw new Error('服务器未返回有效的数据');
          if (data !== null && data !== undefined) {
            cache[key] = data;
            if (confirmedVersion !== null) cacheVersions[key] = confirmedVersion;
          }
          if (key === 'erp_orders_data') {
            if (data !== null && data !== undefined) return cacheConfirmedOrders(confirmedScope, data, confirmedVersion);
            cache[key] = null;
            return confirmedScope ? clearOrderCache(confirmedScope) : null;
          }
        })
        .catch(function (error) {
          if (!loadFailures[key]) loadFailures[key] = '服务器业务数据读取失败，请检查数据库连接和服务状态后刷新页面。';
          if (strict) throw error;
          // PostgreSQL remains authoritative. Never substitute browser orders
          // for a failed/unauthorized server read or persist an unsaved edit.
          if (key === 'erp_orders_data') {
            cache[key] = null;
            return confirmedScope ? clearOrderCache(confirmedScope) : null;
          }
        });
    }));
  }

  if (storageChannel) {
    storageChannel.onmessage = function (event) {
      var message = event && event.data;
      var otherAccount = message && message.action === 'order-cache-account' && currentAccount && String(message.userId) !== String(currentAccount.userId);
      if (message && message.source !== storageInstanceId && (message.action === 'clear-order-cache' || otherAccount)) {
        orderCacheEpoch += 1;
        currentAccount = null;
        authPromise = null;
        csrfToken = '';
        cache.erp_orders_data = null;
        clearSessionScopedState();
        clearOrderCache();
        return;
      }
      if (!message || message.source === storageInstanceId || !message.key || message.tenant !== selectedTenantId()) return;
      if (!Object.prototype.hasOwnProperty.call(cache, message.key)) return;
      loadAll([message.key]).then(function () {
        try { document.dispatchEvent(new CustomEvent('erp-storage-audit-updated', { detail: { key: message.key, external: true } })); } catch (e) {}
      });
    };
  }

  function ensureAuth() {
    if (authPromise) return authPromise;
    authPromise = fetchWithAuth('/api/auth/me').then(function (res) {
      if (!res.ok) {
        var message = res.status === 401 || res.status === 403
          ? '登录状态已失效或未登录，请重新登录后再试。'
          : '暂时无法验证登录状态，服务器可能繁忙，请稍后重试。';
        var error = new Error(message);
        error.status = Number(res.status) || 401;
        throw error;
      }
      return res.json();
    }).then(function (data) {
      if (!data || !data.userId) throw new Error('登录状态读取失败，请刷新页面后重试。');
      currentAccount = data;
      setIdentity(data.username, data.csrfToken);
      if (storageChannel) try { storageChannel.postMessage({ source: storageInstanceId, action: 'order-cache-account', userId: String(data.userId) }); } catch (e) {}
      var scope = orderCacheScope();
      if (!scope) return data;
      return withOrderCache(function (store) { pruneOrderCache(store, scope.userId); }).then(function () { return data; });
    }).catch(function (error) {
      // 认证读取失败必须让调用方收到失败，不能留下永久 pending 的 authPromise；
      // 同时清空缓存 Promise，避免一次瞬时故障毒死后续所有 erpStorage.request()。
      authPromise = null;
      // Connection/PG pool errors are not authentication failures. During a
      // background sync a temporary 500/503 must not evict another page's
      // session or make the user's existing product list appear to vanish.
      if (error && (error.status === 401 || error.status === 403)) goToLogin();
      throw error;
    });
    return authPromise;
  }

  // ---- 退出按钮 ----
  var logoutBtn = null;
  var logoutPromise = null;
  var logoutDelegated = false;
  function bindLogoutDelegation() {
    if (logoutDelegated) return;
    logoutDelegated = true;
    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('#erp-logout-btn') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      logout().catch(function () {});
    }, true);
  }
  function ensureLogoutBtn() {
    if (window.self !== window.top) return;
    if (logoutBtn) return;
    logoutBtn = document.getElementById('erp-logout-btn');
    if (logoutBtn) return;
    logoutBtn = document.createElement('button');
    logoutBtn.id = 'erp-logout-btn';
    logoutBtn.type = 'button';
    logoutBtn.textContent = '退出';
    logoutBtn.title = '退出当前账号';
    logoutBtn.addEventListener('click', function () {
      logout().catch(function () {});
    });
    var headerRight = document.querySelector('.header-right');
    if (headerRight) { headerRight.appendChild(logoutBtn); } else { document.body.appendChild(logoutBtn); }
  }

  // ---- 公开 API ----

  function displayUsername(username, explicitSystemAdmin) {
    var name = String(username || '').trim();
    var isCurrentAccount = currentAccount && String(currentAccount.username || '') === name;
    var isSystemAdmin = explicitSystemAdmin === true || (explicitSystemAdmin == null && isCurrentAccount && currentAccount.isSystemAdmin === true);
    return isSystemAdmin ? '系统管理员' : name;
  }

  function getCurrentIdentity() {
    var api = global.WYERP_IDENTITY_DISPLAY;
    if (api && typeof api.displayIdentity === 'function') return api.displayIdentity(currentAccount || {});
    if (currentAccount && currentAccount.isSystemAdmin === true) return { kind: 'system_admin', raw: '系统管理员', masked: '系统管理员' };
    return { kind: 'unknown', raw: '', masked: '当前账号' };
  }

  function refreshHeaderUser() {
    var userEl = document.querySelector('.user-name');
    if (!userEl) return;
    var api = global.WYERP_IDENTITY_DISPLAY;
    var identity = api && typeof api.displayIdentity === 'function'
      ? api.displayIdentity(currentAccount || { username: getUsername() })
      : { masked: '当前账号', raw: '' };
    userEl.textContent = identity.masked || '当前账号';
    userEl.title = identity.raw || '当前登录账号';
  }

  function ensureSystemTenantSelector() {
    if (window.self !== window.top) return Promise.resolve();
    if (!currentAccount || !currentAccount.isSystemAdmin || document.getElementById('erp-system-tenant-select')) return Promise.resolve();
    return fetchWithAuth('/api/system/tenants').then(function (response) {
      return response.ok ? response.json() : { items: [] };
    }).then(function (data) {
      var items = Array.isArray(data.items) ? data.items : [];
      var selectedNow = selectedTenantId();
      if (selectedNow && !items.some(function (item) { return String(item.tenantId) === selectedNow; })) {
        var fallbackTenant = items.find(function (item) { return Number(item.shopCount) > 0; }) || items.find(function (item) { return String(item.tenantId) === String(currentAccount.tenantId); });
        return switchTenant(fallbackTenant ? fallbackTenant.tenantId : '');
      }
      if (!selectedTenantId()) {
        var own = items.find(function (item) { return String(item.tenantId) === String(currentAccount.tenantId); });
        var businessTenant = items.find(function (item) { return String(item.tenantId) !== String(currentAccount.tenantId) && Number(item.shopCount) > 0; });
        if (businessTenant && (!own || Number(own.shopCount) === 0)) {
          return switchTenant(businessTenant.tenantId);
        }
      }
      var select = document.createElement('select');
      select.id = 'erp-system-tenant-select';
      select.title = '系统管理员当前管理的租户';
      select.style.cssText = 'max-width:220px;height:32px;padding:0 28px 0 9px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#334155;font-size:12px';
      items.forEach(function (item) {
        var option = document.createElement('option');
        option.value = String(item.tenantId);
        option.textContent = (String(item.tenantId) === String(currentAccount.tenantId) ? '当前租户 · ' : '管理 · ') + (item.name || item.slug || ('租户 ' + item.tenantId)) + '（' + Number(item.shopCount || 0) + ' 店铺）';
        select.appendChild(option);
      });
      select.value = selectedTenantId() || String(currentAccount.tenantId);
      select.onchange = function () {
        switchTenant(this.value);
      };
      var host = document.querySelector('.header-right') || document.body;
      host.insertBefore(select, host.firstChild || null);
    }).catch(function () {});
  }

  function init(keys) {
    var requestedKeys = keys || KEYS;
    return ensureAuth().then(function () { return loadAll(keys); }).then(function () {
      if (requestedKeys.indexOf('erp_rate') < 0) return null;
      exchangeRateRefreshEnabled = true;
      startExchangeRateRefresh();
      return refreshTodayExchangeRate();
    }).then(function () {
      ensureLogoutBtn();
      refreshHeaderUser();
      if (global.WYERP_HEADER && global.WYERP_HEADER.init) global.WYERP_HEADER.init();
      if (global.WYERP_HEADER && global.WYERP_HEADER.refresh) global.WYERP_HEADER.refresh();
      return ensureSystemTenantSelector();
    });
  }

  function get(key) {
    return (key in cache) ? cache[key] : null;
  }

  function set(key, data, options) {
    cache[key] = data;
    return queueWrite(key, JSON.stringify(data), options);
  }

  function remove(key) {
    var confirmedScope = orderCacheScope();
    cache[key] = null;
    var prev = queues[key] || Promise.resolve();
    queues[key] = prev.then(function () {
      return fetchWithAuth(apiUrl(key, true), { method: 'DELETE' })
        .then(function (res) {
          if (res.ok && key === 'erp_orders_data' && confirmedScope) return clearOrderCache(confirmedScope).then(function () { return res; });
          return res;
        })
        .catch(function (e) { console.warn('[storage] 删除服务器数据失败:', key, e && e.message); });
    });
    return queues[key];
  }

  function logout() {
    if (logoutPromise) return logoutPromise;
    var button = document.getElementById('erp-logout-btn');
    if (button) { button.disabled = true; button.textContent = '退出中…'; }
    logoutPromise = fetchWithAuth('/api/auth/logout', { method: 'POST', keepalive: true }).then(function (res) {
      if (!res.ok) {
        var logoutFailure = new Error('退出登录失败，请刷新页面后重试；若仍然无法退出请提交 BUG 反馈。');
        logoutFailure.status = res.status;
        throw logoutFailure;
      }
      cache = {};
      cacheVersions = {};
      return clearAuth().then(function () { replaceTopLevel('/login.html'); });
    }).catch(function (error) {
      logoutPromise = null;
      if (button) { button.disabled = false; button.textContent = '退出'; }
      showStorageState('failed', '退出失败，请检查服务连接后重试。');
      throw error;
    });
    return logoutPromise;
  }

  function getCurrentUser() {
    return getUsername();
  }
  function getCurrentUserId() {
    return currentAccount ? String(currentAccount.userId || '') : '';
  }

  var OZON_COMMANDS_BY_LEGACY_ENDPOINT = {
    '/v4/product/info/limit': ['shops.getProductLimit', false], '/v1/roles': ['shops.getRoles', false],
    '/v2/warehouse/list': ['shops.listWarehouses', false], '/v2/delivery-method/list': ['shops.listDeliveryMethods', false],
    '/v1/description-category/tree': ['catalog.getTree', false], '/v1/description-category/attribute': ['catalog.getAttributes', false],
    '/v1/description-category/attribute/values': ['catalog.getAttributeValues', false], '/v3/product/list': ['products.list', false],
    '/v1/description-category/attribute/values/search': ['catalog.searchAttributeValues', false],
    '/v3/product/info/list': ['products.getInfo', false], '/v4/product/info/attributes': ['products.getAttributes', false],
    '/v5/product/info/prices': ['products.getPrices', false], '/v1/product/import/prices': ['products.updatePrices', true],
    '/v2/products/stocks': ['products.updateStocks', true], '/v1/product/archive': ['products.archive', true],
    '/v1/product/unarchive': ['products.unarchive', true],
    '/v1/product/info/description': ['products.getDescription', false], '/v3/posting/fbs/list': ['orders.listFbs', false],
    '/v3/posting/fbs/get': ['orders.getFbs', false],
    '/v1/finance/accrual/types': ['finance.listAccrualTypes', false], '/v1/finance/accrual/postings': ['finance.listAccrualPostings', false]
  };

  function ozonCommandForEndpoint(endpoint) {
    var definition = OZON_COMMANDS_BY_LEGACY_ENDPOINT[String(endpoint)];
    if (!definition) throw new Error('不支持的 Ozon 领域命令');
    return { name: definition[0], writes: definition[1] };
  }

  function createIdempotencyKey() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return 'ozon-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  function request(url, options) {
    return ensureAuth().then(function () {
      var confirmedScope = orderCacheScope();
      var clearOrders = false;
      if (String(url).split('?')[0] === '/api/system/clear-page-data' && options && String(options.method).toUpperCase() === 'POST') {
        try { clearOrders = JSON.parse(options.body).page === 'orders'; } catch (e) {}
      }
      var selected = selectedTenantId();
      var scopedEndpoint = String(url).indexOf('/api/tenant/') === 0 || String(url).indexOf('/api/sync-tasks') === 0 || String(url).indexOf('/api/bug-attachments') === 0 || String(url).indexOf('/api/bug-reports') === 0 || String(url).indexOf('/api/pricing-settings') === 0 || String(url).indexOf('/api/logistics-configs') === 0 || String(url).indexOf('/api/logistics-preferences') === 0 || String(url).indexOf('/api/logistics-plan-profiles') === 0 || String(url).indexOf('/api/category-attributes') === 0 || String(url).indexOf('/api/product-category-mappings') === 0 || String(url).indexOf('/api/system/clear-page-data') === 0 || String(url).indexOf('/api/integrations/ozon/commands') === 0 || String(url).indexOf('/api/domain/commands/') === 0 || String(url).indexOf('/api/domain/queries/') === 0 || String(url).indexOf('/api/shops/sync') === 0 || String(url).indexOf('/api/shops/test-connection') === 0 || String(url).indexOf('/api/products/sync') === 0 || String(url).indexOf('/api/orders/sync') === 0 || String(url).indexOf('/api/order-advertising') === 0 || String(url).indexOf('/api/shop-analysis/seerfar') === 0;
      if (selected && scopedEndpoint) {
        url += (String(url).indexOf('?') >= 0 ? '&' : '?') + 'tenantId=' + encodeURIComponent(selected);
      }
      return fetchWithAuth(url, options).then(function (response) {
        if (clearOrders && response.ok && confirmedScope) {
          orderCacheEpoch += 1;
          return clearOrderCache(confirmedScope).then(function () { return response; });
        }
        return response;
      });
    });
  }

  function acceptServerPayload(key, payload, version) {
    cache[key] = payload;
    if (Number.isFinite(Number(version))) cacheVersions[key] = Number(version);
    if (key === 'erp_orders_data') cacheConfirmedOrders(orderCacheScope(), payload, Number(version));
    try { document.dispatchEvent(new CustomEvent('erp-storage-audit-updated', { detail: { key: key } })); } catch (e) {}
    if (storageChannel) try { storageChannel.postMessage({ source: storageInstanceId, key: key, tenant: selectedTenantId() }); } catch (e) {}
    return payload;
  }

  function notifyServerChange(key) {
    // A domain command changed one entity. Other pages must re-read PostgreSQL;
    // do not attach a new collection version to a stale in-memory array.
    if (BUSINESS_ROW_KEYS.indexOf(key) < 0) return;
    if (storageChannel) storageChannel.postMessage({ source: storageInstanceId, key: key, tenant: selectedTenantId() });
  }

  function reload(keys) {
    return ensureAuth().then(function () { return loadAll(keys, true); }).then(function () {
      keys.forEach(function (key) {
        document.dispatchEvent(new CustomEvent('erp-storage-audit-updated', { detail: { key: key, external: true } }));
        if (storageChannel) storageChannel.postMessage({ source: storageInstanceId, key: key, tenant: selectedTenantId() });
      });
    });
  }

  global.erpStorage = {
    init: init,
    get: get,
    getLoadFailure: function (key) { return loadFailures[key] || ''; },
    set: set,
    remove: remove,
    logout: logout,
    clearSessionScopedState: clearSessionScopedState,
    getCurrentUser: getCurrentUser,
    getCurrentUserId: getCurrentUserId,
    getCurrentIdentity: getCurrentIdentity,
    displayUsername: displayUsername,
    getSelectedTenantId: selectedTenantId,
    ozonCommandForEndpoint: ozonCommandForEndpoint,
    createIdempotencyKey: createIdempotencyKey,
    acceptServerPayload: acceptServerPayload,
    getExchangeRateStatus: function () { return exchangeRateStatus && Object.assign({}, exchangeRateStatus); },
    refreshTodayExchangeRate: refreshTodayExchangeRate,
    notifyServerChange: notifyServerChange,
    reload: reload,
    request: request
  };
  bindLogoutDelegation();
})(window);
