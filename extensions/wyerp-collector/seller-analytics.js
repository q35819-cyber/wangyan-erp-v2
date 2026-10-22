(function (root, factory) {
  'use strict';
  const api = factory(root.WyCapture);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.WySellerAnalytics = api;
    if (root.document && root.chrome?.runtime?.id) api.watch(root.document, root.location, root.chrome);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const PRESETS = [
    ['today', '今天', 0, 0],
    ['yesterday', '昨天', 1, 1],
    ['7d', '7天', 7, 1],
    ['28d', '28天', 28, 1],
    ['90d', '90天', 90, 1]
  ];

  function isAnalyticsRoute(value) {
    try {
      const page = new URL(String(value || ''));
      const path = page.pathname.length > 1 && page.pathname.endsWith('/') ? page.pathname.slice(0, -1) : page.pathname;
      return page.protocol === 'https:' && ['seller.ozonru.cn','seller.ozon.ru'].includes(page.hostname) && (path === '/app/analytics/graphs' || path.startsWith('/app/analytics/graphs/'));
    } catch (_) { return false; }
  }

  function moscowDay(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('日期无效。');
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
  }

  function dateText(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('日期无效。');
    return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-');
  }

  function rangeForPreset(preset, now) {
    const item = PRESETS.find(entry => entry[0] === preset) || PRESETS[2];
    const base = moscowDay(now || new Date());
    const end = new Date(base.getTime()); end.setUTCDate(end.getUTCDate() - item[3]);
    const start = new Date(base.getTime()); start.setUTCDate(start.getUTCDate() - item[2]);
    return { preset: item[0], label: item[1], dateFrom: dateText(start), dateTo: dateText(end) };
  }

  function formatNumber(value, digits) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits == null ? 4 : digits }).format(number);
  }

  function element(doc, tag, className, textValue) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (textValue != null) node.textContent = String(textValue);
    return node;
  }

  function mount(doc, pageUrl, extension, now) {
    // 如果新 toggle 已存在，不挂载旧面板，避免冲突
    if (doc.getElementById('wyerp-skyeye-toolbar-slot')) return null;
    if (!isAnalyticsRoute(pageUrl)) return null;
    const existing = doc.getElementById('wyerp-seller-analytics');
    if (existing) return existing;

    const rootNode = element(doc, 'section'); rootNode.id = 'wyerp-seller-analytics'; rootNode.dataset.state = 'idle';
    const launcher = element(doc, 'button', 'wyerp-analysis-launcher', '网研ERP 免费分析'); launcher.type = 'button'; launcher.setAttribute('aria-expanded', 'false');
    const panel = element(doc, 'div', 'wyerp-analysis-panel'); panel.hidden = true;
    const header = element(doc, 'header', 'wyerp-analysis-header');
    const identity = element(doc, 'div', 'wyerp-analysis-identity');
    identity.append(element(doc, 'span', 'wyerp-analysis-mark', 'W'), element(doc, 'div', '', null));
    identity.lastElementChild.append(element(doc, 'strong', '', '网研ERP · 基础经营分析'), element(doc, 'small', '', 'Ozon官方Seller API · 不修改Premium状态'));
    const close = element(doc, 'button', 'wyerp-analysis-close', '关闭'); close.type = 'button';
    header.append(identity, close);

    const controls = element(doc, 'div', 'wyerp-analysis-controls');
    const presetGroup = element(doc, 'div', 'wyerp-analysis-presets');
    const presetButtons = [];
    for (const entry of PRESETS) {
      const button = element(doc, 'button', '', entry[1]); button.type = 'button'; button.dataset.preset = entry[0];
      if (entry[0] === '7d') button.dataset.active = 'true';
      presetButtons.push(button); presetGroup.append(button);
    }
    const refresh = element(doc, 'button', 'wyerp-analysis-refresh', '重新读取'); refresh.type = 'button';
    controls.append(presetGroup, refresh);

    const status = element(doc, 'p', 'wyerp-analysis-status', '打开后读取最近7天基础指标。'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const summary = element(doc, 'div', 'wyerp-analysis-summary');
    const summaryFields = [
      ['orderedUnits', '订单商品数量'], ['revenue', '订单金额（平台原值）'], ['productCount', '有数据SKU'], ['range', '统计周期']
    ];
    const summaryValues = new Map();
    for (const [key, label] of summaryFields) {
      const card = element(doc, 'div', 'wyerp-analysis-card'); card.append(element(doc, 'span', '', label));
      const value = element(doc, 'strong', '', '--'); value.dataset.key = key; card.append(value); summary.append(card); summaryValues.set(key, value);
    }

    const tableWrap = element(doc, 'div', 'wyerp-analysis-table-wrap');
    const table = element(doc, 'table', 'wyerp-analysis-table');
    const thead = element(doc, 'thead'); const headRow = element(doc, 'tr');
    for (const label of ['商品 / SKU', '订单商品数量', '订单金额']) headRow.append(element(doc, 'th', '', label));
    thead.append(headRow); const tbody = element(doc, 'tbody'); table.append(thead, tbody); tableWrap.append(table);
    const restricted = element(doc, 'p', 'wyerp-analysis-restricted', 'Premium字段：商品访客、搜索曝光、加购转化、搜索位置等不会绕过权限读取；店铺正式开通后再接入。');
    const source = element(doc, 'p', 'wyerp-analysis-source', '数据来源：等待读取');
    panel.append(header, controls, status, summary, tableWrap, restricted, source); rootNode.append(launcher, panel); (doc.body || doc.documentElement).append(rootNode);

    let currentPreset = '7d'; let loaded = false;
    const bindingChanged = () => {
      loaded = false;
      rootNode.dataset.state = 'idle';
      status.textContent = '店铺已绑定，打开后读取最近7天基础指标。';
      source.textContent = '数据来源：等待读取';
    };
    doc.defaultView?.addEventListener?.('wyerp-seller-store-bound', bindingChanged);
    const setBusy = busy => {
      rootNode.dataset.state = busy ? 'busy' : rootNode.dataset.state === 'error' ? 'error' : 'idle';
      refresh.disabled = busy; for (const button of presetButtons) button.disabled = busy;
    };
    const showError = message => {
      rootNode.dataset.state = 'error'; status.textContent = C.cleanText(message || '基础分析读取失败。', 240); source.textContent = '数据来源：未取得官方数据'; setBusy(false);
    };
    const render = data => {
      const rows = Array.isArray(data?.rows) ? data.rows : [];
      summaryValues.get('orderedUnits').textContent = formatNumber(data?.totals?.orderedUnits, 4);
      summaryValues.get('revenue').textContent = formatNumber(data?.totals?.revenue, 4);
      summaryValues.get('productCount').textContent = formatNumber(rows.length, 0);
      summaryValues.get('range').textContent = (data?.range?.dateFrom || '--') + ' 至 ' + (data?.range?.dateTo || '--');
      tbody.replaceChildren();
      for (const row of rows.slice(0, 1000)) {
        const tr = element(doc, 'tr');
        const product = element(doc, 'td'); product.append(element(doc, 'strong', '', row.name || ('SKU ' + row.sku)), element(doc, 'small', '', 'SKU：' + (row.sku || '--')));
        tr.append(product, element(doc, 'td', '', formatNumber(row.orderedUnits, 4)), element(doc, 'td', '', formatNumber(row.revenue, 4))); tbody.append(tr);
      }
      if (!rows.length) {
        const tr = element(doc, 'tr'); const td = element(doc, 'td', 'wyerp-analysis-empty', '该周期没有返回商品数据。'); td.colSpan = 3; tr.append(td); tbody.append(tr);
      }
      const extra = data?.limited ? '；最多显示1000个SKU' : '';
      status.textContent = '读取完成：' + rows.length + '个SKU' + extra + '。官方接口每分钟最多读取一次。';
      source.textContent = '数据来源：Ozon官方Seller API /v1/analytics/data；仅基础指标 ordered_units、revenue。';
      rootNode.dataset.state = 'success'; setBusy(false);
    };
    const load = async preset => {
      currentPreset = preset || currentPreset;
      for (const button of presetButtons) button.dataset.active = String(button.dataset.preset === currentPreset);
      const range = rangeForPreset(currentPreset, now || new Date());
      setBusy(true); status.textContent = '正在通过网研ERP读取 ' + range.dateFrom + ' 至 ' + range.dateTo + ' 的官方基础指标…';
      try {
        const response = await extension.runtime.sendMessage({ type: 'read-seller-basic-analytics', range });
        if (!response?.ok) throw new Error(response?.message || '基础分析读取失败。');
        render(response.data);
      } catch (error) { showError(error?.message || '基础分析读取失败。'); }
    };
    launcher.addEventListener('click', () => {
      panel.hidden = !panel.hidden; launcher.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) {
        const binder = doc.getElementById('wyerp-seller-binder'); const binderPanel = binder?.querySelector(':scope > div'); const binderButton = binder?.querySelector(':scope > button');
        if (binderPanel) binderPanel.hidden = true; if (binderButton) binderButton.setAttribute('aria-expanded', 'false');
        if (!loaded) { loaded = true; load(currentPreset); }
      }
    });
    close.addEventListener('click', () => { panel.hidden = true; launcher.setAttribute('aria-expanded', 'false'); launcher.focus(); });
    refresh.addEventListener('click', () => load(currentPreset));
    for (const button of presetButtons) button.addEventListener('click', () => load(button.dataset.preset));
    rootNode.__wyerpLoad = load;
    return rootNode;
  }

  function watch(doc, locationObject, extension) {
    const scope = typeof globalThis !== 'undefined' ? globalThis : null;
    const sync = () => {
      const href = String(locationObject?.href || '');
      const current = doc.getElementById('wyerp-seller-analytics');
      if (isAnalyticsRoute(href)) mount(doc, href, extension);
      else if (current) current.remove();
    };
    sync();
    const timer = setInterval(sync, 700);
    scope?.addEventListener?.('popstate', sync);
    return { stop() { clearInterval(timer); scope?.removeEventListener?.('popstate', sync); }, sync };
  }

  return { PRESETS, isAnalyticsRoute, rangeForPreset, formatNumber, mount, watch };
});
