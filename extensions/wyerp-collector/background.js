'use strict';
importScripts('shared.js', 'tianyan-cache-store.js');

// Only the verified seller Client ID and bind time use chrome.storage.session so
// an MV3 service-worker suspension does not silently lose a short verified binding.
// Raw Cookie values, names, hashes and product data are never stored there.
const running = new Set();
// Reuse the already-installed ERP bridge while the same document stays loaded.
// The set is process-local on purpose: a service-worker restart forgets it and
// safely causes one fresh injection. Navigation/removal invalidates it below.
const erpCollectionBridgeReadyTabs = new Set();
const sidebarUrl = chrome.runtime.getURL('sidebar.html');
const sidebarSnapshots = new Map();
const sidebarPorts = new Map();
const sidebarPrepared = new Set();
const sellerBindings = new Map();
const sellerAnalyticsCache = new Map();
const sellerAnalyticsLastRequest = new Map();
const sellerBindingSessionKey = 'wyerp_seller_binding_v1';
const erpShopListTimeoutMs = 30000;
// chrome.tabs.query URL filters use extension match-pattern syntax, which does
// not accept an explicit port. Query the loopback hosts, then enforce the exact
// ERP origin before a tab is ever used as an authenticated bridge.
const erpTabPatterns = ['http://127.0.0.1/*', 'http://localhost/*'];
const SELLER_HOSTS = new Set(['seller.ozonru.cn', 'seller.ozon.ru']);
const SELLER_TAB_PATTERNS = ['https://seller.ozonru.cn/*', 'https://seller.ozon.ru/*'];
const PRIMARY_SELLER_ORIGIN = 'https://seller.ozon.ru';
const SELLER_ORIGINS = Object.freeze(['https://seller.ozon.ru', 'https://seller.ozonru.cn']);
function isAllowedSellerPage(page) { return Boolean(page && page.protocol === 'https:' && SELLER_HOSTS.has(page.hostname)); }
async function sellerOriginCandidates() {
  const origins = [];
  try {
    const tabs = (await chrome.tabs.query({ url: SELLER_TAB_PATTERNS }))
      .filter(tab => Number.isInteger(tab.id) && !tab.discarded)
      .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
    for (const tab of tabs) {
      try {
        const page = new URL(String(tab.url || ''));
        if (isAllowedSellerPage(page) && !origins.includes(page.origin)) origins.push(page.origin);
      } catch (_) { /* ignore malformed tab URL */ }
    }
  } catch (_) { /* fall through to both supported origins */ }
  for (const origin of SELLER_ORIGINS) if (!origins.includes(origin)) origins.push(origin);
  return origins;
}
async function acquireSellerPage(pathAndQuery, message, clientId = '') {
  const tried = [];
  let lastError = null;
  const targetClientId = String(clientId || '').trim();
  for (const origin of await sellerOriginCandidates()) {
    let tab = null;
    tried.push(origin);
    try {
      tab = await chrome.tabs.create({ url: origin + pathAndQuery, active: false });
      const loaded = await waitForTab(tab.id, { code: 'seller_page_unavailable', message });
      const page = (() => { try { return new URL(String(loaded?.url || '')); } catch (_) { return null; } })();
      if (!isAllowedSellerPage(page)) {
        lastError = Object.assign(new Error('Seller会话在该域名未登录'), { code: 'seller_session_host_unavailable' });
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
        continue;
      }
      if (/^[1-9]\d{2,19}$/.test(targetClientId) && !(await verifySellerCookieSession(loaded, targetClientId, 3000).catch(() => false))) {
        lastError = Object.assign(new Error('当前Seller域名未登录目标店铺'), { code: 'seller_target_shop_unavailable' });
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
        continue;
      }
      return { tab: loaded, temporary: true, origin: page.origin, tried };
    } catch (error) {
      lastError = error;
      if (tab && Number.isInteger(tab.id)) { try { await chrome.tabs.remove(tab.id); } catch (_) {} }
    }
  }
  const error = Object.assign(new Error(message + ' 已尝试俄罗斯域名和中国域名，均未找到目标店铺登录会话。'), { code: lastError?.code || 'seller_page_unavailable', triedOrigins: tried });
  throw error;
}
function moscowDateText(offsetDays = 0, nowValue = new Date()) {
  const date = nowValue instanceof Date ? nowValue : new Date(nowValue);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
  const calendar = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
  calendar.setUTCDate(calendar.getUTCDate() + Number(offsetDays || 0));
  return calendar.toISOString().slice(0, 10);
}
function isAllowedErpTab(tab) {
  try { return ['http://127.0.0.1:8765', 'http://localhost:8765'].includes(new URL(String(tab?.url || '')).origin); }
  catch (_) { return false; }
}
const defaultCollectionUrl = 'http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fgoods.html';
const toolPages = Object.freeze({
  seller: PRIMARY_SELLER_ORIGIN + '/app/dashboard/main',
  binding: PRIMARY_SELLER_ORIGIN + '/app/dashboard/main',
  listing: 'http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fgoods.html',
  profit: 'http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fprofit.html',
  pricing: 'http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fpricing.html',
  selection: 'http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fsource-pick.html',
  erp: 'http://127.0.0.1:8765/workspace.html'
});
const cleanError = message => ({ type: 'capture-error', message });
const ozonPublicCachePrefix = 'wyerp_ozon_public_cache_v1_';
const ozonPublicCacheIndexKey = 'wyerp_ozon_public_cache_index_v1';
const ozonPublicCacheFreshMs = 24 * 60 * 60 * 1000;
const ozonPublicCacheExpiryMs = 7 * 24 * 60 * 60 * 1000;
async function currentSellerBinding() {
  for (const [id, binding] of sellerBindings) if (Date.now() - binding.at > 480000) sellerBindings.delete(id);
  const hot = sellerBindings.values().next().value;
  if (hot) return hot;
  try {
    const stored = (await chrome.storage.session.get(sellerBindingSessionKey))?.[sellerBindingSessionKey];
    const storeId = String(stored?.storeId || ''); const at = Number(stored?.at);
    if (!/^[1-9]\d{2,19}$/.test(storeId) || !Number.isFinite(at) || Date.now() - at > 480000 || at > Date.now() + 60000) {
      await chrome.storage.session.remove(sellerBindingSessionKey); return null;
    }
    const binding = { storeId, at };
    sellerBindings.set(storeId, binding);
    return binding;
  } catch (_) { return null; }
}
function validRecord(record, tab) {
  const source = WyCapture.sourceUrl(tab?.url);
  return Number.isInteger(tab?.id) && source && record?.schemaVersion === 1 && record?.adapterVersion === WyCapture.VERSION &&
    record.source?.productId === source.productId && record.source?.platform === source.platform &&
    WyCapture.sourceUrl(record.source.url)?.url === source.url && JSON.stringify(record).length <= 1500000;
}
async function prepareResult(record, tab, options = {}) {
  if (!validRecord(record, tab)) return cleanError('采集结果与当前商品页不一致，请刷新商品页后重试。');
  if (record.source.platform === 'ozon') {
    const binding = await currentSellerBinding();
    record.storeBinding = binding ? { status: 'candidate', storeId: binding.storeId, boundAt: new Date(binding.at).toISOString(), method: 'seller_cookie_session_storage', trust: 'browser_candidate_server_verification_required' } : { status: 'unbound' };
    record = await enrichFromErp(record, tab, options);
  }
  const message = { type: 'capture-result', record, sourceTabId: tab.id };
  if (record.source.platform === 'ozon') {
    for (const [id, saved] of sidebarSnapshots) if (Date.now() - saved.at > 300000) sidebarSnapshots.delete(id);
    if (sidebarSnapshots.size >= 10 && !sidebarSnapshots.has(tab.id)) sidebarSnapshots.delete(sidebarSnapshots.keys().next().value);
    sidebarSnapshots.set(tab.id, { at: Date.now(), message });
    try { sidebarPorts.get(tab.id)?.postMessage(message); } catch (_) { sidebarPorts.delete(tab.id); }
    if (!sidebarPrepared.has(tab.id)) {
      try { await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidebar.html?tab=' + tab.id, enabled: true }); sidebarPrepared.add(tab.id); }
      catch (_) { message.sidebarUnavailable = true; }
    }
  }
  return message;
}
async function enrichFromErp(record, returnTab, options = {}) {
  let lease;
  try {
    lease = await acquireReadableErpTab(returnTab);
    const target = lease.tab;
    const serverInput = {
      schemaVersion: record.schemaVersion, adapterVersion: record.adapterVersion,
      source: record.source, storeBinding: record.storeBinding, analytics: record.analytics
    };
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['shared.js', 'analytics.js', 'erp-bridge.js'], world: 'ISOLATED' });
    let timer;
    const outputs = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'MAIN', args: [record.source.productId, options.forceRefresh === true, options.queue === true], func: async (sku, forceRefresh, queue) => {
        const origin = String(location.origin || '');
        if (!['http://127.0.0.1:8765', 'http://localhost:8765'].includes(origin)) return { ok: false, message: 'ERP页面地址无效。' };
        let selectedTenantId = '';
        try {
          const candidate = String(sessionStorage.getItem('erp_system_tenant_id') || '').trim();
          if (/^[1-9]\d{0,19}$/.test(candidate)) selectedTenantId = candidate;
        } catch (_) { /* tenant not selected */ }
        try {
          const authResponse = await fetch(origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          if (authResponse.status === 401) return { ok: false, code: 'erp_login_required', message: '请先登录ERP' };
          if (!authResponse.ok) return { ok: false, message: '无法确认ERP登录状态。' };
          const account = await authResponse.json().catch(() => ({}));
          const csrfToken = String(account?.csrfToken || '').trim();
          if (!csrfToken) return { ok: false, message: 'ERP没有返回读取凭据，请重新登录。' };
          const query = account?.isSystemAdmin && selectedTenantId ? '?tenantId=' + encodeURIComponent(selectedTenantId) : '';
          const response = await fetch(origin + '/api/integrations/seerfar/ozon/product' + query, {
            method: 'POST', credentials: 'same-origin',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ sku: String(sku || ''), dateRange: 'past_60_days', forceRefresh: forceRefresh === true, queue })
          });
          const payload = await response.json().catch(() => ({}));
          if (response.status === 202 && payload?.queued) return { ok: true, pending: true, retryAfterSeconds: Number(payload.retryAfterSeconds) || 2 };
          if (!response.ok) return { ok: false, code: String(payload?.error || ''), message: String(payload?.message || 'Seerfar数据读取失败。').slice(0, 180) };
          return { ok: true, payload };
        } catch (_) { return { ok: false, message: 'ERP页面数据请求失败。' }; }
      } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ERP读取Seerfar数据超过40秒。')), 40000); })
    ]).finally(() => clearTimeout(timer));
    const result = outputs?.[0]?.result;
    if (result?.pending) {
      record.analytics = record.analytics || { status: 'unavailable', metrics: [], sources: [], warnings: [] };
      record.analytics.pending = { retryAfterSeconds: result.retryAfterSeconds };
      return record;
    }
    if (result?.ok && result.payload) {
      const mapped = await chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'ISOLATED', args: [serverInput, result.payload], func: (capture, payload) => globalThis.WyErpCollectorBridge.applySeerfar(capture, payload, new Date()) });
      const enriched = mapped?.[0]?.result;
      if (validRecord(enriched, { id: target.id, url: record.source.url })) {
        record.analytics = enriched.analytics; return record;
      }
    }
    throw new Error(result?.message || 'ERP没有返回Seerfar数据。');
  } catch (error) {
    record.analytics = record.analytics || { status: 'unavailable', metrics: [], warnings: [] };
    record.analytics.warnings = Array.isArray(record.analytics.warnings) ? record.analytics.warnings : [];
    record.analytics.warnings.push('Seerfar数据未补充：' + WyCapture.cleanText(error?.message || '读取失败。', 160));
    return record;
  } finally {
    if (lease) await releaseErpTab(lease);
  }
}
async function enrichListingBatchFromErp(items, returnTab) {
  let lease;
  try {
    lease = await acquireReadableErpTab(returnTab);
    const target = lease.tab;
    await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['shared.js', 'analytics.js', 'erp-bridge.js'], world: 'ISOLATED' });
    let timer;
    const outputs = await Promise.race([
      chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'MAIN', args: [items.map(item => ({ sku: item.sku, dateRange: 'past_60_days' }))], func: async batchItems => {
        const origin = String(location.origin || '');
        if (!['http://127.0.0.1:8765', 'http://localhost:8765'].includes(origin)) return { ok: false, message: 'ERP页面地址无效。' };
        let selectedTenantId = '';
        try {
          const candidate = String(sessionStorage.getItem('erp_system_tenant_id') || '').trim();
          if (/^[1-9]\d{0,19}$/.test(candidate)) selectedTenantId = candidate;
        } catch (_) { /* tenant not selected */ }
        try {
          const authResponse = await fetch(origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
          if (authResponse.status === 401) return { ok: false, code: 'erp_login_required', message: '请先登录ERP' };
          if (!authResponse.ok) return { ok: false, message: '无法确认ERP登录状态。' };
          const account = await authResponse.json().catch(() => ({}));
          const csrfToken = String(account?.csrfToken || '').trim();
          if (!csrfToken) return { ok: false, message: 'ERP没有返回读取凭据，请重新登录。' };
          const query = account?.isSystemAdmin && selectedTenantId ? '?tenantId=' + encodeURIComponent(selectedTenantId) : '';
          const response = await fetch(origin + '/api/integrations/seerfar/ozon/products' + query, {
            method: 'POST', credentials: 'same-origin',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ items: batchItems })
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok && response.status !== 202) return { ok: false, message: String(payload?.message || 'Seerfar批量数据读取失败。').slice(0, 180) };
          return { ok: true, payload };
        } catch (_) { return { ok: false, message: 'ERP页面数据请求失败。' }; }
      } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ERP批量读取Seerfar状态超过12秒。')), 12000); })
    ]).finally(() => clearTimeout(timer));
    const response = outputs?.[0]?.result;
    if (!response?.ok) throw new Error(response?.message || 'ERP没有返回Seerfar批量状态。');
    const payloadItems = Array.isArray(response.payload?.items) ? response.payload.items : [];
    const sourceBySku = new Map(items.map(item => [item.sku, item]));
    const mappingInputs = payloadItems.filter(item => item.status === 'ready' && item.result).map(item => ({
      sku: String(item.sku), payload: item.result,
      record: {
        schemaVersion: 1, adapterVersion: WyCapture.VERSION,
        source: { platform: 'ozon', productId: String(item.sku), url: sourceBySku.get(String(item.sku))?.productUrl || '' },
        analytics: { status: 'unavailable', metrics: [], sources: [], warnings: [] }
      }
    }));
    const mappedBySku = new Map();
    if (mappingInputs.length) {
      const mapped = await chrome.scripting.executeScript({
        target: { tabId: target.id }, world: 'ISOLATED', args: [mappingInputs],
        func: entries => entries.map(entry => ({
          sku: entry.sku,
          record: globalThis.WyErpCollectorBridge.applySeerfar(entry.record, entry.payload, new Date())
        }))
      });
      for (const entry of mapped?.[0]?.result || []) mappedBySku.set(String(entry.sku), entry.record);
    }
    const results = payloadItems.map(item => {
      if (item.status !== 'ready' || !item.result) return item;
      const enriched = mappedBySku.get(String(item.sku));
      return enriched?.analytics
        ? { sku: item.sku, status: 'ready', analytics: enriched.analytics }
        : { sku: item.sku, status: 'failed', message: 'Seerfar数据映射失败。' };
    });
    return { ok: true, items: results, retryAfterSeconds: response.payload?.retryAfterSeconds || 2 };
  } catch (error) {
    return { ok: false, message: WyCapture.cleanText(error?.message || '列表商品批量读取失败。', 180) };
  } finally {
    if (lease) await releaseErpTab(lease);
  }
}
async function readSellerBasicAnalytics(range, binding, returnTab) {
  const dateFrom = String(range?.dateFrom || ''); const dateTo = String(range?.dateTo || '');
  const cacheKey = binding.storeId + '|' + dateFrom + '|' + dateTo;
  const cached = sellerAnalyticsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60000) return cached.data;
  const lastAt = Number(sellerAnalyticsLastRequest.get(binding.storeId) || 0);
  if (lastAt && Date.now() - lastAt < 60000) {
    const wait = Math.max(1, Math.ceil((60000 - (Date.now() - lastAt)) / 1000));
    throw new Error('Ozon官方分析接口每分钟最多读取一次，请' + wait + '秒后再切换周期。');
  }
  const lease = await acquireReadableErpTab(returnTab);
  const target = lease.tab;
  sellerAnalyticsLastRequest.set(binding.storeId, Date.now());
  const query = { storeId: binding.storeId, dateFrom, dateTo };
  let timer;
  let result;
  try {
    result = await Promise.race([
      (async () => {
        await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['shared.js', 'analytics.js', 'erp-bridge.js'], world: 'ISOLATED' });
        const outputs = await chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'ISOLATED', args: [query], func: async input => {
          let selectedTenantId = '';
          try { selectedTenantId = String(globalThis.sessionStorage?.getItem('erp_system_tenant_id') || ''); } catch (_) { /* tenant not selected */ }
          try {
            const data = await globalThis.WyErpCollectorBridge.readStoreAnalytics(input, { origin: globalThis.location.origin, fetch: globalThis.fetch.bind(globalThis), selectedTenantId, now: () => new Date() });
            return { ok: true, data };
          } catch (error) {
            return { ok: false, message: String(error?.message || '官方基础分析读取失败。').slice(0, 240), diagnostic: error?.diagnostic || { code: String(error?.code || 'request_failed').slice(0, 100) } };
          }
        } });
        return outputs?.[0]?.result;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('网研ERP官方基础分析读取超过26秒。')), 26000); })
    ]);
  } finally {
    clearTimeout(timer);
    await releaseErpTab(lease);
  }
  if (!result?.ok || result?.data?.kind !== 'ozon_basic_analytics') throw new Error(result?.message || '网研ERP没有返回官方基础分析。');
  sellerAnalyticsCache.set(cacheKey, { at: Date.now(), data: result.data });
  for (const [key, value] of sellerAnalyticsCache) if (Date.now() - value.at >= 60000) sellerAnalyticsCache.delete(key);
  return result.data;
}
async function readConfiguredSellerShops(returnTab) {
  const lease = await acquireReadableErpTab(returnTab);
  const target = lease.tab;
  let timer;
  let result;
  try {
    result = await Promise.race([
      (async () => {
        try {
          await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['shared.js', 'analytics.js', 'erp-bridge.js'], world: 'ISOLATED' });
        } catch (_) {
          throw new Error('网研ERP页面当前不可读取，请打开并登录网研ERP后重试。');
        }
        const outputs = await chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'ISOLATED', func: async () => {
          let selectedTenantId = '';
          try { selectedTenantId = String(globalThis.sessionStorage?.getItem('erp_system_tenant_id') || ''); } catch (_) { /* tenant not selected */ }
          try {
            const shops = await globalThis.WyErpCollectorBridge.listConfiguredOzonShops({ origin: globalThis.location.origin, fetch: globalThis.fetch.bind(globalThis), selectedTenantId });
            return { ok: true, shops };
          } catch (error) { return { ok: false, message: String(error?.message || '店铺列表读取失败。').slice(0, 240) }; }
        } });
        return outputs?.[0]?.result;
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('网研ERP店铺列表读取超过30秒，请确认ERP已登录。')), erpShopListTimeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    await releaseErpTab(lease);
  }
  if (!result?.ok) throw new Error(result?.message || '网研ERP没有返回店铺列表。');
  return Array.isArray(result.shops) ? result.shops : [];
}
async function readCurrentProduct(tab) {
  const source = WyCapture.sourceUrl(tab?.url);
  if (!Number.isInteger(tab?.id) || !source) return cleanError('请先打开Ozon或1688商品详情页。');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'analytics.js', 'collector.js', 'ozon-public.js'], world: 'ISOLATED' });
    const outputs = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: async () => {
      try {
        let record = globalThis.WyCollector.extract(document, location.href);
        if (record.source.platform === 'ozon' && globalThis.WyOzonPublic?.enrich) record = await globalThis.WyOzonPublic.enrich(record, { fetch: globalThis.fetch.bind(globalThis), origin: location.origin });
        return { record };
      }
      catch (error) { return { error: String(error.message).slice(0, 300) }; }
    } });
    const data = outputs[0]?.result;
    return data?.record ? prepareResult(data.record, tab) : cleanError(data?.error || '页面未返回商品资料；请等待商品页面完整加载后重试。');
  } catch (_) {
    return cleanError('无法读取当前商品页。请确认已完成登录/验证，并等待商品页面完整加载。');
  }
}
async function finishCapture(message) {
  if (message?.type !== 'capture-result') return { ok: false, message: message?.message || '采集失败。' };
  try {
    const saved = await saveToCollection(message.record);
    return saved.ok ? { ok: true, message: saved.created ? '采集成功，已加入采集箱' : '采集成功，已更新采集箱' } : saved;
  } catch (error) {
    return { ok: false, message: WyCapture.cleanText(error?.message || '资料已读取，但写入采集箱失败；请保持ERP已登录后重试。', 200) };
  }
}
async function waitForTab(tabId, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts > 0 ? Math.min(options.maxAttempts, 300) : 150;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === 'complete' && !tab.discarded) return tab;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const error = new Error(String(options.message || '网研ERP页面加载超时，请确认本机服务已启动。'));
  error.code = String(options.code || 'client_sync_page_timeout');
  throw error;
}
let preferredClientOrderErpTabId = null;
async function acquireReadableErpTab(returnTab) {
  const available = (await chrome.tabs.query({ url: erpTabPatterns }))
    .filter(tab => Number.isInteger(tab.id) && isAllowedErpTab(tab) && !/\/login\.html(?:[?#]|$)/.test(String(tab.url || '')))
    .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
  const preferred = available.find(tab => tab.id === preferredClientOrderErpTabId && !tab.discarded);
  if (preferred) return { tab: preferred, temporary: false };
  const existing = available.find(tab => !tab.discarded);
  if (existing) return { tab: existing, temporary: false };
  throw new Error('请先打开并登录ERP');
}
async function releaseErpTab(lease) {
  // Data enrichment only reuses a user-opened ERP page. It must never create,
  // activate or close browser tabs while processing products.
}
async function inspectSellerCookieSession(tab, storeId, timeoutMs = 0) {
  const outputs = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', args: [String(storeId), Number(timeoutMs) || 0], func: async (clientId, maxWaitMs) => {
    const controller = maxWaitMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), maxWaitMs) : null;
    try {
      if (location.protocol !== 'https:' || !['seller.ozonru.cn','seller.ozon.ru'].includes(location.hostname)) return { ok: false, status: 0 };
      const options = { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } };
      if (controller) options.signal = controller.signal;
      const response = await fetch('/api/poll/actual?company_id=' + encodeURIComponent(clientId) + '&poll_type=NPS', options);
      await response.text();
      return { ok: response.ok, status: response.status };
    } catch (_) { return { ok: false, status: 0 }; }
    finally { if (timer) clearTimeout(timer); }
  } });
  const result = outputs?.[0]?.result;
  return { ok: result?.ok === true, status: Number(result?.status) || 0 };
}
async function verifySellerCookieSession(tab, storeId, timeoutMs = 0) {
  return (await inspectSellerCookieSession(tab, storeId, timeoutMs)).ok === true;
}
async function reportSellerBindingToErp(storeId, verified = true, cookies = null) {
  const lease = await acquireReadableErpTab();
  try {
    const outputs = await chrome.scripting.executeScript({ target: { tabId: lease.tab.id }, world: 'MAIN', args: [String(storeId), verified === true, cookies], func: async (clientId, isVerified, sellerCookies) => {
      try {
        const origin = String(location.origin || '');
        if (!['http://127.0.0.1:8765', 'http://localhost:8765'].includes(origin)) return { ok: false };
        const authResponse = await fetch(origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!authResponse.ok) return { ok: false, code: 'erp_login_required' };
        const account = await authResponse.json();
        const selected = String(sessionStorage.getItem('erp_system_tenant_id') || '').trim();
        const query = selected ? '?tenantId=' + encodeURIComponent(selected) : '';
        const payload = { clientId, verified: isVerified };
        if (Array.isArray(sellerCookies)) payload.cookies = sellerCookies;
        const response = await fetch(origin + '/api/integrations/ozon/cookie-bindings' + query, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': String(account.csrfToken || '') }, body: JSON.stringify(payload) });
        let result = null;
        try { result = await response.json(); } catch (_) { /* non-JSON error */ }
        return { ok: response.ok, status: response.status, code: String(result?.error || '') };
      } catch (_) { return { ok: false }; }
    } });
    return outputs?.[0]?.result || { ok: false, status: 0, code: 'erp_bridge_failed' };
  } finally { await releaseErpTab(lease); }
}
async function refreshSellerBinding() {
    const binding = await currentSellerBinding();
    if (!binding) return false;
    const tabs = (await chrome.tabs.query({ url: SELLER_TAB_PATTERNS })).filter(tab => Number.isInteger(tab.id) && !tab.discarded);
    if (!tabs.length) return true;
    const verified = await verifySellerCookieSession(tabs[0], binding.storeId);
  if (!verified) {
    try { await reportSellerBindingToErp(binding.storeId, false); } catch (_) { /* ERP may be closed */ }
    sellerBindings.clear();
    await chrome.storage.session.remove(sellerBindingSessionKey);
    return false;
  }
  const at = Date.now();
  const refreshed = { ...binding, at };
  sellerBindings.clear(); sellerBindings.set(binding.storeId, refreshed);
  await chrome.storage.session.set({ [sellerBindingSessionKey]: { storeId: binding.storeId, at } });
  await reportSellerBindingToErp(binding.storeId, true);
  return true;
}
function recoverableErpFrameError(error) {
  return /showing error page|frame with id 0|no frame with id 0|tab was closed|no tab with id|cannot access contents of url/i.test(String(error?.message || error || ''));
}
async function saveToCollection(record) {
  const available = (await chrome.tabs.query({ url: erpTabPatterns }))
    .filter(tab => Number.isInteger(tab.id) && isAllowedErpTab(tab) && !tab.discarded)
    .sort((left, right) => {
      const leftPreferred = left.id === preferredClientOrderErpTabId ? 1 : 0;
      const rightPreferred = right.id === preferredClientOrderErpTabId ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      const leftLogin = /\/login\.html(?:[?#]|$)/.test(String(left.url || '')) ? 1 : 0;
      const rightLogin = /\/login\.html(?:[?#]|$)/.test(String(right.url || '')) ? 1 : 0;
      if (leftLogin !== rightLogin) return leftLogin - rightLogin;
      if (Boolean(left.active) !== Boolean(right.active)) return Number(Boolean(right.active)) - Number(Boolean(left.active));
      return Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
    });
  const candidates = available.filter(tab => !/\/login\.html(?:[?#]|$)/.test(String(tab.url || '')));
  if (!candidates.length) candidates.push(...available);
  let temporaryTab = null;
  let keepTemporary = false;
  const attempt = async (candidate, temporary) => {
    let target;
    try {
      target = await waitForTab(candidate.id, { maxAttempts: 40, code: 'erp_collection_page_timeout', message: '网研ERP页面8秒内未加载完成，请确认本机ERP已启动并重新采集。' });
      if (!isAllowedErpTab(target)) throw new Error('ERP页面地址已变化。');
      if (/\/login\.html(?:[?#]|$)/.test(String(target.url || ''))) {
        if (temporary) keepTemporary = true;
        try { await chrome.tabs.update(target.id, { active: true }); } catch (_) { /* tab closed */ }
        const error = new Error('请先登录网研ERP，再重新采集。');
        error.code = 'erp_login_required';
        throw error;
      }
      if (!erpCollectionBridgeReadyTabs.has(target.id)) {
        await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['shared.js', 'analytics.js', 'erp-bridge.js'], world: 'ISOLATED' });
        erpCollectionBridgeReadyTabs.add(target.id);
      }
      let saveTimer;
      const outputs = await Promise.race([
        chrome.scripting.executeScript({ target: { tabId: target.id }, world: 'ISOLATED', args: [record], func: async captureRecord => {
        let selectedTenantId = '';
        try { selectedTenantId = String(globalThis.sessionStorage?.getItem('erp_system_tenant_id') || '').trim(); } catch (_) { /* tenant not selected */ }
        const notifyChange = detail => {
          if (typeof globalThis.BroadcastChannel !== 'function') return;
          let channel;
          try {
            channel = new globalThis.BroadcastChannel('wyerp-storage-updates');
            channel.postMessage({ source: 'wyerp-collector-direct-' + Date.now(), key: detail.key, tenant: detail.tenantId });
          } finally { try { channel?.close(); } catch (_) { /* already closed */ } }
        };
        try {
          return await globalThis.WyErpCollectorBridge.save(captureRecord, {
            origin: globalThis.location.origin,
            fetch: globalThis.fetch.bind(globalThis),
            selectedTenantId,
            notifyChange
          });
        } catch (error) {
          return { ok: false, code: String(error?.code || '').slice(0, 80), message: String(error?.message || '采集箱保存失败。').slice(0, 200) };
        }
      } }),
        new Promise((_, reject) => {
          saveTimer = setTimeout(() => {
            const error = new Error('网研ERP采集箱保存超过20秒，请确认ERP已登录并重新采集。');
            error.code = 'erp_save_timeout';
            reject(error);
          }, 20000);
        })
      ]).finally(() => { if (saveTimer) clearTimeout(saveTimer); });
      const result = outputs?.[0]?.result;
      if (!result?.ok) {
        if (result?.code === 'erp_login_required') {
          if (temporary) keepTemporary = true;
          try { await chrome.tabs.update(target.id, { active: true }); } catch (_) { /* tab closed */ }
        }
        const error = new Error(result?.message || '网研ERP采集箱没有返回保存结果。');
        error.code = result?.code;
        throw error;
      }
      return result;
    } catch (error) {
      if (recoverableErpFrameError(error)) {
        erpCollectionBridgeReadyTabs.delete(candidate.id);
        return null;
      }
      throw error;
    }
  };
  try {
    for (const candidate of candidates) {
      const result = await attempt(candidate, false);
      if (result) return result;
    }
    temporaryTab = await chrome.tabs.create({ url: defaultCollectionUrl, active: false });
    if (!Number.isInteger(temporaryTab?.id)) throw new Error('无法连接网研ERP采集箱。');
    const result = await attempt(temporaryTab, true);
    if (result) return result;
    const error = new Error('本机网研ERP页面无法正常加载，请确认服务已启动并且 http://127.0.0.1:8765 可以打开。');
    error.code = 'erp_error_page';
    throw error;
  } finally {
    if (temporaryTab && !keepTemporary && Number.isInteger(temporaryTab.id)) {
      erpCollectionBridgeReadyTabs.delete(temporaryTab.id);
      try { await chrome.tabs.remove(temporaryTab.id); } catch (_) { /* tab already closed */ }
    }
  }
}
chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'capture-sidebar') {
    const match = String(port.sender?.url || '').match(/\?tab=(\d+)$/);
    const tabId = match ? Number(match[1]) : null;
    if (port.sender?.id !== chrome.runtime.id || tabId === null || port.sender.url !== sidebarUrl + '?tab=' + tabId) { port.disconnect(); return; }
    sidebarPorts.set(tabId, port);
    port.onMessage.addListener(message => {
      if (message?.type === 'heartbeat') {
        const saved = sidebarSnapshots.get(tabId);
        if (saved) saved.at = Date.now();
        return;
      }
      if (message?.type === 'restore') {
        (async () => {
          try {
            const tab = await chrome.tabs.get(tabId);
            if (!validRecord(message.record, tab)) throw new Error('source_mismatch');
            const restored = { type: 'capture-result', record: message.record, sourceTabId: tabId };
            sidebarSnapshots.set(tabId, { at: Date.now(), message: restored });
            port.postMessage(restored);
          } catch (_) {
            port.postMessage({ type: 'sidebar-clear', message: '来源商品页已跳转或关闭，请回到当前Ozon商品页重新打开侧栏。' });
          }
        })();
        return;
      }
      if (message?.type !== 'ready') return;
      const saved = sidebarSnapshots.get(tabId);
      if (saved && Date.now() - saved.at <= 300000) port.postMessage(saved.message);
      else { sidebarSnapshots.delete(tabId); port.postMessage({ type: 'sidebar-clear', message: '页面快照已过期或浏览器后台已休眠，请回到商品页重新打开侧栏。' }); }
    });
    port.onDisconnect.addListener(() => { if (sidebarPorts.get(tabId) === port) sidebarPorts.delete(tabId); });
    return;
  }
  port.disconnect();
});
function clearSidebar(id) {
  sidebarSnapshots.delete(id);
  try { sidebarPorts.get(id)?.postMessage({ type: 'sidebar-clear', message: '来源页已跳转、刷新或关闭，请重新打开侧栏，避免混用不同商品。' }); } catch (_) { sidebarPorts.delete(id); }
}
chrome.tabs.onRemoved.addListener(id => { clearSidebar(id); sidebarPorts.delete(id); sidebarPrepared.delete(id); erpCollectionBridgeReadyTabs.delete(id); });
chrome.tabs.onUpdated.addListener((id, info) => {
  if (info.status === 'loading' || info.url) {
    clearSidebar(id);
    erpCollectionBridgeReadyTabs.delete(id);
  }
});
async function runTianyanDiagnosticFromOpenSeller() {
  const tabs = (await chrome.tabs.query({ url: SELLER_TAB_PATTERNS }))
    .filter(tab => Number.isInteger(tab.id) && !tab.discarded)
    .sort((a, b) => Number(String(b.url || '').includes('/app/analytics/graphs')) - Number(String(a.url || '').includes('/app/analytics/graphs')) || Number(Boolean(b.active)) - Number(Boolean(a.active)));
  const tab = tabs[0];
  if (!tab) return { ok: false, error: '没有找到已打开的 Ozon Seller 页面。' };
  const outputs = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: async () => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
      const end = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
      const start = new Date(end.getTime()); start.setUTCDate(start.getUTCDate() - 6);
      const dateTo = end.toISOString().slice(0, 10), dateFrom = start.toISOString().slice(0, 10);
      const summarize = async (path, body) => {
        try {
          const response = await fetch(location.origin + path, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body)
          });
          const text = await response.text();
          let json = null; try { json = JSON.parse(text); } catch (_) {}
          const rows = Array.isArray(json?.result?.data) ? json.result.data : Array.isArray(json?.data) ? json.data : [];
          const first = rows[0] || null;
          const fields = first && typeof first === 'object' ? Object.keys(first).slice(0, 60) : [];
          return {
            path,
            status: response.status,
            ok: response.ok,
            size: text.length,
            rows: rows.length,
            fields,
            hasPremium: fields.some(key => /session|visitor|view|conv|position|cart|return|cancel/i.test(key)),
            topKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : [],
            sample: first ? JSON.stringify(first).slice(0, 900) : text.slice(0, 900)
          };
        } catch (error) {
          return { path, status: 0, ok: false, error: String(error && error.message || error) };
        }
      };
      const tests = [];
      tests.push(await summarize('/api/site/seller-analytics/what_to_sell/data/v3', { date_from: dateFrom, date_to: dateTo }));
      tests.push(await summarize('/api/site/seller-analytics/metrics/daily', {
        date_from: dateFrom, date_to: dateTo, dimension: 'sku',
        metrics: ['revenue','ordered_units','session_view','session_view_pdp','conv_tocart','position_category']
      }));
      tests.push(await summarize('/api/site/seller-analytics/traffic', { date_from: dateFrom, date_to: dateTo }));
      return { ok: true, page: location.href, origin: location.origin, dateFrom, dateTo, tests };
    }
  });
  return outputs?.[0]?.result || { ok: false, error: 'Seller 页面没有返回诊断结果。' };
}


