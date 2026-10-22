/* 在线商品真实平均成本：只读映射与展示状态，不修改商品业务数据 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ONLINE_COST_VIEW = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var FEE_LABELS = {
    comm: '佣金',
    intl: '国际物流',
    acq: '收单业务费',
    logistics: 'Ozon普通物流',
    advertising: '广告',
    last: '尾程配送',
    return: '退货处理',
    other: '其它平台费用'
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function productSku(product) {
    return text(product && (product.sku ?? product.offerId ?? product.offer_id ?? product.article ?? ''));
  }
  function directShopId(product) {
    return text(product && (product.shopId ?? product.clientId ?? product.externalShopId ?? ''));
  }
  function productShopId(product, shops) {
    var direct = directShopId(product);
    if (direct) return direct;
    var name = text(product && product.shop);
    if (!name) return '';
    var match = (Array.isArray(shops) ? shops : []).find(function (shop) {
      return shop && text(shop.name) === name;
    });
    return text(match && (match.externalShopId ?? match.clientId ?? match.shopId ?? ''));
  }
  function key(shopId, sku) { return text(shopId) + '\u0000' + text(sku); }
  function index(payload) {
    var map = new Map();
    (Array.isArray(payload && payload.items) ? payload.items : []).forEach(function (item) {
      var shopId = text(item && item.shopId), sku = text(item && item.sku);
      if (!shopId || !sku) return;
      map.set(key(shopId, sku), item);
    });
    return map;
  }
  function lookup(map, product, shops) {
    if (!map || typeof map.get !== 'function') return null;
    var shopId = productShopId(product, shops), sku = productSku(product);
    return shopId && sku ? map.get(key(shopId, sku)) || null : null;
  }
  function windowLabel(value) {
    var windowValue = value || {};
    var preset = text(windowValue.preset);
    if (/^(7|30|90)$/.test(preset)) return '近' + preset + '天';
    var days = Number(windowValue.days);
    if (Number.isFinite(days) && days > 0 && preset !== 'custom') return '近' + Math.floor(days) + '天';
    var from = text(windowValue.from).slice(0, 10), to = text(windowValue.to).slice(0, 10);
    return from && to ? from + ' 至 ' + to : '统计窗口待加载';
  }
  function coverageMessage(item) {
    var coverage = text(item && item.coverage);
    var purchaseMissing = Array.isArray(item && item.purchaseMissingComponents) ? item.purchaseMissingComponents : [];
    var feeMissing = Array.isArray(item && item.missingPlatformFeeKeys) ? item.missingPlatformFeeKeys.map(function (key) { return FEE_LABELS[key] || '未识别平台费用'; }) : [];
    if (coverage === 'complete') {
      if (item && item.averageTotalCostCny != null) return '实际费用覆盖完整';
      if (purchaseMissing.indexOf('purchase') >= 0) return '平台费用完整；采购成本待补，平均每件总成本暂不可计算';
      if (purchaseMissing.indexOf('combination_cost') >= 0) return '平台费用完整；组合子项采购成本待补，平均每件总成本暂不可计算';
      return '平台费用完整；采购总成本待补，平均每件总成本暂不可计算';
    }
    var purchaseKnown = item && item.purchaseTotalCostCny != null && Number.isFinite(Number(item.purchaseTotalCostCny));
    if (coverage === 'no_orders') return purchaseKnown
      ? '采购总成本已读取；近30天暂无实际订单，平台费用没有真实样本，实际每件总成本暂不可计算'
      : '近30天暂无实际订单；采购总成本也待补';
    if (coverage === 'allocation_unknown') return (purchaseKnown ? '采购总成本已读取；' : '') + '费用覆盖不完整：订单商品数量缺失，无法可靠分摊平台费用';
    if (coverage === 'partial') return (purchaseKnown ? '采购总成本已读取；' : '') + '费用覆盖不完整：' + (feeMissing.length ? feeMissing.join('、') + '待同步' : '部分订单费用待同步');
    if (coverage === 'unknown') return (purchaseKnown ? '采购总成本已读取；' : '') + '费用覆盖不完整：' + (feeMissing.length ? feeMissing.join('、') + '未知' : '订单费用未知');
    return '实际费用覆盖状态待确认';
  }
  function feeLabel(key) { return FEE_LABELS[key] || text(key); }
  function sumBreakdown(item, keys, currency) {
    var source = item && (currency === 'cny' ? item.averagePlatformFeeBreakdownCny : item.averagePlatformFeeBreakdownRub);
    if (!source) return null;
    var values = (keys || []).map(function (key) { return source[key]; });
    if (values.some(function (value) { return value == null || !Number.isFinite(Number(value)); })) return null;
    return Math.round((values.reduce(function (sum, value) { return sum + Number(value); }, 0) + Number.EPSILON) * 100) / 100;
  }
  function historicalMessage(item) {
    var orders = Number(item && item.historicalMatchedOrderCount || 0);
    var qty = Number(item && item.historicalSoldQuantity || 0);
    if (item && item.historicalSoldQuantityComplete === false) {
      var missing = Number(item.historicalUnknownQuantityOrderCount || 0);
      return '已同步历史 ' + orders + '单；已知' + qty + '件，' + missing + '条商品数量缺失';
    }
    return '已同步历史 ' + orders + '单 / ' + qty + '件';
  }
  function coverageClass(item) {
    var coverage = text(item && item.coverage);
    return coverage === 'complete' ? 'complete' : (coverage === 'no_orders' ? 'empty' : 'incomplete');
  }

  return {
    productSku: productSku,
    productShopId: productShopId,
    key: key,
    index: index,
    lookup: lookup,
    windowLabel: windowLabel,
    coverageMessage: coverageMessage,
    coverageClass: coverageClass,
    feeLabel: feeLabel,
    sumBreakdown: sumBreakdown,
    historicalMessage: historicalMessage
  };
});
