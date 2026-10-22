(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./shared') : root.WyCapture);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WyAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  const compatibilityDefinitions = [
    ['category', '类目', ''], ['commission', 'rFBS佣金', '%'], ['brand', '品牌', ''],
    ['monthlyUnits', '月销量', '件'], ['monthlyRevenue', '月销售额', '原文币种'],
    ['turnover', '月周转动态', '天'], ['advertising', '广告费占比', '%'], ['promotionDays', '参与促销天数', '天'],
    ['promotionDiscount', '参与促销的折扣', '%'], ['promotionConversion', '促销活动的转化率', '%'], ['paidDays', '付费推广天数', '天'],
    ['cardViews', '商品卡浏览量', '次'], ['cardCartRate', '商品卡加购率', '%'], ['searchViews', '搜索目录浏览量', '次'],
    ['searchCartRate', '搜索目录加购率', '%'], ['impressionConversion', '展示转化率', '%'], ['clickRate', '商品点击率', '%'],
    ['fulfillment', '发货模式', ''], ['returnRate', '退货取消率', '%'], ['dimensions', '长 宽 高', '原文单位'], ['weight', '重 量', '原文单位'],
    ['listedAt', '上架时间', '原文'], ['competitors', '跟卖列表', '原文'], ['competitorLow', '跟卖最低价', '原文币种'], ['competitorHigh', '跟卖最高价', '原文币种']
  ];
  const definitions = compatibilityDefinitions.concat([['dailyUnits', '日销量', '件'], ['dailyRevenue', '日销售额', '原文币种']]);
  const labels = new Map(definitions.map(item => [item[0], item]));
  const text = (value, maximum = 500) => C.cleanText(value, maximum);
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const numericText = value => {
    const number = finite(value);
    if (number === null) return '';
    return String(Math.round(number * 10000) / 10000);
  };
  function empty(productId, capturedAt) {
    return { status: 'unavailable', officialProvider: null, provider: null, productId, capturedAt, metrics: [], sources: [], warnings: [] };
  }
  function addMetric(result, key, raw, source, trust, capturedAt, period, detail) {
    raw = text(raw, 800);
    if (!raw || !labels.has(key) || result.metrics.some(item => item.key === key)) return;
    const [, label, unit] = labels.get(key);
    result.metrics.push({ key, label, raw, unit, source, trust, period: period || { label: '当前快照', start: null, end: null }, capturedAt, ...(detail ? { detail } : {}) });
  }
  function addSource(result, value) {
    if (!value?.id || result.sources.some(item => item.id === value.id)) return;
    result.sources.push(value);
  }
  function status(result) {
    const sources = new Set(result.metrics.map(item => item.source));
    if (sources.has('ozon_official_seller_api')) return sources.size > 1 ? 'mixed_official' : 'official';
    if (sources.has('ozon_public_product_page')) return sources.size > 1 ? 'mixed_public' : 'public_only';
    if (sources.has('third_party_rendered_sidebar')) return 'third_party_reference';
    return 'unavailable';
  }
  function merge(primary, ...fallbacks) {
    const parts = [primary, ...fallbacks].filter(Boolean);
    const result = empty(parts[0]?.productId || '', parts[0]?.capturedAt || new Date().toISOString());
    for (const part of parts) {
      for (const item of part.metrics || []) if (!result.metrics.some(existing => existing.key === item.key)) result.metrics.push(item);
      for (const source of part.sources || []) addSource(result, source);
      for (const warning of part.warnings || []) if (warning && !result.warnings.includes(warning)) result.warnings.push(warning);
    }
    result.status = status(result);
    result.provider = result.sources.map(item => item.id).join('+') || null;
    result.officialProvider = result.sources.some(item => item.id === 'ozon_official_seller_api') ? 'ozon_official_seller_api' : null;
    return result;
  }
  function publicPage(record, source, capturedAt) {
    const result = empty(source.productId, capturedAt);
    const period = { label: '采集时公开商品页快照', start: null, end: null };
    const category = (record?.categoryPath || []).map(item => text(item && typeof item === 'object' ? item.name || item.title : item, 120)).filter(Boolean).join(' / ');
    const attributes = Array.isArray(record?.attributes) ? record.attributes : [];
    const brand = attributes.find(item => /^(?:品牌|brand|бренд)$/i.test(text(item?.name, 80)))?.value;
    addMetric(result, 'category', category, 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    addMetric(result, 'brand', brand, 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    const dimensions = attributes.find(item => /(?:包装)?(?:尺寸|长宽高)|габарит|размер/i.test(text(item?.name, 120)) && /\d/.test(text(item?.value, 300)))?.value;
    const weight = attributes.find(item => /重量|净重|毛重|вес/i.test(text(item?.name, 120)) && /\d/.test(text(item?.value, 300)))?.value;
    addMetric(result, 'dimensions', dimensions, 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    addMetric(result, 'weight', weight, 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    const offers = record?.marketOffers || {};
    const sellerNames = Array.isArray(offers.sellerNames) ? offers.sellerNames.map(item => text(item, 80)).filter(Boolean) : [];
    const offerCount = Number.isInteger(offers.offerCount) && offers.offerCount > 0 ? offers.offerCount : null;
    if (sellerNames.length || offerCount) addMetric(result, 'competitors', (sellerNames.slice(0, 3).join('、') || '公开卖家') + (offerCount ? '等' + offerCount + '个公开报价' : ''), 'ozon_public_product_page', 'public_page_observed', capturedAt, period, '公开商品页报价，不等同第三方统计口径');
    const currency = { RUB: '₽', CNY: '¥', BYN: 'BYN ', KZT: '₸' }[offers.currency] || (offers.currency ? offers.currency + ' ' : '');
    if (offers.lowPrice != null) addMetric(result, 'competitorLow', currency + text(offers.lowPrice, 40), 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    if (offers.highPrice != null) addMetric(result, 'competitorHigh', currency + text(offers.highPrice, 40), 'ozon_public_product_page', 'public_page_observed', capturedAt, period);
    if (result.metrics.length) addSource(result, { id: 'ozon_public_product_page', label: 'Ozon公开商品页', trust: 'public_page_observed', scope: 'current_marketplace_page' });
    result.status = status(result);
    return result;
  }
  function thirdParty(doc, source, capturedAt) {
    const result = empty(source.productId, capturedAt);
    const button = Array.from(doc.querySelectorAll('button')).find(item => C.cleanText(item.textContent) === '采集商品');
    const card = button?.parentElement?.parentElement;
    if (!card || card.textContent.length > 18000) return result;
    const values = new Map();
    for (const label of Array.from(card.querySelectorAll('span')).slice(0, 350)) {
      if (label.children.length || !/[：:]\s*$/.test(label.textContent)) continue;
      const key = C.cleanText(label.textContent).replace(/[：:]$/, '').trim();
      const value = label.nextElementSibling;
      if (value) values.set(key, C.cleanText(value.textContent, 500));
    }
    if (values.get('SKU') !== source.productId || !values.has('rFBS佣金') || !values.has('月销量')) return result;
    addSource(result, { id: 'third_party_rendered_sidebar', label: '第三方已渲染侧栏', trust: 'third_party_unverified', scope: 'compatibility_fallback_only' });
    result.warnings.push('第三方页面数据只作为缺失字段的末级兼容参考；统计口径与起止日期未核实，不回填正式平台字段。');
    for (const [key, label] of definitions) {
      const raw = values.get(label);
      if (!raw) continue;
      const period = key.startsWith('monthly') || key === 'turnover' ? '页面标注月，起止日未知' : key.startsWith('daily') ? '页面标注日，日期未知' : '页面未说明统计周期';
      addMetric(result, key, raw, 'third_party_rendered_sidebar', 'third_party_unverified', capturedAt, { label: period, start: null, end: null });
    }
    result.status = status(result);
    return result;
  }
  function extract(doc, source, capturedAt, record) {
    const result = empty(source.productId, capturedAt);
    if (source.platform !== 'ozon') return result;
    const merged = merge(publicPage(record, source, capturedAt), thirdParty(doc, source, capturedAt));
    if (!merged.metrics.length) merged.warnings.push('公开商品页没有这些字段；销量、销售额和佣金须由已绑定店铺的Ozon官方Seller API补充。');
    return merged;
  }
  function firstItem(value) {
    return (Array.isArray(value?.items) ? value.items : Array.isArray(value?.result) ? value.result : [])[0] || null;
  }
  function percent(value) { const raw = numericText(value); return raw ? raw + '%' : ''; }
  function daysBetween(from, to, rangeStart, rangeEnd) {
    const start = Math.max(Date.parse(from || ''), Date.parse(rangeStart || ''));
    const end = Math.min(Date.parse(to || ''), Date.parse(rangeEnd || '') + 86400000 - 1);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.ceil((end - start + 1) / 86400000) : null;
  }
  function official(record, responses, context) {
    const capturedAt = context.capturedAt || new Date().toISOString();
    const result = empty(record?.source?.productId || '', capturedAt);
    const sku = String(record?.source?.productId || '');
    const period = { label: 'Ozon官方最近30个自然日（含首尾日）', start: context.dateFrom || null, end: context.dateTo || null };
    const names = Array.isArray(context.metricNames) ? context.metricNames : [];
    const rows = responses?.analytics?.result?.data || [];
    const row = rows.find(item => String(item?.dimensions?.[0]?.id || '') === sku) || (rows.length === 1 ? rows[0] : null);
    const values = new Map(names.map((name, index) => [name, finite(row?.metrics?.[index])]));
    addMetric(result, 'monthlyRevenue', values.get('revenue') === null ? '' : '₽' + numericText(values.get('revenue')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period);
    addMetric(result, 'monthlyUnits', numericText(values.get('ordered_units')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period);
    addMetric(result, 'cardViews', numericText(values.get('hits_view_pdp')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period, '官方指标 hits_view_pdp');
    addMetric(result, 'searchViews', numericText(values.get('hits_view_search')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period, '官方指标 hits_view_search');
    addMetric(result, 'cardCartRate', percent(values.get('conv_tocart_pdp')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period, '官方指标 conv_tocart_pdp');
    addMetric(result, 'searchCartRate', percent(values.get('conv_tocart_search')), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period, '官方指标 conv_tocart_search');
    const cardViews = values.get('hits_view_pdp'); const searchViews = values.get('hits_view_search');
    if (cardViews !== null && searchViews > 0) addMetric(result, 'clickRate', percent(cardViews * 100 / searchViews), 'ozon_official_seller_api', 'official_derived', capturedAt, period, 'hits_view_pdp ÷ hits_view_search');
    const ordered = values.get('ordered_units'); const returns = values.get('returns'); const cancellations = values.get('cancellations');
    if (ordered > 0 && returns !== null && cancellations !== null) addMetric(result, 'returnRate', percent((returns + cancellations) * 100 / ordered), 'ozon_official_seller_api', 'official_derived', capturedAt, period, '(returns + cancellations) ÷ ordered_units');
    const turnover = (responses?.turnover?.items || []).find(item => String(item?.sku || '') === sku);
    if (turnover && finite(turnover.turnover) !== null) addMetric(result, 'turnover', numericText(turnover.turnover) + '天' + (turnover.turnover_grade ? '（' + text(turnover.turnover_grade, 50) + '）' : ''), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: 'Ozon官方库存周转快照', start: null, end: null });
    const info = firstItem(responses?.info);
    const attributes = firstItem(responses?.attributes);
    const price = firstItem(responses?.prices);
    const priceCommissions = price?.commissions || {};
    addMetric(result, 'commission', percent(finite(priceCommissions.sales_percent_rfbs)), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品费率快照', start: null, end: null }, 'sales_percent_rfbs');
    const schemas = [...new Set([...(info?.sources || []).map(item => text(item?.source, 30)), ...(info?.commissions || []).map(item => text(item?.sale_schema, 30))].filter(Boolean))];
    addMetric(result, 'fulfillment', schemas.join(' / '), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品快照', start: null, end: null });
    addMetric(result, 'listedAt', info?.created_at, 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品快照', start: null, end: null });
    if (attributes) {
      const unit = text(attributes.dimension_unit, 20); const weightUnit = text(attributes.weight_unit, 20);
      if ([attributes.depth, attributes.width, attributes.height].every(value => finite(value) !== null)) addMetric(result, 'dimensions', [attributes.depth, attributes.width, attributes.height].map(numericText).join(' x ') + unit, 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品包装数据', start: null, end: null });
      if (finite(attributes.weight) !== null) addMetric(result, 'weight', numericText(attributes.weight) + weightUnit, 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品包装数据', start: null, end: null });
      const brandAttribute = (attributes.attributes || []).find(item => /^(?:бренд|brand|品牌)$/i.test(text(item?.name, 80)));
      const brand = brandAttribute?.values?.map(item => text(item?.value, 100)).filter(Boolean).join(' / ');
      addMetric(result, 'brand', brand, 'ozon_official_seller_api', 'official_authorized_store', capturedAt, { label: '当前绑定店铺商品属性', start: null, end: null });
    }
    const actions = price?.marketing_actions?.actions || [];
    const discounts = actions.map(item => finite(item?.value)).filter(value => value !== null);
    if (discounts.length) addMetric(result, 'promotionDiscount', percent(Math.max(...discounts)), 'ozon_official_seller_api', 'official_authorized_store', capturedAt, period, '当前促销活动返回的最大折扣值');
    const promoDays = actions.map(item => daysBetween(item?.date_from, item?.date_to, context.dateFrom, context.dateTo)).filter(value => value !== null);
    if (promoDays.length) addMetric(result, 'promotionDays', String(Math.min(30, promoDays.reduce((sum, value) => sum + value, 0))), 'ozon_official_seller_api', 'official_derived', capturedAt, period, '按官方活动起止日与30日窗口交集计算；重叠活动可能重复，需人工核对');
    for (const failure of Array.isArray(responses?.failures) ? responses.failures : []) result.warnings.push('Ozon官方' + text(failure.command, 60) + '未返回：' + text(failure.error, 100));
    if (!info && !row && !attributes && !price && !turnover) result.warnings.push('绑定店铺中未找到当前SKU；官方Seller API只返回当前店铺有权访问的商品。');
    if (result.metrics.length) addSource(result, { id: 'ozon_official_seller_api', label: 'Ozon官方Seller API', trust: 'official_authorized_store', scope: 'bound_store_own_product', clientId: text(context.clientId, 120), period });
    result.status = status(result);
    return result;
  }
  function applyOfficial(record, responses, context) {
    const next = JSON.parse(JSON.stringify(record));
    next.analytics = merge(official(next, responses, context || {}), next.analytics);
    return next;
  }
  function calculate(input) {
    const money = ['sale', 'purchase', 'domestic', 'international', 'other'];
    const percentFields = ['commission', 'advertising'];
    const inputLabels = { sale: '售价', purchase: '采购成本', domestic: '国内单件运费', international: '国际单件物流费', other: '其他单件成本', commission: '佣金率', advertising: '广告费率' };
    if (!['CNY', 'RUB', 'BYN', 'KZT'].includes(input.currency)) return { status: 'invalid', message: '请选择同一币种，混合币种请先自行核实换算。' };
    for (const key of money.concat(percentFields)) {
      if (input[key] === '' || input[key] === undefined) return { status: 'incomplete', message: '请填写' + inputLabels[key] + '，确实没有才填0；未知不按0计算。' };
      if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(String(input[key]))) return { status: 'invalid', message: inputLabels[key] + '须为非负数，最多两位小数。' };
    }
    const cents = value => { const [whole, part = ''] = String(value).split('.'); return BigInt(whole) * 100n + BigInt(part.padEnd(2, '0')); };
    const sale = cents(input.sale); const commission = cents(input.commission); const ads = cents(input.advertising);
    if (sale <= 0n || commission > 10000n || ads > 10000n) return { status: 'invalid', message: '售价须大于0；单项费率不能超过100%。' };
    const commissionFee = (sale * commission + 5000n) / 10000n;
    const advertisingFee = (sale * ads + 5000n) / 10000n;
    const costs = money.slice(1).reduce((sum, key) => sum + cents(input[key]), 0n) + commissionFee + advertisingFee;
    const profit = sale - costs;
    const fixed = value => (value < 0n ? '-' : '') + ((value < 0n ? -value : value) / 100n) + '.' + String((value < 0n ? -value : value) % 100n).padStart(2, '0');
    return { status: 'estimate', currency: input.currency, commissionFee: fixed(commissionFee), advertisingFee: fixed(advertisingFee), totalCost: fixed(costs), profit: fixed(profit), marginPercent: fixed(profit * 10000n / sale), basis: 'user_inputs_only', disclaimer: '简化单件试算；费率按售价计、逐项四舍五入到分。不是平台结算报价，税费/退货/仓储等须自行计入其他成本。' };
  }
  return { definitions, compatibilityDefinitions, extract, publicPage, thirdParty, official, applyOfficial, merge, calculate };
});