async function readTianyanRangeFromOpenSeller(clientId, range) {
  clientId = String(clientId || '').trim();
  const dateFrom = String(range && range.dateFrom || '').slice(0, 10);
  const dateTo = String(range && range.dateTo || '').slice(0, 10);
  if (!/^[1-9]\d{2,19}$/.test(clientId)) throw new Error('天眼店铺ID无效。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) throw new Error('天眼日期范围无效。');
  const start = Date.parse(dateFrom + 'T00:00:00Z');
  const end = Date.parse(dateTo + 'T00:00:00Z');
  const days = Math.floor((end - start) / 86400000) + 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || days < 1 || days > 90) throw new Error('天眼只支持1至90天的日期范围。');

  const tabs = (await chrome.tabs.query({ url: SELLER_TAB_PATTERNS }))
    .filter(tab => Number.isInteger(tab.id) && !tab.discarded && /\/app\/analytics\/graphs/.test(String(tab.url || '')))
    .sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0));
  const tab = tabs[0];
  if (!tab) throw Object.assign(new Error('请先在当前浏览器登录 Ozon Seller，并打开“我的分析”页面后重试。'), { code: 'seller_login_required' });

  const binding = await currentSellerBinding().catch(() => null);
  if (binding && String(binding.storeId || '') && String(binding.storeId) !== clientId) {
    throw Object.assign(new Error('当前 Ozon Seller 会话绑定的是其他店铺，请在同一浏览器切换到对应店铺后重试。'), { code: 'seller_login_required' });
  }
  const session = await inspectSellerCookieSession(tab, clientId, 2500).catch(() => ({ ok: false, status: 0 }));
  if (!session.ok) {
    const unknown = session.status === 0 || session.status >= 500;
    throw Object.assign(new Error(unknown
      ? '暂时无法确认当前浏览器的 Ozon Seller 登录状态，请刷新“我的分析”页面并确认插件已启用后重试。'
      : '当前浏览器的 Ozon Seller 未登录目标店铺或会话已失效，请重新登录对应店铺后重试。'),
    { code: unknown ? 'seller_status_unknown' : 'seller_login_required' });
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: 'wyerp-tianyan-range-fetch',
      clientId,
      dateFrom,
      dateTo
    });
  } catch (error) {
    throw new Error('天眼页面尚未加载最新插件，请刷新 Ozon“我的分析”页面后重试。');
  }
  if (!response || response.ok !== true || !response.data) throw new Error(String(response && response.message || '天眼周期读取失败。').slice(0, 240));
  const data = response.data;
  if (String(data.dateFrom || '') !== dateFrom || String(data.dateTo || '') !== dateTo) throw new Error('天眼返回的日期范围与当前分析筛选不一致。');
  data.shopId = clientId;
  return data;
}

