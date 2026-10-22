/* 网研ERP — 订单统计口径（订单页与订单统计页共用） */
(function (root, factory) {
  'use strict';
  var orderOps = root && root.WYERP_ORDER_OPS;
  var feeClassifier = root && root.WYERP_ORDER_FEE_CLASSIFICATION;
  if (typeof module === 'object' && module.exports) {
    orderOps = require('./order-operations');
    feeClassifier = require('./order-fee-classification');
  }
  var api = factory(orderOps, feeClassifier);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ORDER_STATISTICS = api;
})(typeof window !== 'undefined' ? window : null, function (orderOps, feeClassifier) {
  'use strict';

  function number(value) {
    if (value == null || value === '' || value === '--') return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var text = String(value).trim();
    if (/,/.test(text) && text.indexOf('.') < 0) text = text.replace(/[^\d,\-]/g, '').replace(',', '.');
    else text = text.replace(/[^0-9.\-]/g, '');
    var result = parseFloat(text);
    return isFinite(result) ? result : null;
  }
  function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
  function reconcileRoundedParts(total, parts) {
    var target = round(total), values = (parts || []).map(round);
    if (!values.length) return values;
    var cents = Math.round((target - values.reduce(function (sum, value) { return sum + value; }, 0)) * 100);
    if (!cents) return values;
    var index = 0;
    for (var i = 1; i < values.length; i++) if (Math.abs(values[i]) > Math.abs(values[index])) index = i;
    values[index] = round(values[index] + cents / 100);
    return values;
  }

  function cancelShipInfo(order) {
    var cancel = order && order.cancel || {};
    var isQc = /^(02131|02478|02090)/.test(String(order && order.posting || ''));
    var shipped = isQc ? false : (typeof cancel.shipped === 'boolean' ? cancel.shipped : !!(order && order.track && order.track !== '--'));
    var refused = typeof cancel.refused === 'boolean' ? cancel.refused : /拒收|отказал|refus/i.test(String(cancel.whyZh || '') + ' ' + String(cancel.why || ''));
    return { shipped: shipped, refused: refused };
  }

  function financeMode(order) {
    if (!order) return 'est';
    if (order.returned) return 'returned';
    if (order.ret === '已销毁') return 'destroyed';
    if ((order.ret === '在仓库' || order.ret === '已到退货仓库') && !order.retRel && !(order.finance && order.finance.retResalePosting)) return 'inwarehouse';
    if (order.status === '已签收') return 'real';
    if (order.status === '已取消') {
      var shipping = cancelShipInfo(order);
      if (!shipping.shipped) return 'zero';
      return shipping.refused ? 'calc' : 'est';
    }
    return 'est';
  }

  function estimateRevenueRub(finance, rate) {
    var explicitEstimate = number(finance && finance.estimatedRevenueRub);
    if (finance && Object.prototype.hasOwnProperty.call(finance, 'estimatedRevenueRub')) return explicitEstimate != null && explicitEstimate >= 0 ? explicitEstimate : null;
    var revenueCny = number(finance && finance.cnyTotal);
    return revenueCny != null && revenueCny >= 0 && rate > 0 ? revenueCny / rate : null;
  }
  function actualRevenueRub(finance) {
    var gross = number(finance && finance.sellerGrossRub);
    if (gross != null && gross >= 0) return gross;
    var amount = number(finance && finance.orderAmountRub);
    if (amount != null && amount >= 0) return amount;
    return number(finance && finance.orderAmount);
  }
  // 已签收净收入只认 Seller 应计费用页 unit_summary.profit 的接口值。
  // ozonProfitRub 仅兼容旧数据；必须带 accruals 结算来源证据。
  function actualNetIncomeRub(finance) {
    if (!finance) return null;
    var direct = number(finance.ozonNetIncomeRub);
    if (direct != null && isFinite(direct)) return direct;
    var legacy = number(finance.ozonProfitRub);
    var source = String(finance.ozonNetIncomeRubSource || finance.sellerPayoutRubSource || finance.settlementSource || '');
    if (legacy != null && isFinite(legacy) && /accruals_details|unit_summary_profit/.test(source)) return legacy;
    return null;
  }

  function orderCnyPerRub(finance) {
    finance = finance || {};
    var direct = number(finance.orderCnyPerRub);
    if (direct != null && isFinite(direct) && direct > 0) return direct;
    var rubPerCny = number(finance.orderRubPerCny);
    if (rubPerCny != null && isFinite(rubPerCny) && rubPerCny > 0) return 1 / rubPerCny;
    return null;
  }
  function orderRubPerCny(finance) {
    var cnyPerRub = orderCnyPerRub(finance);
    return cnyPerRub != null && cnyPerRub > 0 ? 1 / cnyPerRub : null;
  }

  // purchaseCost 已包含采购价、国内快递及组合商品成本。
  function domesticCostDetails(finance, rate, manualFee, requireLockedRate) {
    finance = finance || {};
    var purchaseCny = number(finance.purchaseCost);
    var lockedRate = orderCnyPerRub(finance);
    var appliedRate = lockedRate != null ? lockedRate : (requireLockedRate ? null : number(rate));
    if (purchaseCny == null || purchaseCny <= 0 || !(appliedRate > 0)) return null;
    var gross = actualRevenueRub(finance);
    if (gross == null || !isFinite(gross) || gross < 0) return null;
    var purchaseRub = purchaseCny / appliedRate;
    var lianlianRub = withdrawalFee(gross);
    var manualFeeRub = (Number(manualFee) || 0) / appliedRate;
    var extraRub = number(finance.domesticOtherCostRub) || 0;
    var extraCny = number(finance.domesticOtherCostCny) || 0;
    var extraCnyRub = extraCny / appliedRate;
    return {
      purchaseCny: purchaseCny, purchaseRub: round(purchaseRub), lianlianRub: round(lianlianRub),
      manualFeeCny: Number(manualFee) || 0, manualFeeRub: round(manualFeeRub),
      otherDomesticRub: round(extraRub + extraCnyRub),
      totalRub: round(purchaseRub + lianlianRub + manualFeeRub + extraRub + extraCnyRub),
      cnyPerRub: appliedRate, rubPerCny: 1 / appliedRate,
      rateDate: String(finance.orderRateDate || ''), rateEffectiveDate: String(finance.orderRateEffectiveDate || ''),
      rateSource: String(finance.orderRateSource || (lockedRate != null ? 'order_locked' : 'page_current')),
      lockedRate: lockedRate != null
    };
  }

  // 人民币订单金额只来自订单商品人民币单价×数量；旧 cnyTotal 仅兼容同来源存量，禁止由卢布按汇率反推。
  function orderAmountCny(order, financeOverride) {
    order = order || {};
    var items = Array.isArray(order.items) ? order.items : [];
    if (items.length) {
      var total = 0;
      var complete = items.every(function (item) {
        var price = number(item && item.price);
        var quantity = number(item && item.qty);
        if (price == null || price < 0 || !(quantity > 0)) return false;
        total += price * quantity;
        return true;
      });
      return complete ? round(total) : null;
    }
    return null;
  }

  function feeType(item) {
    if (feeClassifier && feeClassifier.feeType) return feeClassifier.feeType(item);
    return String(item && (item.type != null ? item.type : item.accrual_type) || '').trim().toLowerCase();
  }
  function feeKind(item) {
    if (feeClassifier && feeClassifier.classify) return feeClassifier.classify(item);
    return String(item && item.kind || 'other');
  }
  function isAcquiringFee(item) { return feeKind(item) === 'acq'; }
  function canTrustFeeItems(finance) {
    // items 有明细时优先按原始 type_id 重算；items 为空则回退已保存的聚合字段。
    // 这样既兼容历史聚合缓存，也能保留接口明确返回“0费用”的订单字段。
    return Boolean(finance && Array.isArray(finance.feeItems) && finance.feeItems.length);
  }
  function performanceCpoItems(finance) {
    return finance && Array.isArray(finance.performanceCpoItems) ? finance.performanceCpoItems.filter(Boolean) : [];
  }
  function hasCpoAdvertising(items) {
    return Boolean(feeClassifier && feeClassifier.advertisingChargeModel && (items || []).some(function (item) {
      return feeKind(item) === 'advertising' && feeClassifier.advertisingChargeModel(item) === 'CPO';
    }));
  }
  function summarizeFeeItemsWithPerformance(finance, baseItems) {
    if (!feeClassifier || !feeClassifier.summarize) return null;
    var base = Array.isArray(baseItems) ? baseItems : [];
    var extra = performanceCpoItems(finance);
    var combined = hasCpoAdvertising(base) ? base : base.concat(extra);
    return combined.length ? feeClassifier.summarize(combined) : null;
  }
  function actualFeeSummary(finance) {
    if (!canTrustFeeItems(finance)) return null;
    return summarizeFeeItemsWithPerformance(finance, finance.feeItems);
  }
  function feeSummaryByRole(finance, role) {
    if (!finance || !Array.isArray(finance.feeItems) || !feeClassifier || !feeClassifier.summarize) return null;
    var items = finance.feeItems.filter(function (item) {
      var origin = item && item.feeRole === 'origin_refusal';
      return role === 'origin_refusal' ? origin : !origin;
    });
    if (role === 'origin_refusal') return items.length ? feeClassifier.summarize(items) : null;
    return summarizeFeeItemsWithPerformance(finance, items);
  }
  function categoryHas(finance, category) {
    return Boolean(finance && Array.isArray(finance.feeItems) && finance.feeItems.some(function (item) { return feeKind(item) === category; }));
  }

  function commissionFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.comm;
    var value = finance.ozonFeeRub != null ? Number(finance.ozonFeeRub) : number(finance.ozonFee);
    return value == null || !isFinite(value) ? null : round(value);
  }

  // 旧数据曾把 type=66(收单)、type=59(逆向物流)、type=32(普通物流)误塞进国际物流。
  // 只要保存了原始feeItems，就按Ozon费用类型重新分类，不再信任旧kind/旧合计。
  function legacyInternationalCorrection(finance) {
    if (!finance || !Array.isArray(finance.feeItems) || !feeClassifier) return 0;
    var summary = feeClassifier.summarize(finance.feeItems);
    var stored = finance.intlLogisticsRub != null ? Number(finance.intlLogisticsRub) : number(finance.intlLogistics);
    return stored == null ? 0 : round(stored - summary.intl);
  }

  function internationalFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.intl;
    var base = finance.intlLogisticsRub != null ? Number(finance.intlLogisticsRub) : number(finance.intlLogistics);
    if (base == null) return null;
    return round(base);
  }

  function logisticsFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.logistics;
    var value = finance.logisticsFeeRub != null ? Number(finance.logisticsFeeRub) : number(finance.logisticsFee);
    return value == null || !isFinite(value) ? (finance.accrualsComplete === true ? 0 : null) : round(value);
  }

  function advertisingFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.advertising;
    var value = finance.advertisingFeeRub != null ? Number(finance.advertisingFeeRub) : number(finance.advertisingFee);
    var cpoItems = performanceCpoItems(finance);
    var cpo = finance.performanceCpoRub != null ? Number(finance.performanceCpoRub)
      : cpoItems.reduce(function (sum, item) { return sum + (Number(item.amount) || 0); }, 0);
    if (!Number.isFinite(cpo)) cpo = 0;
    if (value == null || !isFinite(value)) return finance.accrualsComplete === true ? round(cpo) : (cpoItems.length ? round(cpo) : null);
    return round(value + cpo);
  }

  function lastMile(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.last;
    var actual = finance.lastMileRub != null ? Number(finance.lastMileRub) : number(finance.lastMile);
    if (actual != null && isFinite(actual)) return round(actual);
    if (finance.accrualsComplete === true) return 0;
    return null;
  }

  function estimateAcquiringRub(amount) {
    if (!(amount > 0)) return null;
    var base = Math.min(amount, 1500);
    var excess = Math.max(amount - 1500, 0);
    return round(base * 0.014 + excess * 0.019);
  }

  function acquiring(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary && (categoryHas(finance, 'acq') || finance.accrualsComplete === true)) return summary.acq;
    var actual = finance.acquiringRub != null ? Number(finance.acquiringRub) : number(finance.acquiring);
    if (actual != null && isFinite(actual)) return round(actual);
    var amount = finance.orderAmountRub != null ? Number(finance.orderAmountRub) : number(finance.orderAmount);
    var estimated = estimateAcquiringRub(amount);
    if (estimated != null) {
      finance.acquiringEstimated = true;
      finance.acquiringEstimateSource = 'tiered:1500@1.4%+excess@1.9%';
      return estimated;
    }
    if (finance.acquiringComplete !== true) return null;
    return 0;
  }

  function returnHandlingFee(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.return;
    if (Object.prototype.hasOwnProperty.call(finance, 'returnHandlingFeeRub')) {
      var stored = Number(finance.returnHandlingFeeRub);
      return isFinite(stored) ? Math.round(stored * 100) / 100 : 0;
    }
    if (finance.accrualsComplete === true) return 0;
    return null;
  }

  function otherServiceFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return summary.other;
    var value = finance.otherFeeRub != null ? Number(finance.otherFeeRub) : number(finance.otherFee);
    return value == null || !isFinite(value) ? (finance.accrualsComplete === true ? 0 : null) : round(value);
  }

  // 用户确认：连连收款/提现手续费固定按卖家销售额的 1% 计入利润成本；该费用不属于 Ozon feeItems。
  function withdrawalFee(amount) { return amount > 0 ? round(amount * 0.01) : 0; }

  // 兼容旧调用：其它费用合计包含普通Ozon物流、广告推广、真正其它费用、尾程，以及连连提现手续费1%；
  // 退货/拒收费继续单独展示。
  function otherFees(finance, amountOverride, requireBase) {
    if (!finance) return requireBase ? null : 0;
    var logistics = logisticsFees(finance);
    var advertising = advertisingFees(finance);
    var other = otherServiceFees(finance);
    var tail = lastMile(finance);
    if (requireBase && [logistics, advertising, other, tail].some(function (value) { return value == null; })) return null;
    var amount = amountOverride != null ? Number(amountOverride) : (Number(finance.orderAmountRub) || 0);
    return round((logistics || 0) + (advertising || 0) + (other || 0) + (tail || 0) + withdrawalFee(amount));
  }

  function totalOzonFees(finance) {
    if (!finance) return null;
    var summary = actualFeeSummary(finance);
    if (summary) return round(summary.totalCostRub - (summary.advertisingUnallocatedRub || 0));
    var values = [
      commissionFees(finance), internationalFees(finance), acquiring(finance),
      logisticsFees(finance), advertisingFees(finance), lastMile(finance),
      returnHandlingFee(finance), otherServiceFees(finance)
    ];
    if (values.some(function (value) { return value == null || !isFinite(value); })) return null;
    return round(values.reduce(function (sum, value) { return sum + value; }, 0));
  }

  // 订单统一“总计费”合同：只统计已经真实发生、且能归属到当前订单的平台费用。
  // 预估费用不会进入这里；CPC/CPM等无法可靠归属单笔订单的广告另留在周期费用层，避免重复扣费。
  function actualPlatformFees(finance) {
    var keys = ['comm','intl','acq','logistics','advertising','last','return','other'];
    var empty = { comm: null, intl: null, acq: null, logistics: null, advertising: null, last: null, return: null, other: null,
      total: null, hasKnown: false, complete: false, missing: keys.slice(), advertisingUnallocated: 0, advertisingBreakdown: [], advertisingUnallocatedBreakdown: [], advertisingChargeBreakdown: [], source: 'none' };
    if (!finance) return empty;

    function savedActual(primary, legacy, estimatedFlag, completeFlag) {
      var value = finance[primary] != null ? Number(finance[primary]) : number(finance[legacy]);
      if (estimatedFlag === true && completeFlag !== true) return null;
      if (value != null && isFinite(value)) return round(value);
      return completeFlag === true ? 0 : null;
    }

    var values;
    var summary = actualFeeSummary(finance);
    var accrualsComplete = finance.accrualsComplete === true;
    var acquiringComplete = finance.acquiringComplete === true;
    var source = 'saved_actual_fields';
    var advertisingUnallocated = 0;
    var advertisingBreakdown = [];
    var advertisingUnallocatedBreakdown = [];
    var advertisingChargeBreakdown = [];
    var otherBreakdown = [];
    if (summary) {
      source = 'fee_items';
      function accrualValue(category, field) {
        return categoryHas(finance, category) ? round(summary[field] || 0) : (accrualsComplete ? 0 : null);
      }
      var cpoKnown = performanceCpoItems(finance).length > 0;
      var savedAcq = savedActual('acquiringRub', 'acquiring', finance.acquiringEstimated, acquiringComplete);
      values = {
        comm: accrualValue('comm', 'comm'),
        intl: accrualValue('intl', 'intl'),
        acq: categoryHas(finance, 'acq') ? round(summary.acq || 0) : savedAcq,
        logistics: accrualValue('logistics', 'logistics'),
        advertising: categoryHas(finance, 'advertising') || cpoKnown ? round(summary.advertisingOrderCostRub || 0) : (accrualsComplete ? 0 : null),
        last: accrualValue('last', 'last'),
        return: accrualValue('return', 'return'),
        other: accrualValue('other', 'other')
      };
      advertisingUnallocated = round(summary.advertisingUnallocatedRub || 0);
      advertisingBreakdown = (summary.advertisingBreakdown || []).filter(function (entry) { return entry && entry.orderAttributable !== false; });
      advertisingUnallocatedBreakdown = (summary.advertisingBreakdown || []).filter(function (entry) { return entry && entry.orderAttributable === false; });
      advertisingChargeBreakdown = (summary.advertisingChargeBreakdown || []).slice();
      var otherMap = Object.create(null);
      (summary.normalizedItems || []).forEach(function (item) {
        if (!item || item.normalizedKind !== 'other') return;
        var label = feeClassifier && feeClassifier.displayLabel ? feeClassifier.displayLabel(item, 'other') : '未映射平台费';
        var type = feeClassifier && feeClassifier.feeType ? feeClassifier.feeType(item) : String(item.type || '');
        var key = type + '|' + label;
        if (!otherMap[key]) otherMap[key] = { type: type, label: label, amountRub: 0, count: 0 };
        otherMap[key].amountRub += Number(item.normalizedCostRub) || 0;
        otherMap[key].count += 1;
      });
      otherBreakdown = Object.keys(otherMap).map(function (key) {
        var entry = otherMap[key]; entry.amountRub = round(entry.amountRub); return entry;
      }).sort(function (left, right) { return Math.abs(right.amountRub) - Math.abs(left.amountRub); });
    } else {
      var performanceCpo = performanceCpoItems(finance);
      var advertisingValue = savedActual('advertisingFeeRub', 'advertisingFee', false, accrualsComplete);
      if (performanceCpo.length) {
        var performanceTotal = performanceCpo.reduce(function (sum, item) { return sum + (Number(item && item.amount) || 0); }, 0);
        advertisingValue = round((advertisingValue == null ? 0 : advertisingValue) + performanceTotal);
        if (feeClassifier && feeClassifier.summarize) {
          var performanceSummary = feeClassifier.summarize(performanceCpo);
          advertisingBreakdown = (performanceSummary.advertisingBreakdown || []).filter(function (entry) { return entry && entry.orderAttributable !== false; });
          advertisingUnallocatedBreakdown = (performanceSummary.advertisingBreakdown || []).filter(function (entry) { return entry && entry.orderAttributable === false; });
          advertisingChargeBreakdown = (performanceSummary.advertisingChargeBreakdown || []).slice();
        }
      }
      values = {
        comm: savedActual('ozonFeeRub', 'ozonFee', finance.ozonFeeEstimated, accrualsComplete),
        intl: savedActual('intlLogisticsRub', 'intlLogistics', finance.intlLogisticsEstimated, accrualsComplete),
        acq: savedActual('acquiringRub', 'acquiring', finance.acquiringEstimated, acquiringComplete),
        logistics: savedActual('logisticsFeeRub', 'logisticsFee', false, accrualsComplete),
        advertising: advertisingValue,
        last: savedActual('lastMileRub', 'lastMile', finance.lastMileEstimated, accrualsComplete),
        return: savedActual('returnHandlingFeeRub', 'returnHandlingFee', false, accrualsComplete),
        other: savedActual('otherFeeRub', 'otherFee', false, accrualsComplete)
      };
    }
    var missing = keys.filter(function (key) { return values[key] == null || !isFinite(values[key]); });
    var known = keys.filter(function (key) { return values[key] != null && isFinite(values[key]); });
    var hasKnown = known.length > 0;
    var total = hasKnown ? round(known.reduce(function (sum, key) { return sum + Number(values[key]); }, 0)) : null;
    return Object.assign({}, values, {
      total: total,
      hasKnown: hasKnown,
      complete: missing.length === 0,
      missing: missing,
      advertisingUnallocated: advertisingUnallocated,
      advertisingBreakdown: advertisingBreakdown,
      advertisingUnallocatedBreakdown: advertisingUnallocatedBreakdown,
      advertisingChargeBreakdown: advertisingChargeBreakdown,
      otherBreakdown: otherBreakdown,
      source: source
    });
  }

  // WHD兼容视图复用统一实际总计费合同，只保留旧页面所需字段形状。
  function actualWarehouseFees(finance) {
    var fees = actualPlatformFees(finance);
    var otherParts = [fees.logistics, fees.advertising, fees.last, fees.return, fees.other];
    var other = round(otherParts.reduce(function (sum, value) { return sum + (value != null && isFinite(value) ? Number(value) : 0); }, 0));
    return {
      comm: fees.comm,
      intl: fees.intl,
      acq: fees.acq,
      other: other,
      total: fees.total == null ? 0 : fees.total,
      hasKnown: fees.hasKnown,
      complete: fees.complete
    };
  }

  // “总费用”与利润核对统一使用 totalRub：Ozon平台扣项 + 采购总成本 + 国内额外费用。
  // nonPurchaseFeeRub 仅保留为内部“非采购扣项”辅助明细，不得作为页面总费用。
  // 接口净收入已经扣过Ozon平台费用，因此真实利润可用两种等价算法互相校验。
  function totalDeductionsDetails(finance, domesticDetails) {
    finance = finance || {};
    var platform = actualPlatformFees(finance);
    var gross = actualRevenueRub(finance);
    var netIncome = actualNetIncomeRub(finance);
    var platformByNet = gross != null && isFinite(gross) && netIncome != null && isFinite(netIncome)
      ? round(Number(gross) - Number(netIncome)) : null;
    var itemizedPlatformRub = platform && platform.total != null && isFinite(platform.total) ? round(platform.total) : null;
    var platformRub = platformByNet != null ? platformByNet : itemizedPlatformRub;
    var purchaseRub = domesticDetails && domesticDetails.purchaseRub != null && isFinite(domesticDetails.purchaseRub)
      ? round(domesticDetails.purchaseRub) : null;
    var domesticTotalRub = domesticDetails && domesticDetails.totalRub != null && isFinite(domesticDetails.totalRub)
      ? round(domesticDetails.totalRub) : null;
    var domesticExtraRub = domesticTotalRub != null && purchaseRub != null
      ? round(domesticTotalRub - purchaseRub) : null;
    var nonPurchaseFeeRub = platformRub != null && domesticExtraRub != null
      ? round(platformRub + domesticExtraRub) : null;
    var complete = platformRub != null && domesticTotalRub != null;
    return {
      platformRub: platformRub,
      itemizedPlatformRub: itemizedPlatformRub,
      platformAdjustmentRub: platformRub != null && itemizedPlatformRub != null ? round(platformRub - itemizedPlatformRub) : null,
      purchaseRub: purchaseRub,
      domesticFeeRub: domesticExtraRub,
      nonPurchaseFeeRub: nonPurchaseFeeRub,
      domesticTotalRub: domesticTotalRub,
      totalRub: complete ? round(platformRub + domesticTotalRub) : null,
      complete: complete,
      missing: (platformRub == null ? ['platform'] : []).concat(domesticTotalRub == null ? ['domestic'] : []),
      platformFees: platform,
      domesticCosts: domesticDetails || null,
      grossRub: gross,
      netIncomeRub: netIncome
    };
  }
  function profitReconciliation(finance, domesticDetails) {
    var totals = totalDeductionsDetails(finance, domesticDetails);
    if (!totals || !totals.complete) return null;
    var gross = actualRevenueRub(finance);
    var netIncome = actualNetIncomeRub(finance);
    if (gross == null || !isFinite(gross) || netIncome == null || !isFinite(netIncome) ||
        totals.totalRub == null || !isFinite(totals.totalRub) ||
        totals.domesticTotalRub == null || !isFinite(totals.domesticTotalRub)) return null;
    var byGross = round(Number(gross) - Number(totals.totalRub));
    var byNet = round(Number(netIncome) - Number(totals.domesticTotalRub));
    var difference = round(byGross - byNet);
    return {
      profitByGrossRub: byGross,
      profitByNetRub: byNet,
      differenceRub: difference,
      consistent: Math.abs(difference) <= 0.01,
      grossRub: round(gross),
      netIncomeRub: round(netIncome),
      totalFeesRub: round(totals.totalRub),
      domesticTotalRub: round(totals.domesticTotalRub),
      platformRub: totals.platformRub
    };
  }

  function purchaseCostCny(order, finance, groups) {
    var hasStock = (order.items || []).some(function (item) { return item && item._stk && Number(item._stk.qty) > 0; });
    var hasExplicitCost = hasStock || (order.combine || []).some(function (row) {
      return row && ((row.purchasePrice != null && String(row.purchasePrice).trim() !== '') || (row.domesticShipping != null && String(row.domesticShipping).trim() !== ''));
    }) || (order.items || []).some(function (item) {
      return item && ((item.purchasePrice != null && String(item.purchasePrice).trim() !== '') || (item.domesticShipping != null && String(item.domesticShipping).trim() !== ''));
    });
    if (!hasExplicitCost) {
      var saved = number(finance && finance.purchaseCost);
      return saved != null && saved >= 0 ? round(saved) : null;
    }
    if (!orderOps) return hasExplicitCost ? 0 : null;
    var calculated = orderOps.purchaseCostNum(order.items, { orderTime: order.orderTime, groups: groups, posting: order.posting });
    calculated += orderOps.combineCostNum(order.combine);
    return hasExplicitCost ? round(calculated) : null;
  }

  function linkResaleFees(input) {
    var orders = (Array.isArray(input) ? input : []).map(function (order) {
      if (!order || typeof order !== 'object') return order;
      return Object.assign({}, order, { finance: order.finance && Object.assign({}, order.finance, { feeItems: Array.isArray(order.finance.feeItems) ? order.finance.feeItems.map(function (item) { return item && Object.assign({}, item); }) : order.finance.feeItems }) });
    });
    var byPosting = new Map(orders.filter(Boolean).map(function (order) { return [String(order.posting || ''), order]; }));
    orders.forEach(function (resale) {
      if (!resale || !resale.retFrom || !resale.finance) return;
      var origin = byPosting.get(String(resale.retFrom || ''));
      if (!origin || !origin.finance) return;
      var target = resale.finance;
      var originFinance = origin.finance;
      var originItems = Array.isArray(originFinance.feeItems) ? originFinance.feeItems : [];
      var alreadyMerged = Array.isArray(target.feeItems) && target.feeItems.some(function (item) { return item && item.feeRole === 'origin_refusal'; });
      var originSummary = actualFeeSummary(originFinance);
      var refusalKnown = originFinance.returnFeeRub != null && Number(originFinance.returnFeeRub) > 0
        ? Number(originFinance.returnFeeRub)
        : originSummary && originSummary.totalCostRub > 0 ? originSummary.totalCostRub : null;
      if (!alreadyMerged && originItems.length) {
        target.feeItems = (Array.isArray(target.feeItems) ? target.feeItems : []).concat(originItems.map(function (item) {
          return Object.assign({}, item, { feeRole: 'origin_refusal', originPosting: String(origin.posting || '') });
        }));
        target.returnFeeMerged = true;
      } else if (alreadyMerged) target.returnFeeMerged = true;
      if (refusalKnown != null) {
        target.returnFeeRub = round(refusalKnown);
        target.returnFeeSource = target.returnFeeMerged ? 'origin_refusal_fee_items_runtime_merge' : 'origin_return_fee';
        target.returnFeePending = false;
      } else if (!target.returnFeeMerged && !(Number(target.returnFeeRub) > 0)) {
        target.returnFeeRub = null;
        target.returnFeePending = true;
        target.returnFeeSource = 'origin_refusal_fee_pending_sync';
      }
      if (target.resaleFeeRub == null) {
        var ownItems = (Array.isArray(target.feeItems) ? target.feeItems : []).filter(function (item) { return item && item.feeRole !== 'origin_refusal'; });
        var ownSummary = feeClassifier && feeClassifier.summarize ? feeClassifier.summarize(ownItems) : null;
        if (ownSummary) target.resaleFeeRub = ownSummary.totalCostRub;
      }
    });
    return orders;
  }

  function profit(finance, mode, rate, manualFee) {
    if (!finance || (mode !== 'real' && mode !== 'calc')) return null;
    var purchaseCny = number(finance.purchaseCost);
    var lockedRate = orderCnyPerRub(finance);
    var appliedRate = lockedRate != null ? lockedRate : number(rate);
    if (purchaseCny == null || purchaseCny <= 0 || !(appliedRate > 0)) return null;
    if (mode === 'real' && lockedRate == null) return null;
    var purchaseRub = purchaseCny / appliedRate;
    var amount;
    var cost;
    if (mode === 'calc' && finance.resaleIncomeRub != null) {
      amount = Number(finance.resaleIncomeRub);
      if (!(amount > 0)) return null;
      if (finance.returnFeePending === true || (finance.retResalePosting && finance.returnFeeRub == null)) return null;
      cost = purchaseRub + (Number(finance.resaleFeeRub) || 0) + withdrawalFee(amount) + (Number(finance.returnFeeRub) || 0) + manualFee / appliedRate;
    } else {
      amount = actualRevenueRub(finance);
      if (!(amount > 0)) return null;
      if (mode === 'real') {
        if (finance.accrualsComplete === false || finance.returnFeePending === true) return null;
        var domestic = domesticCostDetails(finance, appliedRate, manualFee, true);
        if (!domestic) return null;
        var isResale = finance.returnFeeMerged === true || (Array.isArray(finance.feeItems) && finance.feeItems.some(function (item) { return item && item.feeRole === 'origin_refusal'; }));
        if (isResale) {
          var resalePlatformFees = actualPlatformFees(finance);
          if (!resalePlatformFees || !resalePlatformFees.complete || resalePlatformFees.total == null || !isFinite(resalePlatformFees.total)) return null;
          var resaleProfitRub = round(amount - Number(resalePlatformFees.total) - domestic.totalRub);
          return {
            rub: resaleProfitRub,
            margin: resaleProfitRub / amount * 100,
            platformCostRub: Number(resalePlatformFees.total),
            domesticCostRub: domestic.totalRub,
            domesticCosts: domestic,
            resale: true
          };
        }
        var netIncome = actualNetIncomeRub(finance);
        if (netIncome == null || !isFinite(netIncome)) return null;
        var realProfitRub = round(netIncome - domestic.totalRub);
        return { rub: realProfitRub, margin: realProfitRub / amount * 100, netIncomeRub: netIncome, domesticCostRub: domestic.totalRub, domesticCosts: domestic };
      } else {
        var commission = commissionFees(finance);
        var international = internationalFees(finance);
        var acquiringFee = acquiring(finance);
        var other = otherFees(finance, amount);
        var returnHandling = returnHandlingFee(finance) || 0;
        if ([commission, international, acquiringFee, other].some(function (value) { return value == null || !isFinite(value); })) return null;
        cost = purchaseRub + commission + international + acquiringFee + other + returnHandling + manualFee / appliedRate + (Number(finance.returnFeeRub) || 0);
      }
    }
    var profitRub = round(amount - cost);
    return { rub: profitRub, margin: profitRub / amount * 100 };
  }

  function estimatedProfitDetails(finance, rate, manualFee) {
    if (!finance) return null;
    var amount = estimateRevenueRub(finance, rate);
    var commission = commissionFees(finance);
    var international = internationalFees(finance);
    var purchaseCny = number(finance.purchaseCost);
    var acquiringFee = acquiring(finance);
    if (!(amount > 0) || commission == null || !isFinite(commission) || commission < 0 || international == null || !isFinite(international) || international < 0 || acquiringFee == null || purchaseCny == null || purchaseCny <= 0 || !(rate > 0)) return null;
    var returnHandlingEst = returnHandlingFee(finance) || 0;
    var planningCost = (Number(finance.damageLossEstimatedRub) || 0) + (Number(finance.advertisingBudgetEstimatedRub) || 0);
    var cost = purchaseCny / rate + commission + international + acquiringFee + otherFees(finance, amount) + returnHandlingEst + planningCost + manualFee / rate + (Number(finance.returnFeeRub) || 0);
    return { rub: amount - cost, margin: (amount - cost) / amount * 100 };
  }

  function estimatedProfit(finance, rate, manualFee) {
    var result = estimatedProfitDetails(finance, rate, manualFee);
    return result ? result.rub : null;
  }

  function calculate(input, options) {
    var settings = options || {};
    var rate = Number(settings.rate) || (1 / 12);
    var manualFee = Number(settings.manualFee) || 0;
    var orders = (input || []).map(function (value) { return value && value.it ? value.it : value; }).filter(Boolean);
    orders = linkResaleFees(orders);
    if (!settings.prepared) {
      orders = orders.map(function (order) { return Object.assign({}, order, { items: (order.items || []).map(function (item) { return item && Object.assign({}, item); }) }); });
      if (orderOps) orderOps.applyStock(orders);
    }
    var groups = orderOps ? orderOps.buildShipGroups(orders) : {};
    var result = {
      totalCount: 0, signedCount: 0, cancelledCount: 0, unsignedCount: 0,
      salesRub: 0, salesCny: 0, signedSalesRub: 0, signedSalesCny: 0,
      unsignedSalesRub: 0, unsignedSalesCny: 0, costCny: 0, signedCostCny: 0,
      unsignedCostCny: 0, cancelledCostCny: 0, manualFeeCny: 0,
      signedManualFeeCny: 0, unsignedManualFeeCny: 0, signedProfitCny: 0,
      unsignedEstimatedProfitCny: 0, marginRatio: null, roiRatio: null,
      advertisingFeeRub: 0, advertisingFeeCny: 0, signedAdvertisingFeeRub: 0, signedAdvertisingFeeCny: 0,
      unsignedAdvertisingFeeRub: 0, unsignedAdvertisingFeeCny: 0, cancelledAdvertisingFeeRub: 0, cancelledAdvertisingFeeCny: 0,
      warehouseCount: 0, warehouseCostCny: 0, warehouseManualFeeCny: 0,
      warehouseFeeRub: 0, warehouseFeeCny: 0, warehouseFeeMissingCount: 0,
      platformFeeRub: 0, platformFeeCny: 0, platformFeeKnownCount: 0, platformFeeMissingCount: 0,
      unsignedPlatformFeeRub: 0, unsignedPlatformFeeCny: 0, signedPlatformFeeRub: 0, signedPlatformFeeCny: 0,
      cancelledPlatformFeeRub: 0, cancelledPlatformFeeCny: 0, warehousePlatformFeeRub: 0, warehousePlatformFeeCny: 0,
      unsignedPlatformFeeMissingCount: 0, signedPlatformFeeMissingCount: 0, cancelledPlatformFeeMissingCount: 0, warehousePlatformFeeMissingCount: 0,
      warehouseAdvertisingFeeRub: 0, warehouseAdvertisingFeeCny: 0,
      advertisingBreakdown: [], advertisingChargeBreakdown: [],
      completeness: {
        sales: { count: 0, rubMissing: 0, cnyMissing: 0 },
        signedSales: { count: 0, rubMissing: 0, cnyMissing: 0 },
        unsignedSales: { count: 0, rubMissing: 0, cnyMissing: 0 },
        signedProfit: { calculated: 0, missing: 0 }, unsignedProfit: { calculated: 0, missing: 0 },
        cancelledSales: { count: 0, rubMissing: 0, cnyMissing: 0 }, cancelledProfit: { calculated: 0, missing: 0 }
      }
    };
    var adBreakdown = new Map(), adChargeBreakdown = new Map();
    var signedProfitRevenueCny = 0, signedProfitCostCny = 0, signedProfitRevenueMissing = 0;
    orders.forEach(function (order) {
      var finance = order.finance || {};
      var mode = financeMode(order);
      var zero = mode === 'zero' || mode === 'returned';
      var destroyed = mode === 'destroyed';
      var resaleOrigin = order.status === '已取消' && finance.resaleIncomeRub != null;
      var warehouse = mode === 'inwarehouse';
      var signed = !warehouse && order.status === '已签收';
      var cancelled = warehouse || order.status === '已取消';
      var coverageBucket = signed ? 'signed' : cancelled ? 'cancelled' : 'unsigned';
      var amountRub = 0;
      var amountCny = 0;
      result.totalCount++;
      if (warehouse) result.warehouseCount++;
      else if (signed) result.signedCount++;
      if (cancelled) result.cancelledCount++;

      var statisticalFeeItems = Array.isArray(finance.feeItems) ? finance.feeItems.filter(function (item) { return item && item.feeRole !== 'origin_refusal'; }) : null;
      var summary = statisticalFeeItems && statisticalFeeItems.length ? summarizeFeeItemsWithPerformance(finance, statisticalFeeItems) : null;
      var cpoBreakdown = !summary && performanceCpoItems(finance).length && feeClassifier && feeClassifier.summarize
        ? feeClassifier.summarize(performanceCpoItems(finance)) : null;
      var advertisingSummary = summary || cpoBreakdown;
      var adRub = summary ? summary.advertising : (advertisingFees(finance) || 0);
      result.advertisingFeeRub += adRub;
      result.advertisingFeeCny += adRub * rate;
      if (warehouse) { result.warehouseAdvertisingFeeRub += adRub; result.warehouseAdvertisingFeeCny += adRub * rate; }
      else if (signed) { result.signedAdvertisingFeeRub += adRub; result.signedAdvertisingFeeCny += adRub * rate; }
      else if (cancelled) { result.cancelledAdvertisingFeeRub += adRub; result.cancelledAdvertisingFeeCny += adRub * rate; }
      else { result.unsignedAdvertisingFeeRub += adRub; result.unsignedAdvertisingFeeCny += adRub * rate; }

      var platformFees = actualPlatformFees(finance);
      if (platformFees.hasKnown) {
        result.platformFeeRub += platformFees.total;
        result.platformFeeCny += platformFees.total * rate;
        result.platformFeeKnownCount++;
        if (warehouse) { result.warehousePlatformFeeRub += platformFees.total; result.warehousePlatformFeeCny += platformFees.total * rate; }
        else if (signed) { result.signedPlatformFeeRub += platformFees.total; result.signedPlatformFeeCny += platformFees.total * rate; }
        else if (cancelled) { result.cancelledPlatformFeeRub += platformFees.total; result.cancelledPlatformFeeCny += platformFees.total * rate; }
        else { result.unsignedPlatformFeeRub += platformFees.total; result.unsignedPlatformFeeCny += platformFees.total * rate; }
      }
      if (!platformFees.complete) {
        result.platformFeeMissingCount++;
        if (warehouse) result.warehousePlatformFeeMissingCount++;
        else if (signed) result.signedPlatformFeeMissingCount++;
        else if (cancelled) result.cancelledPlatformFeeMissingCount++;
        else result.unsignedPlatformFeeMissingCount++;
      }
      if (warehouse) {
        var warehouseFees = actualWarehouseFees(finance);
        if (warehouseFees.hasKnown) {
          result.warehouseFeeRub += warehouseFees.total;
          result.warehouseFeeCny += warehouseFees.total * rate;
        }
        if (!warehouseFees.complete) result.warehouseFeeMissingCount++;
      }
      if (advertisingSummary) {
        advertisingSummary.advertisingBreakdown.forEach(function (entry) {
          var key = entry.chargeModel + '|' + entry.type + '|' + entry.label;
          var target = adBreakdown.get(key);
          if (!target) { target = { type: entry.type, label: entry.label, chargeModel: entry.chargeModel, chargeLabel: entry.chargeLabel, orderAttributable: entry.orderAttributable, amountRub: 0, count: 0 }; adBreakdown.set(key, target); }
          target.amountRub += entry.amountRub;
          target.count += entry.count;
        });
        advertisingSummary.advertisingChargeBreakdown.forEach(function (entry) {
          var target = adChargeBreakdown.get(entry.chargeModel);
          if (!target) { target = { chargeModel: entry.chargeModel, label: entry.label, orderAttributable: entry.orderAttributable, amountRub: 0, count: 0 }; adChargeBreakdown.set(entry.chargeModel, target); }
          target.amountRub += entry.amountRub; target.count += entry.count;
        });
      }

      if (!zero && !destroyed && !resaleOrigin && mode !== 'calc' && mode !== 'inwarehouse') {
        var amount = signed ? actualRevenueRub(finance) : estimateRevenueRub(finance, rate);
        var cny = orderAmountCny(order, finance);
        var rubKnown = amount != null && isFinite(amount) && amount >= 0;
        var cnyKnown = cny != null;
        if (rubKnown) amountRub = amount;
        if (cnyKnown) amountCny = cny;
        [result.completeness.sales, result.completeness[coverageBucket + 'Sales']].forEach(function (coverage) {
          coverage.count++;
          if (!rubKnown) coverage.rubMissing++;
          if (!cnyKnown) coverage.cnyMissing++;
        });
        if (signed) { result.signedSalesRub += amountRub; result.signedSalesCny += amountCny; }
      }
      if (!zero && !resaleOrigin) {
        var purchase = settings.prepared ? number(finance.purchaseCost) : purchaseCostCny(order, finance, groups);
        var purchaseKnown = purchase != null;
        var cost = (purchaseKnown ? purchase : 0) + manualFee;
        result.costCny += cost;
        result.manualFeeCny += manualFee;
        if (cancelled && !warehouse) result.cancelledCostCny += cost;
        if (warehouse) { result.warehouseCostCny += cost; result.warehouseManualFeeCny += manualFee; }
        else if (signed) { result.signedCostCny += cost; result.signedManualFeeCny += manualFee; }
        else result.unsignedManualFeeCny += manualFee;
        if (!destroyed && !warehouse) {
          var view = purchaseKnown ? Object.assign({}, finance, { purchaseCost: purchase }) : finance;
          var actualProfit = profit(view, mode, rate, manualFee);
          var profitCoverage = result.completeness[coverageBucket + 'Profit'];
          if (actualProfit) {
            profitCoverage.calculated++;
            if (signed) {
              result.signedProfitCny += actualProfit.rub * rate;
              signedProfitRevenueCny += amountCny;
              signedProfitCostCny += cost;
              if (orderAmountCny(order, finance) == null) signedProfitRevenueMissing++;
            } else result.unsignedEstimatedProfitCny += actualProfit.rub * rate;
          } else if (mode === 'est') {
            var estimate = estimatedProfit(view, rate, manualFee);
            if (estimate != null) { result.unsignedEstimatedProfitCny += estimate * rate; profitCoverage.calculated++; }
            else profitCoverage.missing++;
          } else if (mode === 'real' || mode === 'calc') profitCoverage.missing++;
        }
      }
      if (mode === 'returned' && order.cancel && String(order.cancel.who).indexOf('卖家取消') < 0) {
        result.manualFeeCny += manualFee;
        result.unsignedManualFeeCny += manualFee;
      }
      result.salesRub += amountRub;
      result.salesCny += amountCny;
    });
    result.unsignedCount = Math.max(0, result.totalCount - result.signedCount - result.cancelledCount);
    result.unsignedSalesRub = Math.max(0, result.salesRub - result.signedSalesRub);
    result.unsignedSalesCny = Math.max(0, result.salesCny - result.signedSalesCny);
    result.unsignedCostCny = result.costCny - result.signedCostCny - result.warehouseCostCny;
    result.roiRatio = signedProfitCostCny > 0 ? result.signedProfitCny / signedProfitCostCny : null;
    result.marginRatio = signedProfitRevenueCny > 0 && !signedProfitRevenueMissing ? result.signedProfitCny / signedProfitRevenueCny : null;
    if (!result.completeness.signedProfit.calculated) result.signedProfitCny = null;
    if (!result.completeness.unsignedProfit.calculated) result.unsignedEstimatedProfitCny = null;
    ['sales', 'signedSales', 'unsignedSales'].forEach(function (key) {
      var coverage = result.completeness[key];
      if (coverage.count && coverage.rubMissing === coverage.count) result[key + 'Rub'] = null;
      if (coverage.count && coverage.cnyMissing === coverage.count) result[key + 'Cny'] = null;
    });
    ['advertisingFeeRub','advertisingFeeCny','signedAdvertisingFeeRub','signedAdvertisingFeeCny','unsignedAdvertisingFeeRub','unsignedAdvertisingFeeCny','cancelledAdvertisingFeeRub','cancelledAdvertisingFeeCny','warehouseAdvertisingFeeRub','warehouseAdvertisingFeeCny','warehouseFeeRub','warehouseFeeCny','warehouseCostCny','warehouseManualFeeCny','platformFeeRub','platformFeeCny','unsignedPlatformFeeRub','unsignedPlatformFeeCny','signedPlatformFeeRub','signedPlatformFeeCny','cancelledPlatformFeeRub','cancelledPlatformFeeCny','warehousePlatformFeeRub','warehousePlatformFeeCny'].forEach(function (key) { result[key] = round(result[key]); });
    var platformFeeCnyParts = reconcileRoundedParts(result.platformFeeCny, [result.unsignedPlatformFeeCny, result.signedPlatformFeeCny, result.cancelledPlatformFeeCny, result.warehousePlatformFeeCny]);
    result.unsignedPlatformFeeCny = platformFeeCnyParts[0];
    result.signedPlatformFeeCny = platformFeeCnyParts[1];
    result.cancelledPlatformFeeCny = platformFeeCnyParts[2];
    result.warehousePlatformFeeCny = platformFeeCnyParts[3];
    result.advertisingBreakdown = Array.from(adBreakdown.values()).map(function (entry) {
      return { type: entry.type, label: entry.label, chargeModel: entry.chargeModel, chargeLabel: entry.chargeLabel, orderAttributable: entry.orderAttributable, amountRub: round(entry.amountRub), amountCny: round(entry.amountRub * rate), count: entry.count };
    }).sort(function (a, b) { return Math.abs(b.amountRub) - Math.abs(a.amountRub); });
    result.advertisingChargeBreakdown = Array.from(adChargeBreakdown.values()).map(function (entry) {
      return { chargeModel: entry.chargeModel, label: entry.label, orderAttributable: entry.orderAttributable, amountRub: round(entry.amountRub), amountCny: round(entry.amountRub * rate), count: entry.count };
    }).sort(function (a, b) { return Math.abs(b.amountRub) - Math.abs(a.amountRub); });
    result.unallocatedAdvertisingFeeRub = 0;
    result.unallocatedAdvertisingFeeCny = 0;
    var periodBase = result.signedProfitCny;
    if (periodBase == null && result.signedCount === 0) periodBase = 0;
    result.periodNetProfitCny = periodBase == null ? null : round(periodBase - result.warehouseFeeCny);
    return result;
  }

  function applyUnallocatedAdvertisingProfit(stats, amountRub, rate) {
    return applyPeriodAdvertisingCosts(stats, amountRub, 0, rate);
  }

  function applyPeriodAdvertisingCosts(stats, unallocatedRub, pendingCpoRub, rate) {
    if (!stats) return stats;
    var cpcRub = round(Number(unallocatedRub) || 0);
    var pendingRub = round(Number(pendingCpoRub) || 0);
    var rateValue = Number(rate) || 0;
    stats.unallocatedAdvertisingFeeRub = cpcRub;
    stats.unallocatedAdvertisingFeeCny = round(cpcRub * rateValue);
    stats.pendingCpoAdvertisingFeeRub = pendingRub;
    stats.pendingCpoAdvertisingFeeCny = round(pendingRub * rateValue);
    var periodBase = stats.signedProfitCny;
    if (periodBase == null && Number(stats.signedCount || 0) === 0) periodBase = 0;
    stats.periodNetProfitCny = periodBase == null ? null : round(Number(periodBase) - Number(stats.warehouseFeeCny || 0) - (cpcRub + pendingRub) * rateValue);
    return stats;
  }

  function completenessText(stats, key) {
    var coverage = stats && stats.completeness && stats.completeness[key];
    if (!coverage) return '';
    if (Object.prototype.hasOwnProperty.call(coverage, 'calculated')) {
      return '可计算 ' + coverage.calculated + ' 单，待计算 ' + coverage.missing + ' 单' + (coverage.missing ? '；合计不完整' : '');
    }
    return coverage.rubMissing || coverage.cnyMissing
      ? 'RUB缺失 ' + coverage.rubMissing + ' 单，CNY缺失 ' + coverage.cnyMissing + ' 单；合计不完整' : '';
  }

  return {
    calculate: calculate, financeMode: financeMode, number: number, profit: profit, estimatedProfit: estimatedProfit,
    estimatedProfitDetails: estimatedProfitDetails, estimateRevenueRub: estimateRevenueRub, orderAmountCny: orderAmountCny,
    purchaseCostCny: purchaseCostCny, completenessText: completenessText, feeType: feeType, feeKind: feeKind,
    isAcquiringFee: isAcquiringFee, legacyInternationalCorrection: legacyInternationalCorrection,
    commissionFees: commissionFees, internationalFees: internationalFees, logisticsFees: logisticsFees,
    advertisingFees: advertisingFees, lastMile: lastMile, acquiring: acquiring, estimateAcquiringRub: estimateAcquiringRub,
    returnHandlingFee: returnHandlingFee, otherServiceFees: otherServiceFees, otherFees: otherFees,
    totalOzonFees: totalOzonFees, actualPlatformFees: actualPlatformFees, actualWarehouseFees: actualWarehouseFees, totalDeductionsDetails: totalDeductionsDetails, profitReconciliation: profitReconciliation, actualFeeSummary: actualFeeSummary, feeSummaryByRole: feeSummaryByRole, actualRevenueRub: actualRevenueRub, actualNetIncomeRub: actualNetIncomeRub, orderCnyPerRub: orderCnyPerRub, orderRubPerCny: orderRubPerCny, domesticCostDetails: domesticCostDetails,
    applyUnallocatedAdvertisingProfit: applyUnallocatedAdvertisingProfit, applyPeriodAdvertisingCosts: applyPeriodAdvertisingCosts, reconcileRoundedParts: reconcileRoundedParts, linkResaleFees: linkResaleFees
  };
});
