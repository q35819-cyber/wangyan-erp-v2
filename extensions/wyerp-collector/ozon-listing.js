'use strict';

(() => {
  const WIDGET_ATTR = 'data-wyerp-listing-sku';
  const MAX_BATCH_SIZE = 8;
  const MAX_CONCURRENT = 8;
  const MAX_PUBLIC_CONCURRENT = 2;
  const REQUEST_GAP_MS = 100;
  const PREFETCH_DISTANCE_PX = 0;
  const CHANNEL_TIMEOUT_MS = 15000;
  const RATE_LIMIT_BACKOFF_MS = 8000;
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_KEY_PREFIX = 'wyerp_listing_sku_snapshot_v2:';
  const OZON_CACHE_KEY_PREFIX = 'wyerp_listing_ozon_offers_cache_v2:';
  const MIN_CACHE_METRICS = 15;
  const SINGLE_SKU_FIELDS = [
    ['productTitle', '商品名称'], ['category', '类目'], ['commission', '类目佣金'], ['fulfillment', '发货模式'],
    ['sku', 'SKU'], ['brand', '品牌'], ['sellerType', '卖家类型'], ['reviewCount', '评论数'],
    ['reviewRating', '商品评分'], ['questionCount', '问题数'], ['dailySales', '日销量'], ['monthlyUnits', '月销量'],
    ['monthlyRevenue', '月销售额'], ['stock', '库存'], ['marketPrice', '商品价格'], ['grossMargin', '毛利率'],
    ['turnover', '月销售额环比'], ['advertising', '广告费占比'], ['promotionDays', '参与促销天数'],
    ['promotionDiscount', '参与促销的折扣'], ['promotionConversion', '促销活动的转化率'],
    ['paidPromotionDays', '付费推广天数'], ['cardViews', '商品卡浏览量'], ['cardCartRate', '商品卡加购率'],
    ['searchViews', '搜索目录浏览量'], ['searchCartRate', '搜索目录加购率'], ['impressionConversion', '展示转化率'],
    ['productClickRate', '商品点击率'], ['orderConversionRate', '下单转化率'], ['returnRate', '退货取消率'],
    ['dimensions', '长 宽 高'], ['weight', '重 量'], ['listedAt', '上架时间'], ['upDays', '上架天数'],
    ['upMonths', '上架月数'], ['variantCount', '变体数量'], ['volume', '体积'], ['competitorLow', '跟卖最低价'],
    ['competitorHigh', '跟卖最高价'], ['competitors', '跟卖列表']
  ].map(([key, label]) => ({ key, label, keys: [key], labels: [label] }));
  const queue = [];
  const queued = new Set();
  const active = new Set();
  const pending = new Set();
  const deferred = new Set();
  const cacheReads = new Map();
  let running = 0;
  let scanTimer = 0;
  let lastStartedAt = 0;
  let rateLimitUntil = 0;
  const seerfarWaiters = new Map();
  let seerfarBatchTimer = 0;
  let seerfarBatchRunning = false;

  function withTimeout(promise, timeoutMs, message) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]).finally(() => window.clearTimeout(timer));
  }

  function scheduleSeerfarBatch(delay = 30) {
    if (seerfarBatchTimer) return;
    seerfarBatchTimer = window.setTimeout(flushSeerfarBatch, delay);
  }

  async function flushSeerfarBatch() {
    seerfarBatchTimer = 0;
    if (seerfarBatchRunning) { scheduleSeerfarBatch(100); return; }
    const now = Date.now();
    const batch = [...seerfarWaiters.values()].filter(item => !item.inRequest && item.nextPollAt <= now).slice(0, MAX_BATCH_SIZE);
    if (!batch.length) {
      const next = Math.min(...[...seerfarWaiters.values()].map(item => item.nextPollAt));
      if (Number.isFinite(next)) scheduleSeerfarBatch(Math.max(100, next - now));
      return;
    }
    seerfarBatchRunning = true;
    batch.forEach(item => { item.inRequest = true; });
    try {
      const response = await withTimeout(
        chrome.runtime.sendMessage({ type: 'enrich-ozon-listing-skus', items: batch.map(item => ({ sku: item.sku, productUrl: item.productUrl })) }),
        CHANNEL_TIMEOUT_MS,
        'Seerfar批量状态读取超时。'
      );
      if (!response?.ok) throw new Error(response?.message || 'ERP没有返回Seerfar批量数据。');
      const bySku = new Map((response.items || []).map(item => [String(item.sku), item]));
      for (const waiting of batch) {
        const item = bySku.get(waiting.sku);
        if (item?.status === 'ready' && item.analytics) {
          seerfarWaiters.delete(waiting.sku); waiting.resolve(item.analytics);
        } else if (item?.status === 'failed') {
          seerfarWaiters.delete(waiting.sku); waiting.reject(new Error(item.message || 'Seerfar数据读取失败。'));
        } else if (!item) {
          waiting.missingCount = Number(waiting.missingCount || 0) + 1;
          if (waiting.missingCount >= 2) {
            seerfarWaiters.delete(waiting.sku);
            waiting.reject(new Error('Seerfar批量响应未返回当前SKU。'));
          } else {
            waiting.inRequest = false;
            waiting.nextPollAt = Date.now() + 1000;
            widgetsForSku(waiting.sku).forEach(widget => { widget.querySelector('.wyerp-listing-status').textContent = '服务器排队读取中'; });
          }
        } else {
          waiting.missingCount = 0;
          waiting.inRequest = false;
          waiting.nextPollAt = Date.now() + Math.max(1000, Math.min(5000, Number(item?.retryAfterSeconds || response.retryAfterSeconds || 2) * 1000));
          widgetsForSku(waiting.sku).forEach(widget => { widget.querySelector('.wyerp-listing-status').textContent = '服务器排队读取中'; });
        }
      }
    } catch (error) {
      for (const waiting of batch) {
        seerfarWaiters.delete(waiting.sku);
        waiting.reject(error);
      }
    } finally {
      seerfarBatchRunning = false;
      if (seerfarWaiters.size) scheduleSeerfarBatch(30);
    }
  }

  function readSeerfar(job) {
    const existing = seerfarWaiters.get(job.sku);
    if (existing) return existing.promise;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    seerfarWaiters.set(job.sku, { sku: job.sku, productUrl: job.productUrl, promise, resolve: resolvePromise, reject: rejectPromise, nextPollAt: 0, inRequest: false, missingCount: 0 });
    scheduleSeerfarBatch();
    return promise;
  }

  const fields = [
    { label: '类目', labels: ['类目'], keys: ['category'] },
    { label: 'rFBS佣金', labels: ['rFBS佣金', '卖家自配送佣金'], keys: ['rfbsCommission', 'commission'] },
    { label: 'SKU', labels: ['SKU', '商品编号'], keys: ['productId', 'sku'] },
    { label: '品牌', labels: ['品牌'], keys: ['brand'] },
    { label: '月销量', labels: ['月销量'], keys: ['monthlySales', 'sold'] },
    { label: '月销售额', labels: ['月销售额'], keys: ['monthlyRevenue', 'soldSum'] },
    { label: '月周转动态', labels: ['月周转动态', '月销售额环比'], keys: ['monthlyTurnover', 'turnoverDynamics'] },
    { label: '广告费占比', labels: ['广告费占比'], keys: ['advertisingShare'] },
    { label: '参与促销天数', labels: ['参与促销天数'], keys: ['promotionDays'] },
    { label: '参与促销的折扣', labels: ['参与促销的折扣'], keys: ['promotionDiscount'] },
    { label: '促销活动的转化率', labels: ['促销活动的转化率'], keys: ['promotionConversion'] },
    { label: '付费推广天数', labels: ['付费推广天数'], keys: ['paidPromotionDays'] },
    { label: '商品卡浏览量', labels: ['商品卡浏览量'], keys: ['productViews'] },
    { label: '商品卡加购率', labels: ['商品卡加购率'], keys: ['productCartRate'] },
    { label: '搜索目录浏览量', labels: ['搜索目录浏览量'], keys: ['searchViews'] },
    { label: '搜索目录加购率', labels: ['搜索目录加购率'], keys: ['searchCartRate'] },
    { label: '展示转化率', labels: ['展示转化率'], keys: ['displayConversion'] },
    { label: '商品点击率', labels: ['商品点击率'], keys: ['clickRate'] },
    { label: '发货模式', labels: ['发货模式'], keys: ['fulfillment'] },
    { label: '退货取消率', labels: ['退货取消率'], keys: ['returnRate'] },
    { label: '长 宽 高', labels: ['长 宽 高'], keys: ['dimensions'] },
    { label: '重 量', labels: ['重 量'], keys: ['weight'] },
    { label: '上架时间', labels: ['上架时间'], keys: ['listedAt'] },
    { label: '跟卖列表', labels: ['跟卖列表'], keys: ['competitorSellers'] },
    { label: '跟卖最低价', labels: ['跟卖最低价'], keys: ['competitorMin'] },
    { label: '跟卖最高价', labels: ['跟卖最高价'], keys: ['competitorMax'] }
  ];

  function normalize(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function usable(value) {
    const text = normalize(value).toLowerCase();
    return text && !['未获取', '暂无数据', '--', '-', 'null', 'undefined', 'n/a'].includes(text);
  }

  function skuFromUrl(url) {
    try {
      const path = new URL(url, location.href).pathname;
      return path.match(/(?:-|\/)(\d{6,20})\/?$/)?.[1] || '';
    } catch (_) {
      return '';
    }
  }

  function cardForAnchor(anchor, sku) {
    let node = anchor.parentElement;
    let best = null;
    for (let depth = 0; node && depth < 12 && node !== document.body; depth += 1, node = node.parentElement) {
      const skus = new Set([...node.querySelectorAll('a[href*="/product/"]')]
        .map(link => skuFromUrl(link.href))
        .filter(Boolean));
      if (skus.size > 1) break;
      const rect = node.getBoundingClientRect();
      // Ozon store pages now use wider responsive grid cards; still reject containers with multiple products.
      if (skus.has(sku) && rect.width >= 110 && rect.width <= 920 && rect.height >= 65) best = node;
    }
    return best || anchor.closest('[data-index]');
  }

  function productCards() {
    // The old paginator can exist alongside the current store grid without containing its cards.
    const root = document;
    const found = new Map();
    for (const anchor of root.querySelectorAll('a[href*="/product/"]')) {
      const sku = skuFromUrl(anchor.href);
      const card = sku ? cardForAnchor(anchor, sku) : null;
      if (!sku || !card || found.has(card)) continue;
      found.set(card, { card, sku, productUrl: new URL(anchor.href, location.href).href });
    }
    return [...found.values()];
  }

  function button(text, title, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'wyerp-listing-tool';
    node.textContent = text;
    node.title = title;
    node.setAttribute('aria-label', title);
    node.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return node;
  }

  function open(url) {
    window.open(url, '_blank', 'noopener');
  }

  function createWidget(sku, productUrl) {
    const wrapper = document.createElement('section');
    wrapper.className = 'wyerp-listing-widget';
    wrapper.setAttribute(WIDGET_ATTR, sku);

    const header = document.createElement('header');
    header.className = 'wyerp-listing-header';
    const brand = document.createElement('strong');
    brand.className = 'wyerp-listing-brand';
    brand.textContent = 'W 网研ERP';
    const tools = document.createElement('div');
    tools.className = 'wyerp-listing-tools';
    const encodedProduct = encodeURIComponent(productUrl);
    tools.append(
      button('↑', '一键上架', () => open('http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fgoods.html&mode=quick&sku=' + sku + '&source=' + encodedProduct)),
      button('✎', '编辑上架', () => open('http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fgoods.html&mode=edit&sku=' + sku + '&source=' + encodedProduct)),
      button('¥', '计算利润', () => open('http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fprofit.html&sku=' + sku)),
      button('⌕', '打开商品', () => open(productUrl)),
      button('⚙', '设置选品', () => open('http://127.0.0.1:8765/workspace.html?open=%2Fpages%2Fsource-pick.html&sku=' + sku))
    );
    header.append(brand, tools);

    const status = document.createElement('div');
    status.className = 'wyerp-listing-status';
    status.textContent = '等待读取';
    const data = document.createElement('dl');
    data.className = 'wyerp-listing-data';
    wrapper.append(header, status, data);
    render(wrapper, {
      status: 'loading',
      productId: sku,
      metrics: SINGLE_SKU_FIELDS.map(field => ({ key: field.key, value: '正在获取' })),
      sources: [],
      warnings: []
    });
    status.textContent = '正在获取';
    status.classList.remove('is-warning');
    return wrapper;
  }

  function insertWidget(card, sku, productUrl) {
    const direct = [...card.children].find(node => node.hasAttribute?.(WIDGET_ATTR));
    if (direct?.getAttribute(WIDGET_ATTR) === sku) {
      if (direct.dataset.loaded !== '1') {
        observer.unobserve(direct);
        observer.observe(direct);
      }
      return direct;
    }
    if (direct) direct.remove();
    const widget = createWidget(sku, productUrl);
    const title = [...card.querySelectorAll('a[href*="/product/"]')]
      .map(link => normalize(link.textContent))
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)[0] || '';
    widget.dataset.productTitle = title;
    card.append(widget);
    observer.observe(widget);
    return widget;
  }

  function findMetric(metrics, field, index) {
    const byLabel = metrics.find(metric => field.labels.includes(normalize(metric?.label).replace(/[:：]$/, '')));
    if (byLabel) return byLabel;
    const keys = field.keys.map(key => key.toLowerCase());
    const byKey = metrics.find(metric => keys.includes(normalize(metric?.key).toLowerCase()));
    return byKey || null;
  }

  function listedWithAge(value) {
    const text = normalize(value);
    const match = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (!match) return text;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (!Number.isFinite(date.getTime())) return text;
    const today = new Date();
    const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const days = Math.max(0, Math.floor((utcToday - date.getTime()) / 86400000));
    return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}(${days}天)`;
  }

  function appendValue(row, field, rawValue, hoverTitle = '') {
    const value = field.label === '上架时间' ? listedWithAge(rawValue) : normalize(rawValue);
    if (field.label === '类目佣金' && usable(value)) {
      const badges = document.createElement('span');
      badges.className = 'wyerp-listing-commissions';
      const parts = value.split(/[,/|\s]+/).filter(part => /%/.test(part));
      const ranges = ['不超过1500₽', '超过1500₽且不超过5000₽', '超过5000₽'];
      for (const [index, part] of parts.slice(0, 3).entries()) {
        const badge = document.createElement('b');
        badge.textContent = part;
        badge.title = `${ranges[index]}：${part}`;
        badges.append(badge);
      }
      if (badges.children.length) {
        badges.title = hoverTitle || ranges.map((range, index) => `${range}：${parts[index] || '未获取'}`).join('；');
        row.append(badges);
        return;
      }
    }
    const output = document.createElement('dd');
    output.textContent = usable(value) ? value : '未获取';
    if (usable(value)) output.title = hoverTitle || value;
    if ((field.label === '月周转动态' || field.label === '月销售额环比') && /^[+-]/.test(value)) output.className = value.startsWith('+') ? 'is-positive' : 'is-negative';
    row.append(output);
  }

  function validMetricCount(analytics) {
    return (Array.isArray(analytics?.metrics) ? analytics.metrics : [])
      .filter(metric => usable(metric?.raw ?? metric?.value)).length;
  }

  function offerPrice(value) {
    const normalized = normalize(value).replace(/\s+/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const number = Number(normalized);
    return Number.isFinite(number) ? number : Number.POSITIVE_INFINITY;
  }

  function appendCompetitorList(row, marketOffers, widget) {
    const sellers = Array.isArray(marketOffers?.sellers) ? marketOffers.sellers : [];
    const sorted = sellers.slice().sort((left, right) => {
      const leftWithoutReviews = Number(left?.reviewsCount) > 0 ? 0 : 1;
      const rightWithoutReviews = Number(right?.reviewsCount) > 0 ? 0 : 1;
      return leftWithoutReviews - rightWithoutReviews || offerPrice(left?.price) - offerPrice(right?.price);
    }).slice(0, 50);
    const numericTotal = Number(marketOffers?.offerCount);
    const total = Number.isFinite(numericTotal) ? Math.max(0, Math.trunc(numericTotal)) : sellers.length;
    const output = document.createElement('dd');
    output.className = 'wyerp-market-competitors';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'wyerp-market-competitor-trigger';
    trigger.textContent = `公开列表（${total}）`;
    trigger.title = `查看公开跟卖信息，共${total}条，最多显示50条`;
    trigger.addEventListener('click', () => {
      document.getElementById('wyerp-listing-competitor-modal')?.remove();
      const modal = document.createElement('div');
      modal.id = 'wyerp-listing-competitor-modal';
      modal.className = 'wyerp-market-competitor-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'false');
      modal.setAttribute('aria-label', '公开跟卖列表');
      const dialog = document.createElement('section');
      dialog.className = 'wyerp-market-competitor-dialog';
      const header = document.createElement('header');
      header.className = 'wyerp-market-competitor-dialog-header';
      const title = document.createElement('strong');
      title.textContent = `公开跟卖列表（${total}）`;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'wyerp-market-competitor-close';
      close.textContent = '关闭';
      const dismiss = () => { modal.remove(); document.removeEventListener('keydown', onKeyDown); };
      const onKeyDown = event => { if (event.key === 'Escape') dismiss(); };
      close.addEventListener('click', dismiss);
      modal.addEventListener('click', event => { if (event.target === modal) dismiss(); });
      document.addEventListener('keydown', onKeyDown);
      header.append(title, close);
      const body = document.createElement('div');
      body.className = 'wyerp-market-competitor-dialog-body';
      const list = document.createElement('div');
      list.className = 'wyerp-market-competitor-list';
      for (const seller of sorted) {
        const offer = document.createElement('div');
        offer.className = 'wyerp-market-competitor';
        const storeTarget = seller.sellerUrl || seller.productUrl;
        const productTarget = seller.productUrl || seller.sellerUrl;
        const storeName = normalize(seller.name) || `店铺 ${normalize(seller.sellerId)}`;
        const avatarFallback = () => {
          const fallback = document.createElement('span');
          fallback.className = 'wyerp-market-store-avatar wyerp-market-store-avatar-fallback';
          fallback.textContent = Array.from(storeName || '店')[0]?.toUpperCase() || '店';
          return fallback;
        };
        let avatar = avatarFallback();
        if (seller.logoImageUrl) {
          avatar = document.createElement('img');
          avatar.className = 'wyerp-market-store-avatar';
          avatar.src = seller.logoImageUrl;
          avatar.alt = `${storeName} 店铺头像`;
          avatar.loading = 'lazy';
          avatar.referrerPolicy = 'no-referrer';
          avatar.addEventListener('error', () => avatar.replaceWith(avatarFallback()), { once: true });
        }
        const store = document.createElement(storeTarget ? 'a' : 'span');
        store.className = 'wyerp-market-store-link';
        store.textContent = storeName;
        store.title = storeName;
        if (storeTarget) { store.href = storeTarget; store.target = '_blank'; store.rel = 'noopener noreferrer'; }
        const sku = document.createElement(productTarget ? 'a' : 'span');
        sku.className = 'wyerp-market-sku-link';
        sku.textContent = seller.sellerSku ? `SKU ${seller.sellerSku}` : 'SKU未提供';
        if (productTarget) { sku.href = productTarget; sku.target = '_blank'; sku.rel = 'noopener noreferrer'; sku.title = `打开该卖家的商品：${seller.sellerSku || ''}`; }
        const price = document.createElement('span');
        price.className = 'wyerp-market-offer-price';
        price.textContent = seller.price || '价格未提供';
        price.title = price.textContent;
        const reviewsCount = Number(seller.reviewsCount);
        const reviews = document.createElement('span');
        reviews.className = 'wyerp-market-offer-reviews';
        reviews.textContent = `评论 ${Number.isFinite(reviewsCount) ? Math.max(0, Math.trunc(reviewsCount)) + ' 条' : '未获取'}`;
        offer.append(avatar, store, sku, price, reviews);
        list.append(offer);
      }
      if (!sorted.length) {
        const empty = document.createElement('p');
        empty.className = 'wyerp-market-missing';
        empty.textContent = '当前公开报价列表为空';
        list.append(empty);
      }
      body.append(list);
      dialog.append(header, body);
      modal.append(dialog);
      document.body.append(modal);
      close.focus();
    });
    output.append(trigger);
    row.append(output);
  }

  function render(widget, analytics, source = '', marketOffers = null) {
    const metrics = Array.isArray(analytics?.metrics) ? analytics.metrics : [];
    const list = widget.querySelector('.wyerp-listing-data');
    list.replaceChildren();
    const knownKeys = new Set(SINGLE_SKU_FIELDS.map(field => field.key));
    const orderedFields = [...SINGLE_SKU_FIELDS];
    for (const metric of metrics) {
      const key = normalize(metric?.key);
      if (!key || knownKeys.has(key)) continue;
      const label = normalize(metric?.label) || key;
      orderedFields.push({ key, label, keys: [key], labels: [label] });
      knownKeys.add(key);
    }
    orderedFields.forEach((field, index) => {
      const metric = findMetric(metrics, field, index);
      const row = document.createElement('div');
      row.className = 'wyerp-listing-row';
      const term = document.createElement('dt');
      term.textContent = field.label + '：';
      term.title = field.label;
      row.append(term);
      const value = field.label === 'SKU'
        ? widget.getAttribute(WIDGET_ATTR)
        : field.label === '商品名称'
          ? metric?.raw ?? metric?.value ?? widget.dataset.productTitle
          : metric?.raw ?? metric?.value;
      if (field.key === 'competitors' && marketOffers) appendCompetitorList(row, marketOffers, widget);
      else appendValue(row, field, value, metric?.title || '');
      list.append(row);
    });
    const validCount = validMetricCount(analytics);
    const status = widget.querySelector('.wyerp-listing-status');
    status.textContent = validCount >= MIN_CACHE_METRICS
      ? `${source === 'cache' ? '缓存命中' : '已读取'} ${validCount}/${orderedFields.length} 项`
      : `仅返回 ${validCount}/${orderedFields.length} 项，未缓存`;
    status.classList.toggle('is-warning', validCount < MIN_CACHE_METRICS);
  }

  function renderError(widget, message) {
    const status = widget.querySelector('.wyerp-listing-status');
    render(widget, { metrics: [] });
    status.textContent = normalize(message) || '读取失败';
    status.classList.add('is-warning');
  }

  function widgetsForSku(sku) {
    return [...document.querySelectorAll(`[${WIDGET_ATTR}="${sku}"]`)];
  }

  async function readCache(sku) {
    if (cacheReads.has(sku)) return cacheReads.get(sku);
    const task = (async () => {
      const key = CACHE_KEY_PREFIX + sku;
      try {
        const entry = (await chrome.storage.local.get(key))?.[key];
        const at = Number(entry?.at);
        const validTime = Number.isFinite(at) && at <= Date.now() + 60000 && Date.now() - at < CACHE_TTL_MS;
        const validSku = String(entry?.sku || entry?.analytics?.productId || '') === sku;
        if (validTime && validSku && validMetricCount(entry.analytics) >= MIN_CACHE_METRICS) return entry;
        if (entry) await chrome.storage.local.remove(key);
      } catch (_) {
        // A cache failure falls through to the live request queue.
      }
      return null;
    })();
    cacheReads.set(sku, task);
    return task;
  }

  async function writeCache(sku, analytics, marketOffers) {
    const key = CACHE_KEY_PREFIX + sku;
    try {
      const snapshot = { at: Date.now(), sku, analytics, marketOffers: marketOffers || null };
      await chrome.storage.local.set({ [key]: snapshot });
      cacheReads.set(sku, Promise.resolve(snapshot));
    } catch (_) {
      // Rendering must not depend on browser cache availability.
    }
  }

  function mergeAnalytics(...parts) {
    const available = parts.filter(Boolean);
    const metrics = new Map();
    const sources = new Map();
    const warnings = new Set();
    for (const part of available) {
      for (const metric of part.metrics || []) if (metric?.key) metrics.set(metric.key, metric);
      for (const source of part.sources || []) if (source?.id) sources.set(source.id, source);
      for (const warning of part.warnings || []) if (warning) warnings.add(warning);
    }
    return {
      ...(available[available.length - 1] || {}),
      metrics: [...metrics.values()],
      sources: [...sources.values()],
      warnings: [...warnings]
    };
  }

  function listingCardAnalytics(job) {
    const card = job.card;
    const capturedAt = new Date().toISOString();
    const metrics = [];
    const add = (key, value) => {
      if (!usable(value) || metrics.some(item => item.key === key)) return;
      metrics.push({ key, value: normalize(value), provider: 'ozon_public_listing', capturedAt });
    };
    add('sku', job.sku);
    if (!card) return { status: 'partial', productId: job.sku, capturedAt, metrics, sources: [], warnings: [] };

    const titleCandidates = [...card.querySelectorAll('a[href*="/product/"]')]
      .filter(anchor => skuFromUrl(anchor.href) === job.sku)
      .map(anchor => normalize(anchor.textContent || anchor.getAttribute('aria-label') || anchor.getAttribute('title')))
      .filter(value => value && !/(?:скидки\s+недели|0\s*%\s*до|цена\s+что\s+надо)/i.test(value))
      .sort((left, right) => right.length - left.length);
    add('productTitle', titleCandidates[0]);

    const cardText = normalize(card.innerText || card.textContent);
    const reviewsMatch = cardText.match(/([0-5](?:[.,]\d)?)\s+([\d\s\u00a0\u202f]+)\s+(?:отзыв|отзыва|отзывов)(?=\s|$)/i);
    if (reviewsMatch) {
      add('reviewRating', reviewsMatch[1].replace(',', '.'));
      add('reviewCount', reviewsMatch[2].replace(/[\s\u00a0\u202f]/g, ''));
    }
    const stockMatch = cardText.match(/([\d\s\u00a0\u202f]+)\s*шт\s+осталось(?=\s|$)/i);
    if (stockMatch) add('stock', stockMatch[1].replace(/[\s\u00a0\u202f]/g, ''));
    return {
      status: metrics.length > 1 ? 'partial' : 'unavailable',
      productId: job.sku,
      capturedAt,
      metrics,
      sources: [{ id: 'ozon_public_listing', label: 'Ozon当前列表卡片', kind: 'public_page_observed', capturedAt }],
      warnings: []
    };
  }

  async function readPublicOffers(job, cardAnalytics) {
    const key = OZON_CACHE_KEY_PREFIX + job.sku;
    let staleRecord = null;
    try {
      const entry = (await chrome.storage.local.get(key))?.[key];
      const age = Date.now() - Number(entry?.at || 0);
      const matchesSku = entry?.record?.source?.productId === job.sku;
      const offerCount = Number(entry?.record?.marketOffers?.offerCount || 0);
      const sellerCount = Array.isArray(entry?.record?.marketOffers?.sellers) ? entry.record.marketOffers.sellers.length : 0;
      const usefulRecord = validMetricCount(entry?.record?.analytics) > 0 || offerCount > 0 || sellerCount > 0;
      if (matchesSku && usefulRecord) staleRecord = entry.record;
      if (matchesSku && usefulRecord && age >= 0 && age < CACHE_TTL_MS) return entry.record;
    } catch (_) {
      // Continue with the live Ozon public request.
    }
    const api = globalThis.WyOzonPublic;
    if (!api?.enrichOffers) throw new Error('Ozon公开报价模块未加载。');
    try {
      const record = await api.enrichOffers({
        schemaVersion: 1,
        source: { platform: 'ozon', productId: job.sku, url: job.productUrl, capturedAt: new Date().toISOString() },
        analytics: cardAnalytics,
        marketOffers: { sellerNames: [], sellers: [], evidence: [] }
      }, { fetch: window.fetch.bind(window), origin: location.origin });
      const offerCount = Number(record?.marketOffers?.offerCount || 0);
      const sellerCount = Array.isArray(record?.marketOffers?.sellers) ? record.marketOffers.sellers.length : 0;
      if (validMetricCount(record?.analytics) > 0 || offerCount > 0 || sellerCount > 0) {
        await chrome.storage.local.set({ [key]: { at: Date.now(), record } });
        return record;
      }
      return staleRecord || record;
    } catch (error) {
      if (staleRecord) return staleRecord;
      throw error;
    }
  }

  function releasePipelineSlot(job) {
    if (!active.delete(job.sku)) return;
    running = Math.max(0, running - 1);
    drain();
    promoteDeferred();
  }

  let publicRunning = 0;
  const publicQueue = [];

  function drainPublicQueue() {
    while (publicRunning < MAX_PUBLIC_CONCURRENT && publicQueue.length) {
      const item = publicQueue.shift();
      publicRunning += 1;
      Promise.resolve()
        .then(() => withTimeout(
          readPublicOffers(item.job, item.cardAnalytics),
          CHANNEL_TIMEOUT_MS,
          'Ozon公开报价读取超时。'
        ))
        .then(item.resolve, item.reject)
        .finally(() => {
          publicRunning = Math.max(0, publicRunning - 1);
          drainPublicQueue();
        });
    }
  }

  function schedulePublicOffers(job, cardAnalytics) {
    return new Promise((resolve, reject) => {
      publicQueue.push({ job, cardAnalytics, resolve, reject });
      drainPublicQueue();
    });
  }

  async function load(job) {
    const widgets = widgetsForSku(job.sku).filter(widget => widget.isConnected);
    if (!widgets.length) return;
    widgets.forEach(widget => {
      widget.querySelector('.wyerp-listing-status').textContent = job.cachedSnapshot
        ? '完整缓存已显示'
        : '正在读取';
    });
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const cardAnalytics = listingCardAnalytics(job);
        let latestSeerfar = job.cachedSnapshot?.analytics || null;
        let latestPublic = null;
        const paintProgress = (message) => {
          const partial = mergeAnalytics(job.cachedSnapshot?.analytics, latestPublic?.analytics, cardAnalytics, latestSeerfar);
          const partialOffers = latestPublic?.marketOffers || job.cachedSnapshot?.marketOffers || null;
          const partialCount = validMetricCount(partial);
          if (!partialCount) return;
          widgetsForSku(job.sku).forEach(widget => {
            render(widget, partial, '', partialOffers);
            widget.querySelector('.wyerp-listing-status').textContent = `${message} ${partialCount}/40 项`;
          });
        };
        if (!job.cachedSnapshot) paintProgress('Ozon页面已读取，正在补充');
        const seerfarTask = job.cachedSnapshot
          ? Promise.resolve(job.cachedSnapshot.analytics)
          : readSeerfar(job);
        const publicTask = schedulePublicOffers(job, cardAnalytics);
        seerfarTask.then(value => {
          latestSeerfar = value;
          paintProgress('Seerfar已读取，正在补充');
        }).catch(() => undefined);
        publicTask.then(value => {
          latestPublic = value;
          paintProgress('Ozon已读取，正在补充');
        }).catch(() => undefined);
        const [seerfarResult, publicResult] = await Promise.allSettled([seerfarTask, publicTask]);
        const seerfarAnalytics = seerfarResult.status === 'fulfilled' ? seerfarResult.value : null;
        let publicRecord = publicResult.status === 'fulfilled' ? publicResult.value : null;
        if (seerfarResult.status === 'rejected' && publicRecord && globalThis.WyOzonPublic?.enrich) {
          try {
            publicRecord = await globalThis.WyOzonPublic.enrich(publicRecord, {
              fetch: window.fetch.bind(window), origin: location.origin
            });
            await chrome.storage.local.set({
              [OZON_CACHE_KEY_PREFIX + job.sku]: { at: Date.now(), record: publicRecord }
            });
          } catch (_) {
            // Keep the already loaded Ozon offer data when full public data is unavailable.
          }
        }
        const analytics = mergeAnalytics(job.cachedSnapshot?.analytics, publicRecord?.analytics, cardAnalytics, seerfarAnalytics);
        const marketOffers = publicRecord?.marketOffers || job.cachedSnapshot?.marketOffers || null;
        const count = validMetricCount(analytics);
        if (!count) {
          throw new Error(seerfarResult.status === 'rejected'
            ? seerfarResult.reason?.message || 'ERP没有返回Seerfar数据。'
            : publicResult.status === 'rejected'
              ? publicResult.reason?.message || 'Ozon公开报价读取失败。'
              : '两个数据源均未返回有效数据。');
        }
        releasePipelineSlot(job);
        if (count >= MIN_CACHE_METRICS) await writeCache(job.sku, analytics, marketOffers);
        widgetsForSku(job.sku).forEach(widget => {
          render(widget, analytics, '', marketOffers);
          if (count < MIN_CACHE_METRICS && seerfarResult.status === 'rejected') {
            const reason = normalize(seerfarResult.reason?.message || 'Seerfar未返回有效数据。');
            widget.querySelector('.wyerp-listing-status').textContent = `Ozon已读取 ${count} 项；${reason}`;
          }
        });
        return;
      } catch (error) {
        lastError = error;
        const message = normalize(error?.message);
        const rateLimited = /请求过于频繁|稍后再试|频繁|429/.test(message);
        const retryable = rateLimited || /读取Seerfar数据超过|ERP页面数据请求失败|Seerfar接口.*(?:超时|未返回)|数据源暂时不可用|网络请求失败/.test(message);
        if (!retryable || attempt > 0) break;
        widgetsForSku(job.sku).forEach(widget => {
          widget.querySelector('.wyerp-listing-status').textContent = rateLimited
            ? '接口限流，稍后自动重试'
            : '首次读取超时，正在从服务器缓存补读';
        });
        if (rateLimited) {
          rateLimitUntil = Math.max(rateLimitUntil, Date.now() + RATE_LIMIT_BACKOFF_MS);
          const jitter = Number(job.sku.slice(-2)) % 4 * REQUEST_GAP_MS;
          while (Date.now() < rateLimitUntil) {
            await new Promise(resolve => setTimeout(resolve, Math.max(100, rateLimitUntil - Date.now()) + jitter));
          }
        } else {
          await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }
    }
    if (job.cachedSnapshot) {
      releasePipelineSlot(job);
      widgetsForSku(job.sku).forEach(widget => {
        render(widget, job.cachedSnapshot.analytics, 'cache', job.cachedSnapshot.marketOffers || null);
        widget.querySelector('.wyerp-listing-status').textContent = '完整缓存已显示，本次更新失败';
      });
      return;
    }
    releasePipelineSlot(job);
    widgetsForSku(job.sku).forEach(widget => renderError(widget, lastError?.message));
  }

  async function drain() {
    while (running < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      queued.delete(job.sku);
      if (active.has(job.sku)) continue;
      const wait = Math.max(0, REQUEST_GAP_MS - (Date.now() - lastStartedAt), rateLimitUntil - Date.now());
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      running += 1;
      active.add(job.sku);
      lastStartedAt = Date.now();
      load(job).finally(() => {
        releasePipelineSlot(job);
      });
    }
  }

  async function enqueue(widget) {
    const sku = widget.getAttribute(WIDGET_ATTR);
    if (!sku || pending.has(sku) || queued.has(sku) || active.has(sku) || widget.dataset.loaded === '1') return false;
    if (pending.size + queued.size + active.size >= MAX_BATCH_SIZE) return false;
    const anchor = widget.parentElement?.querySelector(`a[href*="-${sku}/"]`);
    if (!anchor) return false;
    pending.add(sku);
    widget.dataset.loaded = '1';
    widget.querySelector('.wyerp-listing-status').textContent = '检查缓存';
    const cachedSnapshot = await readCache(sku);
    if (cachedSnapshot) {
      pending.delete(sku);
      widgetsForSku(sku).forEach(node => render(node, cachedSnapshot.analytics, 'cache', cachedSnapshot.marketOffers || null));
    }
    pending.delete(sku);
    if (queued.has(sku) || active.has(sku)) return true;
    queued.add(sku);
    queue.push({ sku, productUrl: new URL(anchor.href, location.href).href, card: widget.parentElement, cachedSnapshot: cachedSnapshot || null });
    widgetsForSku(sku).forEach(node => { node.querySelector('.wyerp-listing-status').textContent = cachedSnapshot ? '完整缓存已显示' : '排队读取'; });
    drain();
    return true;
  }

  function promoteDeferred() {
    for (const widget of [...deferred]) {
      if (pending.size + queued.size + active.size >= MAX_BATCH_SIZE) break;
      if (!widget.isConnected) {
        deferred.delete(widget);
        continue;
      }
      const rect = widget.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      deferred.delete(widget);
      enqueue(widget).then(accepted => {
        if (accepted) observer.unobserve(widget);
        else if (widget.isConnected && widget.dataset.loaded !== '1') deferred.add(widget);
      });
    }
  }

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) deferred.add(entry.target);
      else if (entry.target.dataset.loaded !== '1') deferred.delete(entry.target);
    }
    promoteDeferred();
  }, { rootMargin: `${PREFETCH_DISTANCE_PX}px 0px` });

  function scan() {
    scanTimer = 0;
    for (const nestedWidget of document.querySelectorAll('.wyerp-market-competitor .wyerp-listing-widget')) {
      observer.unobserve(nestedWidget);
      deferred.delete(nestedWidget);
      nestedWidget.remove();
    }
    for (const item of productCards()) {
      if (item.card.closest('#wyerp-listing-competitor-modal, .wyerp-market-competitor-modal, .wyerp-market-competitor-list')) continue;
      insertWidget(item.card, item.sku, item.productUrl);
    }
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(scan, 180);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