chrome.runtime.onMessage.addListener((input, sender, sendResponse) => {

  if (input?.type === 'wyerp-tianyan-range-read') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    const allowedOrigin = page && ['http://127.0.0.1:8765', 'http://localhost:8765'].includes(page.origin);
    const clientId = String(input?.clientId || '').trim();
    const dateFrom = String(input?.dateFrom || '').trim();
    const dateTo = String(input?.dateTo || '').trim();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || !allowedOrigin) {
      sendResponse({ ok: false, message: '只能由本机网研ERP读取天眼周期数据。' });
      return false;
    }
    (async () => {
      try {
        const data = await readTianyanRangeFromOpenSeller(clientId, { dateFrom, dateTo });
        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, code: String(error?.code || 'tianyan_read_failed'), message: String(error?.message || '天眼周期读取失败。').slice(0, 240) });
      }
    })();
    return true;
  }

  if (input?.type === 'wyerp-tianyan-cache-yesterday-read') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    const allowedOrigin = page && ['http://127.0.0.1:8765', 'http://localhost:8765'].includes(page.origin);
    const clientId = String(input?.clientId || '').trim();
    const dateFrom = String(input?.dateFrom || '').trim();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || !allowedOrigin) {
      sendResponse({ ok: false, message: '只能由本机网研ERP读取天眼缓存。' });
      return false;
    }
    if (!/^[1-9]\d{2,19}$/.test(clientId) || !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      sendResponse({ ok: false, message: '天眼缓存读取参数无效。' });
      return false;
    }
    (async () => {
      try {
        if (!globalThis.WyTianyanCacheStore) throw new Error('天眼缓存模块未加载。');
        const data = await globalThis.WyTianyanCacheStore.readYesterday(clientId, dateFrom);
        if (!data) {
          sendResponse({ ok: false, message: '没有找到该店铺昨天的天眼缓存，请先打开 Ozon 天眼完成自动缓存。' });
          return;
        }
        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, message: String(error?.message || '天眼缓存读取失败。').slice(0, 240) });
      }
    })();
    return true;
  }
  if (input?.type === 'wyerp-tianyan-cache-yesterday') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || !isAllowedSellerPage(page)) {
      sendResponse({ ok: false, message: '只能从 Ozon 卖家后台写入天眼缓存。' });
      return false;
    }
    (async () => {
      try {
        if (!globalThis.WyTianyanCacheStore) throw new Error('天眼缓存模块未加载。');
        const binding = await currentSellerBinding().catch(() => null);
        const supplied = String(input?.payload?.shopId || '');
        let shopId = /^[1-9]\d{2,19}$/.test(supplied)
          ? supplied
          : (/^[1-9]\d{2,19}$/.test(String(binding?.storeId || '')) ? String(binding.storeId) : 'unknown');
        if (shopId === 'unknown') {
          const cookies = await chrome.cookies.getAll({ url: page.origin + '/' }).catch(() => []);
          const companyCookie = (Array.isArray(cookies) ? cookies : []).find(cookie =>
            /^(?:sc_)?company_id$/i.test(String(cookie?.name || '')) && /^[1-9]\d{2,19}$/.test(String(cookie?.value || ''))
          );
          if (companyCookie) shopId = String(companyCookie.value);
        }
        const status = await globalThis.WyTianyanCacheStore.saveYesterday(input.payload, shopId);
        sendResponse({ ok: true, status });
      } catch (error) {
        sendResponse({ ok: false, message: String(error?.message || '昨天缓存写入失败。').slice(0, 240) });
      }
    })();
    return true;
  }
  if (input?.type === 'list-configured-ozon-shops') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || page?.protocol !== 'https:' || !SELLER_HOSTS.has(page.hostname)) { sendResponse({ ok: false, message: '只能在Ozon卖家后台读取网研ERP店铺列表。' }); return false; }
    readConfiguredSellerShops(sender.tab).then(shops => sendResponse({ ok: true, shops })).catch(error => sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '店铺列表读取失败。', 240) }));
    return true;
  }
  if (input?.type === 'read-tianyan-analytics') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || page?.protocol !== 'https:' || !SELLER_HOSTS.has(page.hostname)) {
      sendResponse({ ok: false, message: '只能在 Ozon 卖家后台使用天眼功能。' }); return false;
    }
    (async () => {
      try {
        const binding = await currentSellerBinding();
        if (!binding) throw new Error('请先在 Ozon 卖家后台任意页面点击"网研ERP 绑定Ozon店铺"完成绑定，绑定有效期 30 分钟。');
        const data = await readSellerBasicAnalytics(input.range, binding, sender.tab);
        sendResponse({ ok: true, data });
      } catch (error) { sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '天眼读取失败。', 240) }); }
    })();
    return true;
  }

  // ====== 同源内部 API fetch 测试（带 Cookie，模拟正常用户） ======
  if (input?.type === 'fetch-ozon-native-analytics') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    if (!Number.isInteger(sender?.tab?.id) || page?.protocol !== 'https:' || !SELLER_HOSTS.has(page.hostname)) {
      sendResponse({ ok: false, message: '只能在 Ozon 卖家后台使用。' }); return false;
    }
    (async () => {
      try {
        // 1. 拿 Cookie
        const cookieBatches = await Promise.all([
          chrome.cookies.getAll({ url: page.href }),
          chrome.cookies.getAll({ url: page.origin + '/' })
        ]);
        const cookieMap = new Map();
        for (const item of cookieBatches.flat()) {
          const key = [item.name, item.domain, item.path, item.storeId, item.partitionKey?.topLevelSite || ''].join('\u0000');
          if (!cookieMap.has(key)) cookieMap.set(key, item);
        }
        const cookies = Array.from(cookieMap.values());
        if (!cookies.length) throw new Error('没读到 Ozon Cookie，请先登录。');

        // 2. 拼 Cookie 字符串，找 company_id
        const cookieHeader = cookies.map(c => c.name + '=' + encodeURIComponent(c.value)).join('; ');
        const companyIdCookie = cookies.find(c => /^(?:sc_)?company_id$/i.test(c.name));
        const companyId = companyIdCookie ? companyIdCookie.value : '';

        // 3. 模拟正常用户的 headers
        const makeHeaders = (extra = {}) => ({
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': page.origin,
          'Referer': page.href,
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
          'Sec-Ch-Ua': '"Chromium";v="135", "Not.A/Brand";v="8"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'x-o3-company-id': companyId,
          ...extra
        });

        // 4. 日期
        const dateFrom = input.dateFrom || moscowDateText(-7);
        const dateTo = input.dateTo || moscowDateText(-1);

        const tests = [];

        // 测试 1: what_to_sell/data/v3（卖家后台同源接口）
        try {
          const res = await fetch(page.origin + '/api/site/seller-analytics/what_to_sell/data/v3', {
            method: 'POST', headers: makeHeaders(),
            body: JSON.stringify({ date_from: dateFrom, date_to: dateTo })
          });
          const text = await res.text();
          let json = null; try { json = JSON.parse(text); } catch(e) {}
          const sampleData = json && (json.result?.data || json.data);
          const firstRow = Array.isArray(sampleData) && sampleData[0] ? sampleData[0] : null;
          const fieldKeys = firstRow ? Object.keys(firstRow) : [];
          tests.push({
            url: '/api/site/seller-analytics/what_to_sell/data/v3',
            status: res.status, ok: res.ok,
            rows: Array.isArray(sampleData) ? sampleData.length : 0,
            fields: fieldKeys.slice(0, 20),
            hasPremium: fieldKeys.some(m => /session_view|conv_tocart|position|returns/i.test(m)),
            sample: firstRow ? JSON.stringify(firstRow).slice(0, 300) : text.slice(0, 300)
          });
        } catch(e) { tests.push({ url: 'what_to_sell', error: String(e?.message || e) }); }

        // 测试 2: 同源 metrics/daily
        try {
          const res = await fetch(page.origin + '/api/site/seller-analytics/metrics/daily', {
            method: 'POST', headers: makeHeaders(),
            body: JSON.stringify({
              date_from: dateFrom, date_to: dateTo, dimension: 'sku',
              metrics: ['revenue', 'ordered_units', 'session_view', 'conv_tocart', 'position_category']
            })
          });
          const text = await res.text();
          let json = null; try { json = JSON.parse(text); } catch(e) {}
          const sampleData = json && (json.result?.data || json.data);
          const firstRow = Array.isArray(sampleData) && sampleData[0] ? sampleData[0] : null;
          const fieldKeys = firstRow ? Object.keys(firstRow) : [];
          tests.push({
            url: '/api/site/seller-analytics/metrics/daily',
            status: res.status, ok: res.ok,
            rows: Array.isArray(sampleData) ? sampleData.length : 0,
            fields: fieldKeys.slice(0, 20),
            hasPremium: fieldKeys.some(m => /session_view|conv_tocart|position/i.test(m)),
            sample: firstRow ? JSON.stringify(firstRow).slice(0, 300) : text.slice(0, 300)
          });
        } catch(e) { tests.push({ url: 'metrics/daily', error: String(e?.message || e) }); }

        // 测试 3: 同源 traffic 接口（可能有浏览数据）
        try {
          const res = await fetch(page.origin + '/api/site/seller-analytics/traffic', {
            method: 'POST', headers: makeHeaders(),
            body: JSON.stringify({ date_from: dateFrom, date_to: dateTo })
          });
          const text = await res.text();
          let json = null; try { json = JSON.parse(text); } catch(e) {}
          tests.push({
            url: '/api/site/seller-analytics/traffic',
            status: res.status, ok: res.ok,
            size: text.length,
            sample: text.slice(0, 300)
          });
        } catch(e) { tests.push({ url: 'traffic', error: String(e?.message || e) }); }

        // 测试 4: 官方 OpenAPI 加 Cookie
        try {
          const res = await fetch('https://api-seller.ozon.ru/v1/analytics/data', {
            method: 'POST', headers: makeHeaders({ Host: 'api-seller.ozon.ru' }),
            body: JSON.stringify({
              date_from: dateFrom, date_to: dateTo,
              dimension: ['sku', 'day'],
              metrics: ['revenue', 'ordered_units', 'session_view', 'conv_tocart', 'position_category']
            })
          });
          const text = await res.text();
          let json = null; try { json = JSON.parse(text); } catch(e) {}
          const sampleData = json && (json.result?.data);
          const firstRow = Array.isArray(sampleData) && sampleData[0] ? sampleData[0] : null;
          const fieldKeys = firstRow ? Object.keys(firstRow) : [];
          tests.push({
            url: 'api-seller.ozon.ru/v1/analytics/data (with Cookie)',
            status: res.status, ok: res.ok,
            rows: Array.isArray(sampleData) ? sampleData.length : 0,
            fields: fieldKeys.slice(0, 20),
            hasPremium: fieldKeys.some(m => /session_view|conv_tocart|position/i.test(m)),
            sample: firstRow ? JSON.stringify(firstRow).slice(0, 300) : text.slice(0, 300)
          });
        } catch(e) { tests.push({ url: 'openapi-cookie', error: String(e?.message || e) }); }

        // 测试 5: 订单接口（带 Cookie 看能不能绕过 60 天）
        try {
          const res = await fetch(page.origin + '/api/site/seller-analytics/orders', {
            method: 'POST', headers: makeHeaders(),
            body: JSON.stringify({ date_from: dateFrom, date_to: dateTo })
          });
          const text = await res.text();
          tests.push({
            url: '/api/site/seller-analytics/orders',
            status: res.status, ok: res.ok,
            size: text.length,
            sample: text.slice(0, 300)
          });
        } catch(e) { tests.push({ url: 'orders', error: String(e?.message || e) }); }

        console.log('[网研ERP native fetch] Cookie数:', cookies.length, 'company_id:', companyId);
        console.log('[网研ERP native fetch] 测试结果:', JSON.stringify(tests, null, 2));
        sendResponse({ ok: true, dateFrom, dateTo, companyId, tests });
      } catch (error) { sendResponse({ ok: false, message: String(error?.message || error) }); }
    })();
    return true;
  }

  if (input?.type === 'read-seller-basic-analytics') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    const path = page?.pathname?.replace(/\/$/, '') || '';
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || page?.protocol !== 'https:' || !SELLER_HOSTS.has(page.hostname) || !(path === '/app/analytics/graphs' || path.startsWith('/app/analytics/graphs/'))) {
      sendResponse({ ok: false, message: '只能在Ozon卖家后台“我的分析”页面读取基础分析。' }); return false;
    }
    (async () => {
      try {
        const binding = await currentSellerBinding();
        if (!binding) throw new Error('请先使用右上角“绑定Ozon店铺”确认当前店铺，绑定有效期30分钟。');
        const data = await readSellerBasicAnalytics(input.range, binding, sender.tab);
        sendResponse({ ok: true, data });
      } catch (error) { sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '官方基础分析读取失败。', 240) }); }
    })();
    return true;
  }
  if (input?.type === 'bind-seller-store') {
    const page = (() => { try { return new URL(sender?.tab?.url || ''); } catch (_) { return null; } })();
    if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0 || page?.protocol !== 'https:' || !SELLER_HOSTS.has(page.hostname)) { sendResponse({ ok: false, message: '只能在Ozon卖家后台顶层页面绑定当前登录店铺。' }); return false; }
    const requestedStoreId = String(input.storeId || '');
    if (requestedStoreId && !/^[1-9]\d{2,19}$/.test(requestedStoreId)) { sendResponse({ ok: false, message: '当前页面返回的店铺标识无效。' }); return false; }
    (async () => {
      try {
        // Invoke request before the first await so Edge keeps the originating
        // seller-page button click as the required user gesture. Requesting an
        // already granted optional permission resolves true without a prompt.
        const allowed = await chrome.permissions.request({ permissions: ['cookies'] });
        if (!allowed) throw new Error('未授予Cookie权限，店铺未绑定。');
        const cookieBatches = await Promise.all([
          chrome.cookies.getAll({ url: page.href }),
          chrome.cookies.getAll({ url: page.origin + '/' })
        ]);
        const cookieMap = new Map();
        for (const item of cookieBatches.flat()) {
          const key = [item.name, item.domain, item.path, item.storeId, item.partitionKey?.topLevelSite || ''].join('\u0000');
          if (!cookieMap.has(key)) cookieMap.set(key, item);
        }
        const cookies = Array.from(cookieMap.values()).slice(0, 200);
        if (!cookies.length) throw new Error('没有读取到Ozon卖家后台Cookie，请先完成登录。');
        const explicit = requestedStoreId;
        const namedCookieIds = [...new Set(cookies
          .filter(item => /^(?:sc_)?company_id$/i.test(String(item.name || '')) && /^[1-9]\d{2,19}$/.test(String(item.value || '')))
          .map(item => String(item.value)))];
        const matchedCookieId = namedCookieIds.length === 1 ? namedCookieIds[0] : '';
        const verifiedCandidates = [...new Set([matchedCookieId].filter(Boolean))];
        if (explicit && verifiedCandidates.length && !verifiedCandidates.includes(explicit)) throw new Error('所选店铺与当前Seller Cookie识别出的店铺不一致。');
        let storeId = explicit || matchedCookieId;
        let sessionVerified = false;
        if (!storeId) {
          const configuredShops = await readConfiguredSellerShops(sender.tab);
          const verifiedShops = [];
          for (const shop of configuredShops) {
            if (await verifySellerCookieSession(sender.tab, shop.clientId)) verifiedShops.push(shop);
          }
          if (verifiedShops.length === 1) storeId = String(verifiedShops[0].clientId || '');
          else if (verifiedShops.length > 1) throw new Error('当前Seller会话同时匹配多个ERP店铺，无法唯一确认当前店铺，未写入授权状态。');
        }
        if (storeId) {
          sessionVerified = await verifySellerCookieSession(sender.tab, storeId);
          if (!sessionVerified) throw new Error('当前Seller Cookie未通过只读接口验证，请重新登录Ozon后台。');
        }
        if (!storeId) {
          throw new Error('无法从当前Seller页面识别唯一店铺ID，未写入授权状态；请刷新Seller页面后重试。');
        }
        if (!sessionVerified && !await verifySellerCookieSession(sender.tab, storeId)) throw new Error('当前Seller Cookie未通过只读接口验证，请重新登录Ozon后台。');
        const material = cookies.map(item => [item.name, item.value, item.domain, item.path].join('\u0000')).sort().join('\u0001');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
        const fingerprint = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
        const at = Date.now();
        await chrome.storage.session.set({ [sellerBindingSessionKey]: { storeId, at } });
        sellerBindings.clear(); sellerBindings.set(storeId, { storeId, fingerprint, at });
        let persisted;
        try { persisted = await reportSellerBindingToErp(storeId, true, cookies); }
        finally {
          if (!persisted?.ok) {
            sellerBindings.clear();
            await chrome.storage.session.remove(sellerBindingSessionKey);
          }
        }
        if (!persisted.ok) {
          const reason = persisted.code ? '，错误：' + persisted.code : '';
          throw new Error('Cookie已验证，但ERP保存失败（HTTP ' + (persisted.status || '无响应') + reason + '）。');
        }
        sendResponse({ ok: true, storeId });
      } catch (error) { sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '绑定失败。', 200) }); }
    })();
    return true;
  }
  if (input?.type === 'prepare-ozon-sidebar') {
    const tab = sender?.tab; const source = WyCapture.sourceUrl(tab?.url);
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || source?.platform !== 'ozon') { sendResponse({ ok: false }); return false; }
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidebar.html?tab=' + tab.id, enabled: true })
      .then(() => { sidebarPrepared.add(tab.id); sendResponse({ ok: true }); })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (input?.type === 'ozon-public-cache-get') {
    const tab = sender?.tab; const source = WyCapture.sourceUrl(tab?.url); const sku = String(input.sku || '');
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || source?.platform !== 'ozon' || source.productId !== sku) { sendResponse({ ok: false }); return false; }
    (async () => {
      const key = ozonPublicCachePrefix + sku;
      const stored = await chrome.storage.local.get(key);
      const entry = stored?.[key]; const ageMs = Date.now() - Number(entry?.at || 0);
      if (!entry?.record || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > ozonPublicCacheExpiryMs || entry.record?.source?.productId !== sku) {
        if (entry) await chrome.storage.local.remove(key);
        sendResponse({ ok: true, hit: false }); return;
      }
      sendResponse({ ok: true, hit: true, status: ageMs <= ozonPublicCacheFreshMs ? 'fresh' : 'stale', record: entry.record });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (input?.type === 'ozon-public-cache-set') {
    const tab = sender?.tab; const source = WyCapture.sourceUrl(tab?.url); const record = input.record; const sku = String(record?.source?.productId || '');
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || source?.platform !== 'ozon' || source.productId !== sku || record?.source?.platform !== 'ozon') { sendResponse({ ok: false }); return false; }
    (async () => {
      const compact = {
        schemaVersion: record.schemaVersion,
        adapterVersion: record.adapterVersion,
        source: record.source,
        analytics: record.analytics,
        marketOffers: record.marketOffers
      };
      if (JSON.stringify(compact).length > 600000) { sendResponse({ ok: false }); return; }
      const key = ozonPublicCachePrefix + sku; const at = Date.now();
      const stored = await chrome.storage.local.get(ozonPublicCacheIndexKey);
      const previous = Array.isArray(stored?.[ozonPublicCacheIndexKey]) ? stored[ozonPublicCacheIndexKey] : [];
      const index = previous.filter(item => item?.key !== key && at - Number(item?.at || 0) <= ozonPublicCacheExpiryMs);
      index.push({ key, at }); index.sort((left, right) => Number(left.at) - Number(right.at));
      const removed = index.splice(0, Math.max(0, index.length - 60)).map(item => item.key);
      await chrome.storage.local.set({ [key]: { at, record: compact }, [ozonPublicCacheIndexKey]: index });
      if (removed.length) await chrome.storage.local.remove(removed);
      sendResponse({ ok: true });
    })().catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (input?.type === 'enrich-ozon-listing-sku') {
    const tab = sender?.tab;
    const sku = String(input.sku || '').trim();
    let productUrl;
    let pageUrl;
    try {
      productUrl = new URL(String(input.productUrl || ''), tab?.url);
      pageUrl = new URL(String(tab?.url || ''));
    } catch (_) {
      sendResponse({ ok: false, message: '商品链接无效。' });
      return false;
    }
    const allowedHost = /^(?:www\.)?ozon\.(?:ru|by|kz)$/.test(pageUrl.hostname)
      && productUrl.hostname === pageUrl.hostname;
    const productSku = productUrl.pathname.match(/-(\d{6,20})\/?$/)?.[1] || '';
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || !allowedHost || !/^\d{6,20}$/.test(sku) || productSku !== sku) {
      sendResponse({ ok: false, message: '当前列表商品与SKU不一致。' });
      return false;
    }
    (async () => {
      try {
        const record = {
          schemaVersion: 1,
          adapterVersion: WyCapture.VERSION,
          source: { platform: 'ozon', productId: sku, url: productUrl.href },
          analytics: { status: 'unavailable', metrics: [], sources: [], warnings: [] }
        };
        // Listing tabs contain several product URLs, so the single-product
        // prepareResult URL equality guard does not apply here. The actual
        // ERP/Seerfar enrichment source remains identical to product pages.
        const enriched = await enrichFromErp(record, tab, { queue: true });
        if (enriched.analytics?.pending) {
          sendResponse({ ok: true, pending: true, retryAfterSeconds: enriched.analytics.pending.retryAfterSeconds || 2 });
          return;
        }
        const metricCount = new Set((enriched.analytics?.metrics || []).map(item => item?.key).filter(Boolean)).size;
        if (!metricCount) throw new Error(enriched.analytics?.warnings?.slice(-1)[0] || '列表商品数据读取失败。');
        sendResponse({ ok: true, sku, analytics: enriched.analytics || record.analytics });
      } catch (error) {
        sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '列表商品数据读取失败。', 180) });
      }
    })();
    return true;
  }
  if (input?.type === 'enrich-ozon-listing-skus') {
    const tab = sender?.tab;
    let pageUrl;
    try { pageUrl = new URL(String(tab?.url || '')); } catch (_) { pageUrl = null; }
    const rawItems = Array.isArray(input.items) ? input.items : [];
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || !pageUrl || !/^(?:www\.)?ozon\.(?:ru|by|kz)$/.test(pageUrl.hostname) || !rawItems.length || rawItems.length > 8) {
      sendResponse({ ok: false, message: '批量商品请求无效。' }); return false;
    }
    const items = [];
    for (const raw of rawItems) {
      const sku = String(raw?.sku || '').trim();
      let productUrl;
      try { productUrl = new URL(String(raw?.productUrl || ''), pageUrl.href); } catch (_) { productUrl = null; }
      const productSku = productUrl?.pathname.match(/-(\d{6,20})\/?$/)?.[1] || '';
      if (!productUrl || productUrl.hostname !== pageUrl.hostname || !/^\d{6,20}$/.test(sku) || productSku !== sku) {
        sendResponse({ ok: false, message: '批量商品链接与SKU不一致。' }); return false;
      }
      items.push({ sku, productUrl: productUrl.href });
    }
    enrichListingBatchFromErp(items, tab).then(sendResponse);
    return true;
  }
  if (input?.type === 'enrich-ozon-record') {
    const tab = sender?.tab;
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || !validRecord(input.record, tab) || input.record.source.platform !== 'ozon') { sendResponse({ ok: false, message: '当前商品页资料与SKU不一致。' }); return false; }
    (async () => {
      const message = await prepareResult(input.record, tab, { forceRefresh: input.forceRefresh === true });
      sendResponse(message?.type === 'capture-result' ? { ok: true, record: message.record } : { ok: false, message: message?.message || 'Ozon资料读取失败。' });
    })();
    return true;
  }
  if (input?.type === 'open-ozon-sidebar') {
    const tab = sender?.tab; const source = WyCapture.sourceUrl(tab?.url);
    if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || source?.platform !== 'ozon') { sendResponse({ ok: false, message: '只能在Ozon商品页打开商品侧栏。' }); return false; }
    if (!validRecord(input.record, tab)) { sendResponse({ ok: false, message: '当前商品页资料与SKU不一致，请等待商品页面完整加载后重试。' }); return false; }
    (async () => {
      const loading = { type: 'sidebar-loading', message: '正在读取当前Ozon商品和网研ERP缓存的市场数据…' };
      sidebarSnapshots.set(tab.id, { at: Date.now(), message: loading });
      try { sidebarPorts.get(tab.id)?.postMessage(loading); } catch (_) { sidebarPorts.delete(tab.id); }
      try {
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch (_) { sidebarSnapshots.delete(tab.id); sendResponse({ ok: false, message: 'Edge没有打开原生侧栏。请刷新当前商品页，等待按钮出现后再试。' }); return; }
      // The panel path was prepared when the content script mounted. Reapplying
      // setOptions after open reloads Edge's panel and can drop the first snapshot.
      sidebarPrepared.add(tab.id);
      const message = await prepareResult(input.record, tab);
      if (message?.type !== 'capture-result') {
        const failure = { type: 'sidebar-clear', message: message?.message || '当前页面资料未能读取，请等待加载后重新打开侧栏。' };
        sidebarSnapshots.set(tab.id, { at: Date.now(), message: failure });
        try { sidebarPorts.get(tab.id)?.postMessage(failure); } catch (_) { sidebarPorts.delete(tab.id); }
        sendResponse({ ok: false, message: failure.message }); return;
      }
      sendResponse({ ok: true, message: '侧栏已读取当前商品，无需写入采集箱' });
    })();
    return true;
  }
  if (input?.type === 'open-tool-page') {
    const url = toolPages[String(input.tool || '')];
    if (!url) { sendResponse({ ok: false, message: '不支持该工具入口。' }); return false; }
    chrome.tabs.create({ url, active: true }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false, message: '页面未能打开。' }));
    return true;
  }
  if (input?.type !== 'page-capture-result') return false;
  const tab = sender?.tab;
  if (!Number.isInteger(tab?.id) || sender.frameId && sender.frameId !== 0 || running.has(tab.id)) { sendResponse({ ok: false, message: '当前商品正在采集，请稍候重试。' }); return false; }
  running.add(tab.id);
  (async () => {
    try { sendResponse(await finishCapture(await prepareResult(input.record, tab))); }
    catch (_) { sendResponse({ ok: false, message: '采集结果处理失败，请刷新商品页后重试。' }); }
    finally { running.delete(tab.id); }
  })();
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  if (running.has(tab.id)) return;
  running.add(tab.id);
  let message;
  try {
    if (!Number.isInteger(tab.id) || !WyCapture.sourceUrl(tab.url)) {
      message = cleanError('请先打开1688商品详情页或Ozon商城商品页，再点击插件图标。列表、登录页和卖家后台不支持采集。');
    } else {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '…' });
      message = await readCurrentProduct(tab);
    }
  } catch (_) {
    message = cleanError('无法读取该页面。请确认已完成登录/验证、页面已加载，再重新点击插件；插件不会绕过网站验证。');
  } finally {
    running.delete(tab.id);
    if (Number.isInteger(tab.id)) try { await chrome.action.setBadgeText({ tabId: tab.id, text: '' }); } catch (_) { /* tab closed */ }
  }
  await finishCapture(message);
});

