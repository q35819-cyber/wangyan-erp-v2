(function (root, factory) {
  'use strict';
  const api = factory(root.WyCapture, root.WyCollector, root.WyOzonPublic);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.WyLauncher = api;
    if (root.document && root.chrome?.runtime) api.mount(root.document, root.location.href, root.chrome.runtime);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, Collector, OzonPublic) {
  'use strict';
  const ROOT_ID = 'wyerp-collector-launcher';
  const PANEL_ID = 'wyerp-ozon-market-panel';
  const panelOrder = [
    ['productTitle', '商品名称'], ['category', '类目'], ['commission', '类目佣金'], ['fulfillment', '发货模式'], ['sku', 'SKU'], ['brand', '品牌'],
    ['sellerType', '卖家类型'], ['reviewCount', '评论数'], ['reviewRating', '商品评分'], ['questionCount', '问题数'],
    ['dailySales', '日销量'], ['monthlyUnits', '月销量'], ['monthlyRevenue', '月销售额'], ['stock', '库存'], ['marketPrice', '商品价格'], ['grossMargin', '毛利率'],
    ['turnover', '月销售额环比'], ['advertising', '广告费占比'], ['promotionDays', '参与促销天数'], ['promotionDiscount', '参与促销的折扣'],
    ['promotionConversion', '促销活动的转化率'], ['paidDays', '付费推广天数'], ['cardViews', '商品卡浏览量'], ['cardCartRate', '商品卡加购率'],
    ['searchViews', '搜索目录浏览量'], ['searchCartRate', '搜索目录加购率'], ['impressionConversion', '展示转化率'], ['clickRate', '商品点击率'],
    ['orderConversionRate', '下单转化率'], ['returnRate', '退货取消率'], ['dimensions', '长 宽 高'], ['weight', '重 量'], ['listedAt', '上架时间'],
    ['upDays', '上架天数'], ['upMonths', '上架月数'], ['variantCount', '变体数量'], ['volume', '体积'],
    ['competitorLow', '跟卖最低价'], ['competitorHigh', '跟卖最高价'], ['competitors', '跟卖列表']
  ];
  const categoryZh = new Map([
    ['Товары для детей', '儿童用品'], ['Красота и здоровье', '美妆与健康'], ['Уход за волосами', '头发护理'],
    ['Шампуни и кондиционеры', '洗发水与护发素'], ['Маски', '发膜'], ['Электроника', '电子产品'],
    ['Дом и сад', '家居园艺'], ['Одежда, обувь и аксессуары', '服装鞋靴与配饰'], ['Бытовая техника', '家用电器'],
    ['Продукты питания', '食品'], ['Спорт и отдых', '运动与休闲'], ['Автотовары', '汽车用品'],
    ['Строительство и ремонт', '建筑与维修']
  ]);
  const sourceZh = new Map([
    ['ozon_public_product_page', '平台公开商品页'], ['ozon_official_seller_api', '平台官方卖家数据'],
    ['third_party_authorized_private_api', '当前账号授权数据'], ['seerfar_ozon_market', '授权市场数据']
  ]);
  const hasCyrillic = value => /[\u0400-\u04ff]/.test(value);
  const addUnit = (value, unit) => /^[+-]?\d+(?:\.\d+)?$/.test(value) ? value + unit : value;
  const chineseMetricValue = (key, value, unit) => {
    const raw = C.cleanText(value, 800);
    const metricUnit = C.cleanText(unit, 20);
    if (!raw || raw === '未获取') return raw || '未获取';
    if (key === 'category') {
      return raw.split(/\s*\/\s*/).map(part => categoryZh.get(part) || (hasCyrillic(part) ? '其他类目' : part)).join(' › ');
    }
    if (key === 'commission') return raw.replace(/≤1500\s*:\s*/g, '不超过1500卢布 ').replace(/≤5000\s*:\s*/g, '不超过5000卢布 ').replace(/>5000\s*:\s*/g, '超过5000卢布 ').replace(/\s*\/\s*/g, ' · ');
    if (key === 'turnover') {
      const amount = Number(raw.replace(/[%％]/g, ''));
      if (Number.isFinite(amount)) return amount < 0 ? '环比下降 ' + Math.abs(amount).toFixed(2) + '%' : amount > 0 ? '环比增长 ' + amount.toFixed(2) + '%' : '环比持平';
    }
    if (key === 'monthlyRevenue') {
      const amount = Number(raw.replace(/[\s,]/g, ''));
      if (Number.isFinite(amount)) return (metricUnit === '₽' ? '₽' : metricUnit) + amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
      return raw;
    }
    if (key === 'sellerType') return raw === '0' ? '本土卖家' : raw === '1' ? '跨境卖家' : raw;
    if (key === 'fulfillment') return raw;
    if (key === 'dimensions') {
      const formatted = raw.replace(/\s*[xх×]\s*/gi, ' × ').replace(/mm\b/gi, '毫米').replace(/cm\b/gi, '厘米');
      return /(?:毫米|厘米)$/i.test(formatted) ? formatted : formatted + (metricUnit === 'cm' ? '厘米' : '毫米');
    }
    if (key === 'weight') {
      const formatted = raw.replace(/kg\b/gi, '千克').replace(/g\b/gi, '克');
      return /(?:千克|克)$/i.test(formatted) ? formatted : formatted + (metricUnit === 'kg' ? '千克' : '克');
    }
    if (key === 'listedAt') {
      const matched = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (!matched) return raw;
      const year = Number(matched[1]); const month = Number(matched[2]); const day = Number(matched[3]);
      const listed = Date.UTC(year, month - 1, day); const today = new Date();
      const currentDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
      const age = Math.max(0, Math.floor((currentDay - listed) / 86400000));
      return year + '年' + month + '月' + day + '日（已上架' + age + '天）';
    }
    if (key === 'competitors') {
      const count = raw.match(/等(\d+)个公开报价/)?.[1] || raw.match(/共(\d+)个公开报价/)?.[1];
      return count ? '共' + count + '个公开报价' : hasCyrillic(raw) ? '存在公开报价' : raw;
    }
    if (['dailySales', 'monthlyUnits', 'stock'].includes(key)) return addUnit(raw, metricUnit || '件');
    if (['reviewCount', 'questionCount'].includes(key)) return addUnit(raw, metricUnit || '条');
    if (['upDays', 'upMonths', 'variantCount'].includes(key)) return addUnit(raw, metricUnit);
    if (key === 'marketPrice') return /^[+-]?\d+(?:\.\d+)?$/.test(raw) ? (metricUnit || '₽') + raw : raw;
    if (['promotionDays', 'paidDays'].includes(key)) return addUnit(raw, '天');
    if (['cardViews', 'searchViews'].includes(key)) return addUnit(raw, '次');
    if (['advertising', 'promotionDiscount', 'promotionConversion', 'cardCartRate', 'searchCartRate', 'impressionConversion', 'clickRate', 'returnRate'].includes(key)) return addUnit(raw, '%');
    return metricUnit && /^[+-]?\d+(?:\.\d+)?$/.test(raw) ? addUnit(raw, metricUnit) : raw;
  };
  function mount(doc, pageUrl, runtime) {
    let pageLocation = null;
    try { pageLocation = new URL(pageUrl); } catch (_) { return null; }
    const isSellerBackend = ['seller.ozonru.cn','seller.ozon.ru'].includes(pageLocation.hostname);
    const isOzonFrontend = /^(?:www\.)?ozon\.(?:ru|by|kz)$/.test(pageLocation.hostname);
    const detectedSource = C?.sourceUrl(pageUrl);
    const source = detectedSource || (isSellerBackend || isOzonFrontend
      ? { platform: 'ozon', productId: '', url: pageLocation.href }
      : null);
    if (!source || !runtime?.sendMessage || (source.productId && !Collector?.extract)) return null;
    const previous = doc.getElementById(ROOT_ID); if (previous) return previous;
    const root = doc.createElement('div'); root.id = ROOT_ID; root.setAttribute('data-platform', source.platform);
    root.setAttribute('data-page-context', isSellerBackend ? 'seller-backend' : source.productId ? 'product' : 'ozon-frontend');
    let pagePanel = null; let thirdPartyCards = []; let placementTimer = null; let displayedRecord = null;
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const findOzonInsertionSlot = () => {
      const referencePoint = doc.getElementById('custom-insertion-point');
      if (referencePoint?.parentElement) return { rail: referencePoint.parentElement, before: referencePoint };
      const buyButton = Array.from(doc.querySelectorAll('button')).find(item => /В корзину|Купить сейчас/i.test(C.cleanText(item.textContent)));
      if (!buyButton) return null;
      let purchaseCard = buyButton; let fallbackSlot = null;
      while (purchaseCard?.parentElement && purchaseCard.parentElement !== doc.body) {
        const rail = purchaseCard.parentElement;
        const cardRect = purchaseCard.getBoundingClientRect?.();
        const railRect = rail.getBoundingClientRect?.();
        const railStyle = doc.defaultView?.getComputedStyle?.(rail);
        const isDirectRightRailChild = cardRect && railRect && railStyle &&
          cardRect.width >= 280 && cardRect.width <= 520 &&
          Math.abs(cardRect.width - railRect.width) <= 8 &&
          railStyle.display === 'flex' && railStyle.flexDirection === 'column';
        if (isDirectRightRailChild) {
          const before = purchaseCard.nextElementSibling;
          if (before) return { rail, before };
          if (!fallbackSlot) fallbackSlot = { rail, before: null };
        }
        purchaseCard = rail;
      }
      return fallbackSlot;
    };
    const restoreThirdParty = () => {
      for (const card of thirdPartyCards) card?.classList?.remove('wyerp-third-party-temporary-hide');
      thirdPartyCards = [];
    };
    const stopPlacementWatch = () => {
      if (placementTimer) clearInterval(placementTimer); placementTimer = null;
    };
    const placePagePanel = () => {
      if (!pagePanel) return false;
      const slot = findOzonInsertionSlot();
      if (!slot) return false;
      const before = slot.before || null;
      if (pagePanel.parentElement !== slot.rail || pagePanel.nextSibling !== before) slot.rail.insertBefore(pagePanel, before);
      pagePanel.dataset.placement = 'rail';
      restoreThirdParty();
      thirdPartyCards = [doc.getElementById('mz-profit-card-placeholder'), doc.getElementById('custom-insertion-point')].filter(Boolean);
      for (const card of thirdPartyCards) card.classList.add('wyerp-third-party-temporary-hide');
      return true;
    };
    const watchPagePanelPlacement = () => {
      if (placementTimer) return;
      const retry = () => {
        if (!pagePanel) { stopPlacementWatch(); return; }
        if (!pagePanel.isConnected) placePagePanel();
      };
      placementTimer = setInterval(retry, 1000);
    };
    const closePanel = () => {
      stopPlacementWatch(); pagePanel?.remove(); pagePanel = null; restoreThirdParty();
      show('已关闭网研侧栏，并恢复原页面兼容面板。', 'success');
    };
    const currentRecord = () => {
      const current = C.sourceUrl(doc.location?.href || pageUrl);
      if (!current || current.platform !== 'ozon' || current.productId !== source.productId) throw new Error('商品页已跳转，请刷新后重试。');
      const record = Collector.extract(doc, current.url);
      if (record.analytics?.productId !== current.productId) throw new Error('当前SKU数据校验失败，请刷新商品页后重试。');
      return record;
    };
    const warningRecord = (record, message) => {
      record.analytics = record.analytics || { status: 'unavailable', metrics: [], sources: [], warnings: [] };
      record.analytics.warnings = Array.isArray(record.analytics.warnings) ? record.analytics.warnings : [];
      const value = C.cleanText(message, 180);
      if (value && !record.analytics.warnings.includes(value)) record.analytics.warnings.push(value);
      return record;
    };
    const settleWithin = async (promise, milliseconds, message) => {
      let timer;
      try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
      } finally { clearTimeout(timer); }
    };
    const publicRecord = async () => {
      const record = currentRecord();
      if (record.source.platform !== 'ozon' || !OzonPublic?.enrich) return record;
      try { return await settleWithin(OzonPublic.enrich(record, { fetch: doc.defaultView?.fetch?.bind(doc.defaultView), origin: doc.location?.origin }), 5000, 'Ozon公开商品JSON读取超过5秒。'); }
      catch (error) { return warningRecord(record, C.cleanText(error?.message || 'Ozon公开商品JSON读取失败。', 160)); }
    };
    const enrichedRecord = async (options = {}, baseRecord = null) => {
      const record = baseRecord || await publicRecord();
      try {
        const response = await settleWithin(runtime.sendMessage({ type: 'enrich-ozon-record', record, forceRefresh: options.forceRefresh === true }), 32000, '商品补充数据读取超过32秒。');
        return response?.ok && response.record ? response.record : warningRecord(record, response?.message || '网研ERP没有返回Ozon官方数据。');
      } catch (error) { return warningRecord(record, C.cleanText(error?.message || 'Ozon官方数据读取失败。', 160)); }
    };
    const renderPagePanel = incomingRecord => {
      let record = incomingRecord;
      if (displayedRecord?.source?.productId === incomingRecord?.source?.productId) {
        const previousMetrics = Array.isArray(displayedRecord.analytics?.metrics) ? displayedRecord.analytics.metrics : [];
        const incomingMetrics = Array.isArray(incomingRecord.analytics?.metrics) ? incomingRecord.analytics.metrics : [];
        const mergedMetrics = new Map(previousMetrics.map(item => [item?.key, item]).filter(item => item[0]));
        incomingMetrics.forEach(item => { if (item?.key) mergedMetrics.set(item.key, item); });
        const mergedSources = new Map([...(displayedRecord.analytics?.sources || []), ...(incomingRecord.analytics?.sources || [])].map(item => [item?.id, item]).filter(item => item[0]));
        record = {
          ...incomingRecord,
          analytics: {
            ...(displayedRecord.analytics || {}),
            ...(incomingRecord.analytics || {}),
            metrics: Array.from(mergedMetrics.values()),
            sources: Array.from(mergedSources.values()),
            warnings: Array.from(new Set([...(displayedRecord.analytics?.warnings || []), ...(incomingRecord.analytics?.warnings || [])]))
          }
        };
        const previousOffers = displayedRecord.marketOffers;
        const incomingOffers = record.marketOffers;
        if ((!Array.isArray(incomingOffers?.sellers) || !incomingOffers.sellers.length) && Array.isArray(previousOffers?.sellers) && previousOffers.sellers.length) {
          record.marketOffers = JSON.parse(JSON.stringify(previousOffers));
        }
      }
      displayedRecord = JSON.parse(JSON.stringify(record));
      if (pagePanel && !pagePanel.isConnected) { pagePanel = null; restoreThirdParty(); }
      const created = !pagePanel;
      if (!pagePanel) {
        pagePanel = element('section'); pagePanel.id = PANEL_ID; pagePanel.setAttribute('aria-label', '网研电商系统商品数据侧栏');
        pagePanel.dataset.placement = 'pending';
        (doc.body || doc.documentElement).append(pagePanel);
      }
      placePagePanel();
      watchPagePanelPlacement();
      pagePanel.replaceChildren();
      const header = element('header', 'wyerp-market-header');
      const identity = element('div', 'wyerp-market-identity'); identity.append(element('span', 'wyerp-market-mark', 'W'));
      const heading = element('div'); heading.append(element('strong', '', '平台商品数据'), element('small', '', '网研电商系统 · 页面直读'));
      identity.append(heading);
      const actions = element('div', 'wyerp-market-actions');
      const refresh = element('button', '', '重新读取'); refresh.type = 'button'; refresh.title = '重新读取当前页面并校验SKU';
      const close = element('button', '', '关闭'); close.type = 'button'; close.title = '关闭网研侧栏并恢复原页面兼容面板';
      actions.append(refresh, close); header.append(identity, actions);
      const title = element('h2', '', '当前商品数据');
      const meta = element('p', 'wyerp-market-meta', '商品编号 ' + record.source.productId + ' · 读取于 ' + record.source.capturedAt);
      const list = element('dl', 'wyerp-market-list');
      const metrics = new Map((record.analytics?.metrics || []).map(item => [item.key, item]));
      const orderedFields = panelOrder.slice(); const orderedKeys = new Set(orderedFields.map(item => item[0]));
      for (const metric of metrics.values()) if (metric?.key && !orderedKeys.has(metric.key)) { orderedFields.push([metric.key, C.cleanText(metric.label || metric.key, 80)]); orderedKeys.add(metric.key); }
      const present = orderedFields.filter(([key]) => key === 'sku' || metrics.has(key)).length;
      const notice = element('p', 'wyerp-market-notice', '已读取 ' + present + '/' + orderedFields.length + ' 项；真实数值0正常显示，只有接口空值显示“未获取”。Ozon和Seerfar缓存独立填充。');
      const offerPrice = value => {
        const normalized = String(value || '').replace(/[\u00a0\u2009\s]/g, '').replace(',', '.').replace(/[^\d.]/g, '');
        const parsed = Number(normalized);
        return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
      };
      const offerRows = (Array.isArray(record.marketOffers?.sellers) ? record.marketOffers.sellers : [])
        .slice()
        .sort((left, right) => {
          const leftWithoutReviews = Number(left?.reviewsCount) > 0 ? 0 : 1;
          const rightWithoutReviews = Number(right?.reviewsCount) > 0 ? 0 : 1;
          return leftWithoutReviews - rightWithoutReviews
            || offerPrice(left?.price) - offerPrice(right?.price);
        })
        .slice(0, 50);
      for (const [key, label] of orderedFields) {
        const row = element('div', 'wyerp-market-row'); row.dataset.key = key;
        const dt = element('dt', '', label); const metric = metrics.get(key);
        const hasMetricValue = metric && metric.raw !== null && metric.raw !== undefined && !(typeof metric.raw === 'string' && !metric.raw.trim());
        const raw = key === 'sku' ? record.source.productId : key === 'brand' && !hasMetricValue ? '无品牌' : hasMetricValue ? metric.raw : '未获取';
        const display = chineseMetricValue(key, raw, metric?.unit);
        let dd;
        if (key === 'competitors' && offerRows.length) {
          dd = element('dd', 'wyerp-market-competitors');
          const offers = element('div', 'wyerp-market-competitor-list');
          for (const seller of offerRows) {
            const offer = element('div', 'wyerp-market-competitor');
            const storeTarget = seller.sellerUrl || seller.productUrl;
            const productTarget = seller.productUrl || seller.sellerUrl;
            const storeName = seller.name || ('店铺 ' + seller.sellerId);
            const store = element(storeTarget ? 'a' : 'span', 'wyerp-market-store-link', storeName);
            store.title = storeName;
            if (storeTarget) { store.href = storeTarget; store.target = '_blank'; store.rel = 'noopener noreferrer'; }
            const sku = element(productTarget ? 'a' : 'span', 'wyerp-market-sku-link', seller.sellerSku ? 'SKU ' + seller.sellerSku : 'SKU未提供');
            if (productTarget) { sku.href = productTarget; sku.target = '_blank'; sku.rel = 'noopener noreferrer'; sku.title = '打开该卖家的商品：' + seller.sellerSku; }
            const avatarName = C.cleanText(seller.name || seller.sellerId || '店', 100);
            const avatarFallback = () => element('span', 'wyerp-market-store-avatar wyerp-market-store-avatar-fallback', Array.from(avatarName)[0]?.toUpperCase() || '店');
            let avatar = avatarFallback();
            if (seller.logoImageUrl) {
              avatar = element('img', 'wyerp-market-store-avatar');
              avatar.src = seller.logoImageUrl; avatar.alt = avatarName + ' 店铺头像'; avatar.loading = 'lazy'; avatar.referrerPolicy = 'no-referrer';
              avatar.addEventListener('error', () => avatar.replaceWith(avatarFallback()), { once: true });
            }
            const reviewsCount = Number(seller.reviewsCount);
            const reviews = element('span', 'wyerp-market-offer-reviews', '评论 ' + (Number.isFinite(reviewsCount) ? Math.max(0, Math.trunc(reviewsCount)) + ' 条' : '未获取'));
            offer.append(avatar, store, sku, element('span', 'wyerp-market-offer-price', seller.price || '价格未提供'), reviews);
            offers.append(offer);
          }
          const totalOffers = Number(record.marketOffers?.offerCount) || offerRows.length;
          const trigger = element('button', 'wyerp-market-competitor-trigger', '公开列表（' + totalOffers + '）');
          trigger.type = 'button'; trigger.title = '查看按价格升序排列的公开跟卖店铺、SKU、价格和评论数';
          trigger.addEventListener('click', () => {
            doc.getElementById('wyerp-market-competitor-modal')?.remove();
            const modal = element('div', 'wyerp-market-competitor-modal'); modal.id = 'wyerp-market-competitor-modal';
            modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '公开跟卖列表');
            const dialog = element('section', 'wyerp-market-competitor-dialog');
            const modalHeader = element('header', 'wyerp-market-competitor-dialog-header');
            const modalTitle = element('strong', '', '公开跟卖列表（' + totalOffers + '）');
            const modalClose = element('button', 'wyerp-market-competitor-close', '关闭'); modalClose.type = 'button';
            const dismiss = () => { modal.remove(); doc.removeEventListener('keydown', onKeyDown); };
            const onKeyDown = event => { if (event.key === 'Escape') dismiss(); };
            modalClose.addEventListener('click', dismiss);
            modal.addEventListener('click', event => { if (event.target === modal) dismiss(); });
            doc.addEventListener('keydown', onKeyDown);
            modalHeader.append(modalTitle, modalClose);
            const modalBody = element('div', 'wyerp-market-competitor-dialog-body'); modalBody.append(offers.cloneNode(true));
            dialog.append(modalHeader, modalBody); modal.append(dialog); pagePanel.append(modal);
            modalClose.focus();
          });
          dd.append(trigger);
        } else if (key === 'commission' && metric) {
          dd = element('dd', 'wyerp-listing-commissions');
          const parts = String(display).split(/[,/|\s]+/).filter(part => /%/.test(part)).slice(0, 3);
          const ranges = ['不超过1500₽', '超过1500₽且不超过5000₽', '超过5000₽'];
          for (const [index, part] of parts.entries()) {
            const badge = element('b', '', part);
            badge.title = `${ranges[index]}：${part}`;
            dd.append(badge);
          }
          if (!parts.length) dd.textContent = display;
        } else dd = element('dd', key === 'sku' || metric ? '' : 'wyerp-market-missing', display);
        dt.title = label; dd.title = C.cleanText(metric?.title, 800) || display;
        row.append(dt, dd); list.append(row);
      }
      const sourceLabels = (record.analytics?.sources || []).map(item => sourceZh.get(item.id) || '其他授权数据');
      const sourceNote = element('p', 'wyerp-market-source', sourceLabels.length ? '来源：' + [...new Set(sourceLabels)].join('、') + '。公开跟卖列表仅使用Ozon公开报价数据。' : '来源：当前Ozon公开商品页。');
      const warningItems = [...(record.analytics?.warnings || []), ...(record.warnings || [])].map(item => C.cleanText(item, 180)).filter(Boolean).slice(0, 6);
      const warningNote = warningItems.length ? element('p', 'wyerp-market-warning', '数据提示：' + warningItems.join('；')) : null;
      const panelTools = element('div', 'wyerp-market-tools');
      const panelAction = (label, className) => { const action = element('button', className, label); action.type = 'button'; return action; };
      const quickListing = panelAction('一键上架', 'wyerp-market-tool-danger'); quickListing.title = '采集当前商品并进入网研ERP上架流程';
      const editListing = panelAction('编辑上架', 'wyerp-market-tool-primary'); editListing.title = '采集当前商品并进入网研ERP编辑上架工作台';
      const copyImages = panelAction('复制图片', 'wyerp-market-tool-primary'); copyImages.title = '复制当前商品图片链接';
      const collectOnly = panelAction('采集商品', 'wyerp-market-tool-primary'); collectOnly.title = '只采集当前商品到网研ERP采集箱';
      panelTools.append(quickListing, editListing, copyImages, collectOnly);
      pagePanel.append(header, notice, title, meta, list, panelTools, sourceNote);
      if (warningNote) pagePanel.append(warningNote);
      refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        try {
          const base = currentRecord(); renderPagePanel(base);
          show('正在分别读取Ozon和Seerfar数据。', 'busy');
          const results = await Promise.allSettled([loadOzonPanelData(base, true), loadSeerfarPanelData(base)]);
          showParallelLoadResult(results);
        }
        catch (error) { show(C.cleanText(error?.message || '重新读取失败。', 200), 'error'); }
        finally { refresh.disabled = false; }
      });
      close.addEventListener('click', closePanel);
      quickListing.addEventListener('click', () => captureCurrent({ trigger: quickListing, openListing: true, successMessage: '采集成功，正在进入上架流程。' }));
      editListing.addEventListener('click', () => captureCurrent({ trigger: editListing, openListing: true, successMessage: '采集成功，正在进入编辑上架工作台。' }));
      collectOnly.addEventListener('click', () => captureCurrent({ trigger: collectOnly, openListing: false }));
      copyImages.addEventListener('click', async () => {
        const originalText = copyImages.textContent;
        copyImages.disabled = true; copyImages.textContent = '正在复制';
        try {
          const current = currentRecord();
          const media = current?.product?.media || current?.media || {};
          const candidates = [media.primary, media.primaryImage, ...(Array.isArray(media.images) ? media.images : []), ...(Array.isArray(current?.product?.images) ? current.product.images : [])];
          const urls = [];
          const addUrl = item => {
            const value = typeof item === 'string' ? item : item?.url || item?.src || item?.original || item?.large;
            const normalized = C.cleanText(value, 2000);
            if (/^https:\/\//i.test(normalized) && !urls.includes(normalized)) urls.push(normalized);
          };
          candidates.forEach(addUrl);
          if (!urls.length) Array.from(doc.images || []).forEach(image => addUrl(image.currentSrc || image.src));
          if (!urls.length) throw new Error('当前商品页没有可复制的图片。');
          await doc.defaultView.navigator.clipboard.writeText(urls.join('\n'));
          show('已复制' + urls.length + '张商品图片链接。', 'success');
        } catch (error) { show(C.cleanText(error?.message || '复制图片失败。', 160), 'error'); }
        finally { copyImages.disabled = false; copyImages.textContent = originalText; }
      });
      if (created) pagePanel.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    };
    const controlHeader = element('div', 'wyerp-control-header');
    const controlBrand = element('div', 'wyerp-control-brand'); controlBrand.append(element('span', 'wyerp-control-logo', 'W'), element('strong', '', '网研ERP'));
    const collapseButton = element('button', 'wyerp-collapse', '−'); collapseButton.type = 'button'; collapseButton.title = '收起或展开网研ERP工具'; collapseButton.setAttribute('aria-label', '收起网研ERP工具'); collapseButton.setAttribute('aria-expanded', 'true');
    controlHeader.append(controlBrand, collapseButton);
    const controlBody = element('div', 'wyerp-control-body');
    const makeControl = (text, className) => { const node = element('button', 'wyerp-control-button ' + className, text); node.type = 'button'; return node; };
    const backendButton = makeControl('打开平台后台', 'wyerp-action-link');
    const primaryActionLabel = source.platform === 'ozon' ? '一键上架' : '采集商品';
    const button = makeControl(primaryActionLabel, 'wyerp-action-danger');
    button.title = source.platform === 'ozon' ? '采集当前商品并进入网研ERP上架流程' : '采集当前货源商品到网研ERP采集箱';
    button.setAttribute('aria-label', source.platform === 'ozon' ? '采集当前商品并进入上架流程' : '采集当前货源商品');
    const profitButton = makeControl('计算利润', 'wyerp-action-primary');
    const pricingButton = makeControl('定价工具', 'wyerp-action-warning');
    const bindingButton = makeControl('绑定Cookie', 'wyerp-action-primary');
    const selectionButton = makeControl(source.platform === 'ozon' ? '设置选品' : '采集图片', 'wyerp-action-light');
    selectionButton.title = source.platform === 'ozon' ? '打开Ozon选品设置' : '复制当前货源商品图片链接，一行一个';
    const sidebarButton = makeControl('商品数据', 'wyerp-action-light'); sidebarButton.title = '展开并重新读取当前商品数据'; sidebarButton.setAttribute('aria-label', '打开网研ERP Ozon商品侧栏');
    const otherCardsButton = makeControl('隐藏其它卡片', 'wyerp-action-switch'); otherCardsButton.setAttribute('aria-pressed', 'false');
    const erpButton = makeControl('进入网研ERP', 'wyerp-action-link');
    const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    controlBody.append(backendButton, button, profitButton, pricingButton, bindingButton, selectionButton, sidebarButton, otherCardsButton, erpButton);
    root.append(controlHeader, controlBody, status); (doc.body || doc.documentElement).append(root);
    let running = false; let sidebarRunning = false; let timer = null;
    const show = (text, state) => {
      status.textContent = text; root.dataset.state = state || '';
      if (timer) clearTimeout(timer);
      if (text && state === 'success') timer = setTimeout(() => { status.textContent = ''; root.dataset.state = ''; }, 10000);
    };
    const openTool = async (tool, message) => {
      const response = await runtime.sendMessage({ type: 'open-tool-page', tool });
      if (!response?.ok) throw new Error(response?.message || '页面未能打开。');
      show(message, 'success');
    };
    const copyTextToClipboard = async text => {
      const clipboard = doc.defaultView?.navigator?.clipboard;
      if (clipboard?.writeText) {
        try { await clipboard.writeText(text); return; } catch (_) { /* fall back to DOM copy */ }
      }
      const area = doc.createElement('textarea');
      area.value = text; area.setAttribute('readonly', '');
      area.style.position = 'fixed'; area.style.left = '-9999px'; area.style.top = '0'; area.style.opacity = '0';
      (doc.body || doc.documentElement).append(area); area.focus(); area.select();
      let copied = false;
      try { copied = typeof doc.execCommand === 'function' && doc.execCommand('copy') === true; } catch (_) { copied = false; }
      area.remove();
      if (!copied) throw new Error('浏览器未允许复制，请检查页面剪贴板权限后重试。');
    };
    const sourceImageLinks = () => {
      const current = C.sourceUrl(doc.location?.href || pageUrl);
      if (!current || current.platform !== source.platform || current.productId !== source.productId) throw new Error('商品页已跳转，请刷新后重试。');
      const record = Collector.extract(doc, current.url);
      const urls = [];
      const add = value => {
        const raw = typeof value === 'string' ? value : value?.url || value?.imageUrl || value?.src || value?.thumbnailUrl || '';
        const normalized = C.cleanText(raw, 3000);
        if (/^https:\/\//i.test(normalized) && !urls.includes(normalized)) urls.push(normalized);
      };
      add(record.primarySkuImage);
      (Array.isArray(record.skuImages) ? record.skuImages : []).forEach(add);
      (Array.isArray(record.variants) ? record.variants : []).forEach(item => add(item?.imageUrl || item?.image));
      (Array.isArray(record.media) ? record.media : []).filter(item => item?.kind === 'image').forEach(add);
      return urls;
    };
    const copySourceImages = async () => {
      const originalText = selectionButton.textContent;
      selectionButton.disabled = true; selectionButton.textContent = '正在复制…'; show('正在读取当前商品图片链接', 'busy');
      try {
        const urls = sourceImageLinks();
        if (!urls.length) throw new Error('当前商品页没有读取到可用的 HTTPS 图片链接。');
        await copyTextToClipboard(urls.join('\n'));
        show('已复制' + urls.length + '张图片链接到剪贴板；可到SKU图片编辑的“网络图片”中手动粘贴。', 'success');
      } catch (error) { show(C.cleanText(error?.message || '采集图片失败。', 200), 'error'); }
      finally { selectionButton.disabled = false; selectionButton.textContent = originalText; }
    };
    const captureCurrent = async (options = {}) => {
      if (running) return;
      const trigger = options?.trigger || button; const originalText = trigger.textContent;
      running = true; button.disabled = true; trigger.disabled = true; trigger.textContent = '正在采集…'; show('正在读取当前页面', 'busy');
      try {
        const current = C.sourceUrl(doc.location?.href || pageUrl);
        if (!current || current.platform !== source.platform || current.productId !== source.productId) throw new Error('商品页已跳转，请刷新后重试。');
        const record = source.platform === 'ozon' ? await publicRecord() : Collector.extract(doc, current.url);
        const response = await settleWithin(runtime.sendMessage({ type: 'page-capture-result', record }), 22000, '网研ERP采集保存超过22秒，请确认ERP已登录并重新采集。');
        if (!response?.ok) throw new Error(response?.message || '采集箱未能接收数据。');
        if (options?.openListing === false) show(response?.message || '商品已写入网研ERP采集箱。', 'success');
        else await openTool('listing', options?.successMessage || response?.message || '采集成功，正在进入上架流程。');
      } catch (error) {
        const rawMessage = String(error?.message || '采集失败，请展开页面内容后重试。');
        const message = /message channel closed|asynchronous response|receiving end does not exist/i.test(rawMessage)
          ? '采集保存通道意外中断，请保持当前租户的网研ERP页面打开并重新采集。'
          : /frame with id 0|showing error page|cannot access contents of url/i.test(rawMessage)
            ? '网研ERP保存页面未能正常加载，插件已停止本次保存，请确认本机ERP可以正常打开后重试。'
            : rawMessage;
        show(C.cleanText(message, 200), 'error');
      }
      finally { running = false; button.disabled = false; button.textContent = primaryActionLabel; trigger.disabled = false; trigger.textContent = originalText; }
    };
    const currentSkuMatches = record => {
      const current = C.sourceUrl(doc.location?.href || pageUrl);
      return Boolean(pagePanel && current?.productId === record?.source?.productId);
    };
    const loadOzonPanelData = async (baseRecord, forceNetwork = false) => {
      let cacheStatus = 'miss';
      try {
        const cached = await runtime.sendMessage({ type: 'ozon-public-cache-get', sku: baseRecord.source.productId });
        if (cached?.ok && cached.hit && currentSkuMatches(cached.record)) {
          cacheStatus = cached.status;
          renderPagePanel(cached.record);
          if (!forceNetwork && cached.status === 'fresh') return cached.record;
        }
      } catch (_) { /* Ozon cache is optional */ }
      const publicData = await publicRecord();
      if (currentSkuMatches(publicData)) renderPagePanel(publicData);
      runtime.sendMessage({ type: 'ozon-public-cache-set', record: publicData }).catch(() => undefined);
      return publicData;
    };
    const loadSeerfarPanelData = async baseRecord => {
      const enriched = await enrichedRecord({}, baseRecord);
      if (currentSkuMatches(enriched)) renderPagePanel(enriched);
      return enriched;
    };
    const loadedSourceCount = (record, sourceId) => (Array.isArray(record?.analytics?.metrics) ? record.analytics.metrics : [])
      .filter(metric => metric?.source === sourceId && metric?.raw !== null && metric?.raw !== undefined && !(typeof metric.raw === 'string' && !metric.raw.trim()))
      .length;
    const showParallelLoadResult = results => {
      const ozonRecord = results?.[0]?.status === 'fulfilled' ? results[0].value : null;
      const seerfarRecord = results?.[1]?.status === 'fulfilled' ? results[1].value : null;
      const ozonCount = loadedSourceCount(ozonRecord, 'ozon_public_page')
        + (Array.isArray(ozonRecord?.marketOffers?.sellers) && ozonRecord.marketOffers.sellers.length ? 1 : 0);
      const seerfarCount = loadedSourceCount(seerfarRecord, 'seerfar_ozon_market');
      const seerfarWarnings = Array.isArray(seerfarRecord?.analytics?.warnings) ? seerfarRecord.analytics.warnings : [];
      if (!seerfarCount && seerfarWarnings.some(message => String(message || '').includes('请先登录ERP'))) {
        const notice = doc.querySelector('.wyerp-market-notice');
        if (notice) notice.textContent = '请先登录ERP';
        show('请先登录ERP', 'error');
        return;
      }
      show([
        ozonCount ? 'Ozon已填充' + ozonCount + '项' : 'Ozon未返回可用数据',
        seerfarCount ? 'Seerfar已填充' + seerfarCount + '项' : 'Seerfar未返回可用数据'
      ].join('；') + '。', seerfarCount ? 'success' : 'error');
    };
    const openEmbeddedPanel = async () => {
      if (sidebarRunning) return; sidebarRunning = true; sidebarButton.disabled = true; sidebarButton.textContent = '正在读取'; show('正在读取当前页面', 'busy');
      try {
        const base = currentRecord(); renderPagePanel(base);
        show('已显示页面数据，正在分别读取Ozon和Seerfar缓存。', 'busy');
        const results = await Promise.allSettled([loadOzonPanelData(base), loadSeerfarPanelData(base)]);
        showParallelLoadResult(results);
      } catch (error) { show(C.cleanText(error?.message || '请等待商品页面加载后重试。', 200), 'error'); }
      finally { sidebarRunning = false; sidebarButton.disabled = false; sidebarButton.textContent = '商品数据'; }
    };
    const recommendationPattern = /Рекомендуем также|Покупают вместе|Подобрали для вас|相关推荐|一起购买/;
    let hiddenCards = [];
    const toggleOtherCards = () => {
      const hiding = otherCardsButton.getAttribute('aria-pressed') !== 'true';
      if (hiding) {
        hiddenCards = [...new Set(Array.from(doc.querySelectorAll('h2,h3')).filter(node => recommendationPattern.test(C.cleanText(node.textContent))).map(node => node.closest('section') || node.parentElement?.parentElement).filter(Boolean))];
        hiddenCards.forEach(node => node.classList.add('wyerp-page-card-hidden'));
      } else {
        hiddenCards.forEach(node => node.classList.remove('wyerp-page-card-hidden')); hiddenCards = [];
      }
      otherCardsButton.setAttribute('aria-pressed', String(hiding)); otherCardsButton.textContent = hiding ? '显示其它卡片' : '隐藏其它卡片';
      show(hiding ? '已隐藏页面推荐卡片。' : '已显示页面推荐卡片。', 'success');
    };
    collapseButton.addEventListener('click', () => { const collapsed = root.dataset.collapsed === 'true'; root.dataset.collapsed = String(!collapsed); collapseButton.textContent = collapsed ? '−' : '+'; collapseButton.setAttribute('aria-expanded', String(collapsed)); collapseButton.setAttribute('aria-label', collapsed ? '收起网研ERP工具' : '展开网研ERP工具'); });
    backendButton.addEventListener('click', () => openTool('seller', '正在打开平台后台。').catch(error => show(C.cleanText(error?.message, 160), 'error')));
    button.addEventListener('click', () => source.platform === 'ozon' ? captureCurrent() : captureCurrent({ openListing: false }));
    profitButton.addEventListener('click', () => openTool('profit', '正在打开利润计算。').catch(error => show(C.cleanText(error?.message, 160), 'error')));
    pricingButton.addEventListener('click', () => openTool('pricing', '正在打开定价工具。').catch(error => show(C.cleanText(error?.message, 160), 'error')));
    bindingButton.addEventListener('click', () => {
      if (isSellerBackend) {
        show('正在识别并绑定当前Ozon店铺。', 'busy');
        doc.defaultView?.dispatchEvent(new doc.defaultView.CustomEvent('wyerp-request-seller-binding'));
        return;
      }
      openTool('binding', '请在平台后台确认当前店铺绑定。').catch(error => show(C.cleanText(error?.message, 160), 'error'));
    });
    doc.defaultView?.addEventListener('wyerp-seller-binding-result', event => {
      show(C.cleanText(event?.detail?.message || '绑定流程已结束。', 240), event?.detail?.ok ? 'success' : 'error');
    });
    selectionButton.addEventListener('click', () => {
      if (source.platform === 'ozon') openTool('selection', '正在打开选品设置。').catch(error => show(C.cleanText(error?.message, 160), 'error'));
      else copySourceImages();
    });
    sidebarButton.addEventListener('click', openEmbeddedPanel);
    otherCardsButton.addEventListener('click', toggleOtherCards);
    erpButton.addEventListener('click', () => openTool('erp', '正在进入网研ERP。').catch(error => show(C.cleanText(error?.message, 160), 'error')));
    if (isSellerBackend) {
      backendButton.hidden = true;
      button.hidden = true;
      profitButton.hidden = true;
      pricingButton.hidden = true;
      selectionButton.hidden = true;
      sidebarButton.hidden = true;
      otherCardsButton.hidden = true;
      erpButton.hidden = true;
    } else if (source.platform !== 'ozon') { backendButton.hidden = true; profitButton.hidden = true; pricingButton.hidden = true; bindingButton.hidden = true; sidebarButton.hidden = true; otherCardsButton.hidden = true; }
    else if (source.productId) {
      try { renderPagePanel(currentRecord()); } catch (_) { /* wait for the automatic enriched read */ }
      setTimeout(openEmbeddedPanel, 0);
    }
    return root;
  }
  return { mount, panelOrder };
});
