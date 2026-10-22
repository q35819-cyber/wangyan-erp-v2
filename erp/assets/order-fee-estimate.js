/* 未签收费用使用当前商品佣金、物流方案和同店同履约实际收单样本。 */
(function (root, factory) {
  var format = typeof module === 'object' && module.exports ? require('./online-product-format') : root.WYERP_ONLINE_FORMAT;
  var profit = typeof module === 'object' && module.exports ? require('./online-product-profit') : root.WYERP_ONLINE_PROFIT;
  var statistics = typeof module === 'object' && module.exports ? require('./order-statistics') : root.WYERP_ORDER_STATISTICS;
  var operations = typeof module === 'object' && module.exports ? require('./order-operations') : root.WYERP_ORDER_OPS;
  var api = factory(format, profit, statistics, operations);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ORDER_FEE_ESTIMATE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (format, profit, statistics, operations) {
  'use strict';

  function number(value) {
    if (value == null || value === '' || value === '--') return null;
    var parsed = Number(String(value).replace(/[\s,，￥¥₽]/g, '').replace(/RUB|CNY|RMB/ig, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function round(value) { return Math.round(Number(value) * 100) / 100; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function sku(item) { return text(item && (item.sku != null ? item.sku : (item.id != null ? item.id : item.offerId))); }
  function quantity(item) { var value = number(item && item.qty); return value > 0 ? value : 1; }
  function clientId(value) { return text(value && (value.clientId || value.externalShopId || value.shopId)); }
  function shop(value) { return text(value && value.shop); }
  function scheme(value) { return format && format.normalizeSchema ? format.normalizeSchema(value) : text(value); }
  function key(order, item) { return clientId(order) + '|' + shop(order) + '|' + sku(item); }

  function estimatedRevenueRub(order, settings) {
    settings = settings || {};
    var rate = number(settings.rate);
    if (!(rate > 0)) rate = 1 / 12;
    var revenueCny = statistics.orderAmountCny(order);
    return revenueCny != null && revenueCny >= 0 ? round(revenueCny / rate) : null;
  }

  function signedSamples(orders) {
    var map = {};
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      if (!order || order.status !== '已签收' || !order.finance) return;
      if (order.ret || order.retFrom || order.finance.resaleIncomeRub != null || order.finance.returnFeeRub != null) return;
      var items = (Array.isArray(order.items) ? order.items : []).filter(function (item) { return !!sku(item); });
      var distinct = items.map(sku).filter(function (value, index, values) { return values.indexOf(value) === index; });
      if (distinct.length !== 1) return;
      var units = items.reduce(function (sum, item) { return sum + quantity(item); }, 0);
      var amountRub = number(order.finance.orderAmountRub);
      var commissionRub = number(order.finance.ozonFeeRub);
      var internationalRub = number(order.finance.intlLogisticsRub);
      var commissionRate = amountRub > 0 && commissionRub > 0 ? commissionRub / amountRub : null;
      if (commissionRate != null && commissionRate > 0.7) commissionRate = null;
      var sample = {
        orderTime: text(order.orderTime), deliveredDate: text(order.deliveredDate), posting: text(order.posting),
        commissionRate: commissionRate,
        internationalPerUnitRub: units > 0 && internationalRub > 0 ? internationalRub / units : null
      };
      if (sample.commissionRate == null && sample.internationalPerUnitRub == null) return;
      var sampleKey = key(order, items[0]);
      if (!map[sampleKey] || sample.orderTime > map[sampleKey].orderTime) map[sampleKey] = sample;
    });
    return map;
  }

  function sampleFor(samples, order, item) {
    return samples && samples[key(order, item)] || null;
  }

  function productFor(products, order, item) {
    var wantedSku = sku(item);
    var candidates = (Array.isArray(products) ? products : []).filter(function (product) { return sku(product) === wantedSku; });
    if (!candidates.length) return null;
    var cid = clientId(order);
    if (cid) {
      var cidMatches = candidates.filter(function (product) { return clientId(product) === cid; });
      if (cidMatches.length === 1) return cidMatches[0];
      if (cidMatches.length > 1) candidates = cidMatches;
    }
    var shopName = shop(order);
    if (shopName) {
      var shopMatches = candidates.filter(function (product) { return shop(product) === shopName; });
      if (shopMatches.length === 1) return shopMatches[0];
      if (shopMatches.length > 1) candidates = shopMatches;
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  function estimate(order, products, logistics, settings, samples) {
    settings = settings || {};
    var original = order && order.finance || {};
    if (!order || order.status === '已签收') return Object.assign({}, original, { ozonFeeEstimated: false, intlLogisticsEstimated: false });
    var rate = number(settings.rate);
    if (!(rate > 0)) rate = 1 / 12;
    var items = Array.isArray(order.items) ? order.items : [];
    var currentScheme = scheme(logistics && logistics.defaultScheme);
    var commissionRub = 0, internationalRub = 0, commissionReady = !!items.length, internationalReady = !!items.length;
    var commissionSources = [], internationalSources = [], referenceSources = [];

    items.forEach(function (item) {
      var units = quantity(item);
      var sample = sampleFor(samples || {}, order, item);
      var product = productFor(products, order, item);
      var unitPriceCny = number(item && item.price);
      var lineAmountCny = unitPriceCny != null ? unitPriceCny * units : null;
      var productScheme = scheme(product && product.commissionSchema);
      var percent = productScheme === currentScheme && format && format.percentage ? number(format.percentage(product && product.commissionPercent)) : null;
      if (percent != null && percent >= 0 && lineAmountCny > 0) {
        var lineCommissionCny = lineAmountCny * percent / 100;
        commissionRub += lineCommissionCny / rate;
        commissionSources.push('佣金来源：在线商品Ozon ' + currentScheme + '佣金比例' + percent + '%；订单商品金额¥' + round(lineAmountCny) + ' × ' + percent + '% = ¥' + round(lineCommissionCny) + '（' + round(lineCommissionCny / rate) + ' RUB，1 CNY = ' + round(1 / rate) + ' RUB）');
      } else {
        commissionReady = false;
      }

      if (product && unitPriceCny > 0 && profit && profit.logisticsQuote) {
        var quote = profit.logisticsQuote(product, logistics, { rub: unitPriceCny / rate }, settings.market || '俄罗斯');
        if (quote && quote.ready) {
          var lineInternationalCny = quote.price * units;
          internationalRub += lineInternationalCny / rate;
          internationalSources.push('国际物流来源：' + [quote.provider, quote.version, quote.scheme, quote.group, quote.transportMode, quote.channel, '计费重' + round(quote.chargeableKg) + 'kg'].filter(Boolean).join(' · ') + '；单件报价¥' + round(quote.price) + ' × 数量' + units + ' = ¥' + round(lineInternationalCny) + '（' + round(lineInternationalCny / rate) + ' RUB，1 CNY = ' + round(1 / rate) + ' RUB）');
        } else internationalReady = false;
      } else internationalReady = false;

      if (sample) {
        var comparison = '历史对照：已签收货件' + (sample.posting || '--') + '，签收时间' + (sample.deliveredDate || sample.orderTime || '--');
        if (sample.commissionRate != null) comparison += '，实际佣金率' + round(sample.commissionRate * 100) + '%';
        if (sample.internationalPerUnitRub != null) comparison += '，单位国际物流' + round(sample.internationalPerUnitRub) + ' RUB';
        referenceSources.push(comparison + '；仅作对照，未参与本次预估');
      }
    });

    var result = Object.assign({}, original);
    var revenueRub = estimatedRevenueRub(order, settings);
    result.estimatedRevenueRub = revenueRub;
    result.estimatedRevenueSource = revenueRub == null ? '订单商品人民币售价或数量待补全' : '订单商品人民币售价按当前汇率折算';
    if (commissionReady) {
      result.ozonFeeRub = round(commissionRub);
      result.ozonFee = result.ozonFeeRub + ' RUB';
      result.ozonFeeEstimated = true;
      result.ozonFeeEstimateSource = commissionSources.concat(referenceSources).filter(function (value, index, values) { return values.indexOf(value) === index; }).join('；');
    } else {
      result.ozonFeeRub = null;
      result.ozonFee = null;
      result.ozonFeeEstimated = true;
      result.ozonFeeEstimateSource = '待补佣金比例：在线商品缺少与我的方案匹配的佣金比例';
    }
    if (internationalReady) {
      result.intlLogisticsRub = round(internationalRub);
      result.intlLogistics = result.intlLogisticsRub + ' RUB';
      result.intlLogisticsEstimated = true;
      result.intlLogisticsEstimateSource = internationalSources.concat(referenceSources).filter(function (value, index, values) { return values.indexOf(value) === index; }).join('；');
    } else {
      result.intlLogisticsRub = null;
      result.intlLogistics = null;
      result.intlLogisticsEstimated = true;
      result.intlLogisticsEstimateSource = '待补国际物流报价：我的物流方案、商品重量尺寸或可用渠道不完整';
    }
    var hasActualAcquiring = (result.feeItems || []).some(function (item) { return item && item.kind === 'acq'; });
    if (!hasActualAcquiring && profit && profit.acquiringEstimate) {
      var acquiring = profit.acquiringEstimate(settings.orders || [], order, revenueRub);
      if (acquiring && acquiring.amountRub != null) {
        result.acquiringRub = acquiring.amountRub;
        result.acquiring = acquiring.amountRub + ' RUB';
        result.acquiringEstimated = true;
        result.acquiringEstimateRate = acquiring.percent;
        result.acquiringEstimateSource = acquiring.source;
      } else {
        var tieredRub = statistics && statistics.estimateAcquiringRub ? statistics.estimateAcquiringRub(revenueRub) : null;
        if (tieredRub != null) {
          result.acquiringRub = tieredRub;
          result.acquiring = tieredRub + ' RUB';
          result.acquiringEstimated = true;
          result.acquiringEstimateSource = '收单业务费分层预估：min(' + round(revenueRub) + ' RUB，1500) × 1.4% + max(' + round(revenueRub) + ' RUB − 1500，0) × 1.9% = ' + tieredRub + ' RUB（' + (acquiring && acquiring.reason || '没有可用的已签收实际样本') + '，按已确认分层公式预估）';
        } else {
          result.acquiringRub = null;
          result.acquiring = null;
          result.acquiringEstimated = true;
          result.acquiringEstimateSource = '待补订单金额：无法预估收单业务费（' + (acquiring && acquiring.reason || '没有可用的已签收实际样本') + '）';
        }
      }
    } else if (hasActualAcquiring) {
      result.acquiringEstimated = false;
      result.acquiringEstimateSource = '';
    }
    if (revenueRub != null && !((result.feeItems || []).some(function (item) { return item && item.kind === 'last'; }))) {
      result.lastMileRub = round(Math.min(200, Math.max(15, revenueRub * 0.02)));
      result.lastMile = result.lastMileRub + ' RUB';
      result.lastMileEstimated = true;
      result.lastMileEstimateSource = '尾程费预估：max(' + round(revenueRub) + ' RUB × 2%，15 RUB)，最高200 RUB；签收后仅以Ozon接口实际明细替换';
    }
    var damageLossPct = number(settings.damageLossPct);
    if (damageLossPct == null || damageLossPct < 0) damageLossPct = 6;
    var advertisingPct = number(settings.advertisingPct);
    if (advertisingPct == null || advertisingPct < 0) advertisingPct = 2;
    result.damageLossPct = damageLossPct;
    result.advertisingBudgetPct = advertisingPct;
    result.damageLossEstimatedRub = revenueRub == null ? null : round(revenueRub * damageLossPct / 100);
    result.advertisingBudgetEstimatedRub = revenueRub == null ? null : round(revenueRub * advertisingPct / 100);
    result.damageLossEstimateSource = '主账号定价设置：货损率 ' + damageLossPct + '% × 预估销售额';
    result.advertisingBudgetEstimateSource = '主账号定价设置：广告费率 ' + advertisingPct + '% × 预估销售额';
    return result;
  }

  // 整批投影仅用于显示与统计；完整订单集合保持库存分配、运费归组和收单样本一致。
  function projectOrders(input, products, logistics, settings) {
    var orders = (input || []).map(function (order, index) {
      // 显示可跳过空位，行操作仍必须指向原始数组；该临时字段不写回业务数据。
      return order && Object.assign({}, order, { _sourceIndex: index, items: (order.items || []).map(function (item) { return item && Object.assign({}, item); }) });
    }).filter(Boolean);
    operations.applyStock(orders);
    var groups = operations.buildShipGroups(orders), samples = signedSamples(orders);
    var options = Object.assign({}, settings, { orders: orders });
    return orders.map(function (order) {
      var finance = statistics.financeMode(order) === 'est'
        ? estimate(order, products, logistics, options, samples) : Object.assign({}, order.finance);
      finance.purchaseCost = statistics.purchaseCostCny(order, finance, groups);
      order.finance = finance;
      return order;
    });
  }

  return { estimate: estimate, projectOrders: projectOrders, signedSamples: signedSamples, productFor: productFor, estimatedRevenueRub: estimatedRevenueRub };
});