const devReloadStateKey = 'wyerp_dev_reload_state';

function isTrustedDevReloadSender(sender) {
  if (!Number.isInteger(sender?.tab?.id) || sender.frameId && sender.frameId !== 0) return false;
  try {
    const url = new URL(String(sender.tab.url || ''));
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port === '8765';
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((input, sender, sendResponse) => {
  if (!['wyerp-dev-reload-extension', 'wyerp-dev-tianyan-diagnostic', 'wyerp-tianyan-basic'].includes(input?.type)) return false;
  if (!isTrustedDevReloadSender(sender)) {
    sendResponse({ ok: false, message: '仅允许本机网研ERP触发开发版重载。' });
    return false;
  }
  if (input.type === 'wyerp-tianyan-basic') {
    const clientId = String(input.clientId || '').trim();
    const range = input.range && typeof input.range === 'object' ? { dateFrom: String(input.range.dateFrom || ''), dateTo: String(input.range.dateTo || '') } : null;
    if (!/^[1-9]\d{2,19}$/.test(clientId) || !range || !/^\d{4}-\d{2}-\d{2}$/.test(range.dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(range.dateTo)) {
      sendResponse({ ok: false, message: '天眼读取参数无效。' });
      return false;
    }
    preferredClientOrderErpTabId = sender.tab.id;
    (async () => {
      try {
        const data = await readSellerBasicAnalytics(range, { storeId: clientId }, sender.tab);
        sendResponse({ ok: true, data });
      } catch (error) {
        sendResponse({ ok: false, message: WyCapture.cleanText(error?.message || '天眼基础数据读取失败。', 240) });
      }
    })();
    return true;
  }
  if (input.type === 'wyerp-dev-tianyan-diagnostic') {
    runTianyanDiagnosticFromOpenSeller().then(async result => {
      await chrome.storage.local.set({ wyerp_tianyan_diagnostic_last: { at: new Date().toISOString(), result } });
      sendResponse({ ok: true });
    }).catch(async error => {
      await chrome.storage.local.set({ wyerp_tianyan_diagnostic_last: { at: new Date().toISOString(), result: { ok: false, error: String(error && error.message || error) } } }).catch(() => {});
      sendResponse({ ok: false });
    });
    return true;
  }

  (async () => {
    const tabs = await chrome.tabs.query({});
    const tabIds = tabs
      .filter(tab => Number.isInteger(tab.id) && /^https:\/\/(?:(?:www\.)?ozon\.(?:ru|by|kz)|seller\.(?:ozonru\.cn|ozon\.ru))\//i.test(String(tab.url || '')))
      .map(tab => tab.id);
    if (!tabIds.includes(sender.tab.id)) tabIds.push(sender.tab.id);
    await chrome.storage.local.set({ [devReloadStateKey]: { at: Date.now(), tabIds, erpTabId: sender.tab.id } });
    sendResponse({ ok: true, tabCount: tabIds.length });
    setTimeout(() => chrome.runtime.reload(), 150);
  })().catch(() => sendResponse({ ok: false, message: '开发版重载准备失败。' }));
  return true;
});

(async () => {
  const stored = await chrome.storage.local.get(devReloadStateKey);
  const state = stored?.[devReloadStateKey];
  if (!state) return;
  await chrome.storage.local.remove(devReloadStateKey);
  if (Date.now() - Number(state.at || 0) > 30000 || !Array.isArray(state.tabIds)) return;
  if (Number.isInteger(state.erpTabId)) preferredClientOrderErpTabId = state.erpTabId;
  for (const tabId of state.tabIds) {
    try { await chrome.tabs.reload(tabId); } catch (_) { /* tab closed */ }
  }
})().catch(() => {});
