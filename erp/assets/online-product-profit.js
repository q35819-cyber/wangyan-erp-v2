/* 在线商品预估利润：复用订单管理费用口径，并按“我的方案”真实资费报价 */
(function (root, factory) {
  var format = typeof module === 'object' && module.exports ? require('./online-product-format') : root.WYERP_ONLINE_FORMAT;
  var api = factory(format);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ONLINE_PROFIT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (format) {
  'use strict';

  var GROUP_ORDER = ['Extra Small', 'Budget', 'Small', 'Big', 'Premium Small', 'Premium Big', 'HK'];

  function number(value) {
    if (value == null || value === '' || value === '--') return null;
    var cleaned = String(value).trim().replace(/[\s,，]/g, '').replace(/[￥¥₽$€]/g, '').replace(/RUB|CNY|RMB/ig, '');
    var parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function round(value) { return Math.round(Number(value) * 100) / 100; }
  function text(value) { return String(value == null ? '' : value).trim(); }
  function orderShop(value) { return text(value && (value.clientId || value.externalShopId || value.shopId || value.shop)); }
  function orderGroup(value) { var schema = text(value && value.deliverySchema); return schema.toUpperCase() === 'WHD' ? 'WHD' : normalizeScheme(schema); }
  function median(values) {
    var sorted = values.slice().sort(function (left, right) { return left - right; });
    if (!sorted.length) return null;
    var middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  // 从当前租户真实已签收订单反推收单规则。低金额订单存在最低实扣，
  // 因此不能用简单平均百分比；基础比例取中位数，最低额取高频实扣值。
  function acquiringEstimateRule(orders, target) {
    var targetShop = orderShop(target);
    var targetGroup = orderGroup(target);
    if (!targetShop || !targetGroup) return { ready: false, reason: '订单店铺或履约方案待补全，无法匹配实际收单样本' };
    function collect() {
      return (Array.isArray(orders) ? orders : []).filter(function (order) {
        if (!order || order.status !== '已签收' || !order.finance || orderGroup(order) !== targetGroup) return false;
        if (order.ret || order.retFrom || order.finance.resaleIncomeRub != null || order.finance.returnFeeRub != null) return false;
        if (orderShop(order) !== targetShop) return false;
        var amount = number(order.finance.orderAmountRub);
        var fee = number(order.finance.acquiringRub);
        var actual = (order.finance.feeItems || []).some(function (item) { return item && item.kind === 'acq'; });
        return actual && order.finance.acquiringEstimated !== true && amount > 0 && fee > 0;
      }).map(function (order) {
        return { amount: number(order.finance.orderAmountRub), fee: number(order.finance.acquiringRub) };
      });
    }
    var samples = collect();
    var scope = '同店铺同履约';
    if (!samples.length) return { ready: false, reason: '没有同店铺同履约的已签收实际收单业务费样本' };
    var baseRate = median(samples.map(function (sample) { return sample.fee / sample.amount; }));
    var frequencies = {};
    samples.forEach(function (sample) {
      var key = sample.fee.toFixed(2);
      frequencies[key] = (frequencies[key] || 0) + 1;
    });
    var floorKey = Object.keys(frequencies).sort(function (left, right) {
      return frequencies[right] - frequencies[left] || Number(left) - Number(right);
    })[0];
    var floorRub = floorKey && frequencies[floorKey] >= Math.max(2, Math.ceil(samples.length * 0.2)) ? Number(floorKey) : 0;
    return {
      ready: true,
      rate: baseRate,
      percent: round(baseRate * 100),
      floorRub: round(floorRub),
      sampleCount: samples.length,
      scope: scope
    };
  }

  function estimateAcquiringRub(amount) {
    if (!(amount > 0)) return null;
    return round(Math.min(amount, 1500) * 0.014 + Math.max(amount - 1500, 0) * 0.019);
  }

  function acquiringEstimate(orders, target, amountRub) {
    var rule = acquiringEstimateRule(orders, target);
    if (!rule.ready || !(amountRub > 0)) return Object.assign({}, rule, { amountRub: null });
    var proportional = round(amountRub * rule.rate);
    var amount = round(Math.max(proportional, rule.floorRub || 0));
    return Object.assign({}, rule, {
      amountRub: amount,
      source: '收单业务费预估：' + rule.scope + rule.sampleCount + '单实际数据反推；基础费率中位数' + rule.percent + '%' + (rule.floorRub > 0 ? '，最低实扣' + rule.floorRub + ' RUB' : '') + '；max(' + round(amountRub) + ' RUB × ' + rule.percent + '%' + (rule.floorRub > 0 ? '，' + rule.floorRub + ' RUB' : '') + ') = ' + amount + ' RUB'
    });
  }
  function returnHandlingEstimate(orders, target) {
    var targetShop = orderShop(target);
    var targetGroup = orderGroup(target);
    if (!targetShop || !targetGroup) return { ready: false, reason: '订单店铺或履约方案待补全，无法匹配退货处理样本' };
    var samples = (Array.isArray(orders) ? orders : []).filter(function (order) {
      if (!order || order.status !== '已签收' || !order.finance || orderGroup(order) !== targetGroup) return false;
      if (order.ret || order.retFrom || order.finance.resaleIncomeRub != null) return false;
      if (orderShop(order) !== targetShop) return false;
      return true;
    });
    if (!samples.length) return { ready: false, reason: '没有同店铺同履约的已签收样本' };
    var totalFee = 0;
    samples.forEach(function (order) {
      var items = Array.isArray(order.finance.feeItems) ? order.finance.feeItems : [];
      totalFee += items.filter(function (item) { return item && String(item.type) === '9'; })
        .reduce(function (sum, item) { return sum + (Number(item.amount) || 0); }, 0);
    });
    var avgPerOrder = round(totalFee / samples.length);
    return {
      ready: true,
      avgPerOrder: avgPerOrder,
      sampleCount: samples.length,
      totalFee: round(totalFee),
      source: '退货处理费预估：同店铺同履约' + samples.length + '单平均；总退货处理费' + round(totalFee) + ' RUB ÷ ' + samples.length + '单 = ' + avgPerOrder + ' RUB/单'
    };
  }

  function normalizeCurrency(value, price) {
    var source = String(value || '').trim().toUpperCase();
    if (source === 'CNY' || source === 'RMB' || source === 'CNH' || /^[￥¥]/.test(String(price || ''))) return 'CNY';
    if (source === 'RUB' || /^[₽]/.test(String(price || ''))) return 'RUB';
    return '';
  }
  function normalizeScheme(value) { return format && format.normalizeSchema ? format.normalizeSchema(value) : String(value || ''); }

  function saleAmounts(product, rate) {
    var raw = product && (product.pricePromo != null ? product.pricePromo : (product.marketing_price != null ? product.marketing_price : product.marketing_seller_price));
    var amount = number(raw);
    var currency = normalizeCurrency(product && product.priceCurrency, raw);
    if (!(amount > 0) || !(rate > 0) || !currency) return null;
    return currency === 'CNY'
      ? { currency: currency, original: amount, cny: amount, rub: amount / rate }
      : { currency: currency, original: amount, cny: amount * rate, rub: amount };
  }

  function packageValues(product) {
    var metrics = format && format.packageMetrics ? format.packageMetrics(product) : {};
    var dimensions = [metrics.lengthMm, metrics.widthMm, metrics.heightMm];
    if (!(metrics.weightG > 0) || !dimensions.every(function (value) { return value > 0; })) return null;
    return { actualKg: metrics.weightG / 1000, dimensionsCm: dimensions.map(function (value) { return value / 10; }) };
  }

  function inRange(value, range) {
    range = range || {};
    if (range.min != null && Number.isFinite(Number(range.min)) && value + 1e-9 < Number(range.min)) return false;
    if (range.max != null && Number.isFinite(Number(range.max)) && value - 1e-9 > Number(range.max)) return false;
    return true;
  }

  function ruleQuote(rule, pack, declaredRub) {
    var dimensions = pack.dimensionsCm;
    var limits = rule.dimensions || {};
    if (limits.maxSideCm != null && Math.max.apply(Math, dimensions) > Number(limits.maxSideCm)) return null;
    if (limits.maxSumCm != null && dimensions.reduce(function (sum, value) { return sum + value; }, 0) > Number(limits.maxSumCm)) return null;
    if (!inRange(declaredRub, rule.declaredValueRub)) return null;
    var billing = rule.billing || {};
    var divisor = Number(billing.divisor) || null;
    var volumeKg = divisor ? dimensions[0] * dimensions[1] * dimensions[2] / divisor : null;
    var chargeableKg = pack.actualKg;
    if (billing.mode === 'volumetric' && volumeKg != null) chargeableKg = Math.max(chargeableKg, volumeKg);
    if (billing.mode === 'conditional_volume' && dimensions.reduce(function (sum, value) { return sum + value; }, 0) > 60 && volumeKg != null) chargeableKg = Math.max(chargeableKg, volumeKg);
    var increment = Number(rule.rate && rule.rate.incrementKg) || 0.001;
    chargeableKg = Math.ceil(chargeableKg / increment - 1e-9) * increment;
    if (!inRange(chargeableKg, rule.weightKg)) return null;
    var perKg = number(rule.rate && rule.rate.perKg);
    if (perKg == null || perKg < 0) return null;
    var price = chargeableKg * perKg + (number(rule.rate && rule.rate.fixed) || 0);
    return { price: round(price), actualKg: pack.actualKg, volumeKg: volumeKg, chargeableKg: chargeableKg };
  }

  function logisticsQuote(product, logistics, sale, market) {
    if (!logistics) return { ready: false, reason: '物流配置尚未加载' };
    var scheme = normalizeScheme(logistics.defaultScheme);
    if (!scheme) return { ready: false, reason: '我的方案未设置默认履约方案' };
    var pack = packageValues(product);
    if (!pack) return { ready: false, reason: '商品重量或尺寸不完整' };
    var preferences = Array.isArray(logistics.preferences) ? logistics.preferences : [];
    var active = (Array.isArray(logistics.items) ? logistics.items : []).filter(function (item) { return item && item.active; });
    var targetMarket = market || '俄罗斯';
    var candidates = [];
    preferences.forEach(function (preference, preferenceIndex) {
      if (normalizeScheme(preference && preference.scheme) !== scheme || String(preference.market || '') !== targetMarket) return;
      active.filter(function (config) { return String(config.provider || '') === String(preference.provider || ''); }).forEach(function (config) {
        (Array.isArray(config.rules) ? config.rules : []).forEach(function (rule) {
          if (normalizeScheme(rule.scheme) !== scheme || String(rule.market || '') !== targetMarket || String(rule.group || '') !== String(preference.group || '') || String(rule.transportMode || '') !== String(preference.transportMode || '')) return;
          var calculated = ruleQuote(rule, pack, sale.rub);
          if (!calculated) return;
          candidates.push(Object.assign(calculated, {
            provider: config.provider || rule.provider || '', version: config.version || '', scheme: scheme, market: targetMarket,
            group: rule.group || '', transportMode: rule.transportMode || '', channel: rule.channel || '', billing: rule.billing || {},
            preferenceIndex: preferenceIndex, groupIndex: Math.max(0, GROUP_ORDER.indexOf(rule.group))
          }));
        });
      });
    });
    if (!candidates.length) return { ready: false, reason: preferences.some(function (item) { return normalizeScheme(item && item.scheme) === scheme && String(item.market || '') === targetMarket; }) ? '重量尺寸不符合我的方案渠道限制' : '我的方案没有可用的俄罗斯渠道' };
    candidates.sort(function (left, right) { return left.price - right.price || left.preferenceIndex - right.preferenceIndex || left.groupIndex - right.groupIndex; });
    return Object.assign({ ready: true }, candidates[0]);
  }

  function commissionCost(product, scheme, sale, rate) {
    var storedScheme = normalizeScheme(product && product.commissionSchema);
    var amountScheme = normalizeScheme(product && (product.commissionAmountSchema || product.fulfillmentSchema));
    if (!scheme || storedScheme !== scheme) return { value: null, source: '佣金待同步' };
    var amount = number(product && product.commission);
    if (amountScheme === scheme && amount != null && amount >= 0) return { value: round(sale.currency === 'CNY' ? amount : amount * rate), source: 'Ozon commissions.value' };
    var percent = number(product && product.commissionPercent);
    if (percent == null || percent < 0 || percent > 100) return { value: null, source: '佣金待同步' };
    return { value: round(sale.cny * percent / 100), source: 'Ozon commissions.percent × 当前促销价' };
  }

  function calculate(product, logistics, settings) {
    settings = settings || {};
    var rate = number(settings.rate);
    if (!(rate > 0)) rate = 1 / 12;
    var manualFee = number(settings.manualFee);
    if (manualFee == null || manualFee < 0) manualFee = 0;
    var sale = saleAmounts(product || {}, rate);
    if (!sale) return { ready: false, reason: '促销价或币种缺失', rate: rate };
    var scheme = normalizeScheme(logistics && logistics.defaultScheme);
    var commission = commissionCost(product || {}, scheme, sale, rate);
    var quote = logisticsQuote(product || {}, logistics, sale, settings.market || '俄罗斯');
    var purchasePrice = number(product && product.purchasePrice);
    var domesticShipping = number(product && product.domesticShipping);
    var lastMileRub = round(Math.min(200, Math.max(15, sale.rub * 0.02)));
    var lastMileCny = round(lastMileRub * rate);
    var acquiringRule = acquiringEstimate(settings.orders, Object.assign({}, product, { deliverySchema: scheme }), sale.rub);
    var acquiringRub = acquiringRule.amountRub;
    var acquiringSource = acquiringRule.source || '';
    if (acquiringRub == null) {
      acquiringRub = estimateAcquiringRub(sale.rub);
      if (acquiringRub != null) acquiringSource = '收单业务费分层预估：min(' + round(sale.rub) + ' RUB，1500) × 1.4% + max(' + round(sale.rub) + ' RUB − 1500，0) × 1.9% = ' + acquiringRub + ' RUB（' + (acquiringRule.reason || '同店铺同履约实际样本不足') + '，按已确认分层公式预估）';
    }
    var acquiringCny = acquiringRub == null ? null : round(acquiringRub * rate);
    var returnHandlingRule = returnHandlingEstimate(settings.orders, Object.assign({}, product, { deliverySchema: scheme }));
    var returnHandlingRub = returnHandlingRule.ready ? returnHandlingRule.avgPerOrder : null;
    var returnHandlingCny = returnHandlingRub != null ? round(returnHandlingRub * rate) : null;
    var withdrawalCny = round(sale.cny * 0.01);
    var damageLossPct = number(settings.damageLossPct);
    if (damageLossPct == null || damageLossPct < 0) damageLossPct = 6;
    var advertisingPct = number(settings.advertisingPct);
    if (advertisingPct == null || advertisingPct < 0) advertisingPct = 2;
    var damageLossCny = round(sale.cny * damageLossPct / 100);
    var advertisingCny = round(sale.cny * advertisingPct / 100);
    var planningFeesCny = round(damageLossCny + advertisingCny);
    var otherCny = acquiringCny == null ? null : round(acquiringCny + withdrawalCny);
    var otherFeesCny = round(lastMileCny + (acquiringCny || 0) + (returnHandlingCny || 0) + withdrawalCny + manualFee);
    var result = {
      ready: false, rate: rate, saleCny: round(sale.cny), saleRub: round(sale.rub), currency: sale.currency,
      saleSource: 'Ozon 当前促销价',
      commissionCny: commission.value, commissionSource: commission.source,
      internationalCny: quote.ready ? quote.price : null, quote: quote,
      purchasePriceCny: purchasePrice, domesticShippingCny: domesticShipping, manualFeeCny: manualFee,
      lastMileRub: lastMileRub, lastMileCny: lastMileCny,
      acquiringRub: acquiringRub, acquiringCny: acquiringCny, acquiringRatePercent: acquiringRule.percent,
      acquiringFloorRub: acquiringRule.floorRub, acquiringSampleCount: acquiringRule.sampleCount, acquiringSource: acquiringSource,
      returnHandlingRub: returnHandlingRub, returnHandlingCny: returnHandlingCny,
      returnHandlingSampleCount: returnHandlingRule.sampleCount, returnHandlingSource: returnHandlingRule.source,
      withdrawalCny: withdrawalCny, damageLossPct: damageLossPct, damageLossCny: damageLossCny, advertisingPct: advertisingPct, advertisingCny: advertisingCny, planningFeesCny: planningFeesCny, otherCny: otherCny, otherFeesCny: otherFeesCny
    };
    if (commission.value == null) { result.reason = '佣金待同步'; return result; }
    if (!quote.ready) { result.reason = quote.reason; return result; }
    if (purchasePrice == null || purchasePrice <= 0) { result.reason = '无采购成本（免费商品请填0.1）'; return result; }
    if (domesticShipping == null || domesticShipping < 0) { result.reason = '国内快递费待填写（无费用请填0）'; return result; }
    var purchaseCostCny = round(purchasePrice + domesticShipping);
    var totalCostCny = round(purchaseCostCny + commission.value + quote.price + otherFeesCny + planningFeesCny);
    var profitCny = round(sale.cny - totalCostCny);
    return Object.assign(result, {
      ready: true, reason: '', purchaseCostCny: purchaseCostCny,
      totalCostCny: totalCostCny, profitCny: profitCny, margin: sale.cny ? profitCny / sale.cny * 100 : null
    });
  }

  return { calculate: calculate, logisticsQuote: logisticsQuote, ruleQuote: ruleQuote,
    acquiringEstimateRule: acquiringEstimateRule, acquiringEstimate: acquiringEstimate, estimateAcquiringRub: estimateAcquiringRub,
    returnHandlingEstimate: returnHandlingEstimate };
});
