'use strict';

const orderStatistics = require('../assets/order-statistics');
const FEE_KEYS = ['comm', 'intl', 'acq', 'logistics', 'advertising', 'last', 'return', 'other'];

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function positiveQty(value) {
  const qty = Number(value);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function itemSku(item) {
  return String(item && (item.sku ?? item.offerId ?? item.offer_id ?? item.article ?? '') || '').trim();
}

function orderShopId(order) {
  return String(order && (order.shopId ?? order.clientId ?? order.externalShopId ?? order.shop_external_id ?? '') || '').trim();
}

function orderTime(order) {
  const raw = String(order && (order.orderTime || order.createdAt || order.created_at || '') || '').trim();
  if (!raw) return null;
  const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeWindow(input, now) {
  const base = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(base.getTime())) throw Object.assign(new Error('统计时间无效'), { code: 'invalid_window' });
  const value = input || {};
  const preset = Number(value.days || value.preset || 30);
  if ([7, 30, 90].includes(preset) && !value.from && !value.to) {
    const to = new Date(base);
    const from = new Date(base);
    from.setUTCDate(from.getUTCDate() - preset);
    return { from, to, days: preset, preset: String(preset) };
  }
  const fromText = String(value.from || '');
  const toText = String(value.to || '');
  const from = new Date(fromText + (fromText.length === 10 ? 'T00:00:00Z' : ''));
  const to = new Date(toText + (toText.length === 10 ? 'T23:59:59.999Z' : ''));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw Object.assign(new Error('自定义统计时间范围无效'), { code: 'invalid_window' });
  const span = Math.floor((to - from) / 86400000) + 1;
  if (span < 1 || span > 366) throw Object.assign(new Error('自定义统计范围最多366天'), { code: 'invalid_window' });
  return { from, to, days: span, preset: 'custom' };
}

function productKey(shopId, sku) {
  return String(shopId || '') + '\u0000' + String(sku || '');
}

function emptyFeeMap() {
  return FEE_KEYS.reduce((result, key) => {
    result[key] = 0;
    return result;
  }, {});
}

function costNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? round(number) : null;
}

function normalizeProducts(products, purchaseTotalCostResolver, allowedShopIds, purchaseCostBreakdownResolver) {
  const result = new Map();
  const allowed = allowedShopIds == null ? null : new Set([...allowedShopIds].map(String));
  for (const product of products || []) {
    const shopId = orderShopId(product);
    if (allowed && !allowed.has(shopId)) continue;
    const candidates = [];
    const directSku = itemSku(product);
    if (directSku) candidates.push({ sku: directSku, product, variant: null });
    for (const variant of Array.isArray(product && product.variants) ? product.variants : []) {
      const sku = itemSku(variant);
      if (sku) candidates.push({ sku, product, variant });
    }
    for (const candidate of candidates) {
      const key = productKey(shopId, candidate.sku);
      if (result.has(key)) continue;
      const breakdown = purchaseCostBreakdownResolver ? purchaseCostBreakdownResolver(candidate) : null;
      const cost = breakdown && Object.prototype.hasOwnProperty.call(breakdown, 'purchaseTotalCostCny')
        ? breakdown.purchaseTotalCostCny
        : (purchaseTotalCostResolver ? purchaseTotalCostResolver(candidate) : null);
      const numericCost = costNumber(cost);
      result.set(key, {
        shopId,
        sku: candidate.sku,
        purchaseCny: costNumber(breakdown && breakdown.purchaseCny),
        domesticShippingCny: costNumber(breakdown && breakdown.domesticShippingCny),
        purchaseTotalCostCny: numericCost,
        purchaseMissingComponents: Array.isArray(breakdown && breakdown.missingComponents) ? breakdown.missingComponents.slice() : [],
        matchedOrderCount: 0,
        soldQuantity: 0,
        historicalMatchedOrderCount: 0,
        historicalSoldQuantity: 0,
        historicalUnknownQuantityOrderCount: 0,
        knownPlatformFeeRub: 0,
        knownPlatformFeeBreakdownRub: emptyFeeMap(),
        missingPlatformFeeBreakdownOrderCount: emptyFeeMap(),
        incompleteOrderCount: 0,
        unknownAllocationOrderCount: 0
      });
    }
  }
  return result;
}

function aggregate(input) {
  const options = input || {};
  const window = normalizeWindow(options.window, options.now);
  const rate = Number(options.cnyPerRub);
  if (!Number.isFinite(rate) || rate <= 0) throw Object.assign(new Error('统计汇率无效'), { code: 'invalid_rate' });
  const allowed = options.allowedShopIds == null ? null : new Set((options.allowedShopIds || []).map(String));
  const rows = normalizeProducts(options.products, options.purchaseTotalCostResolver, allowed, options.purchaseCostBreakdownResolver);

  for (const order of options.orders || []) {
    const shopId = orderShopId(order);
    if (allowed && !allowed.has(shopId)) continue;
    const items = Array.isArray(order && order.items) ? order.items : [];
    const allocationRows = items.map(item => ({
      sku: itemSku(item),
      qty: positiveQty(item && (item.qty ?? item.quantity))
    }));
    const historySeenKeys = new Set();
    allocationRows.forEach(function (entry) {
      if (!entry.sku) return;
      const key = productKey(shopId, entry.sku);
      const target = rows.get(key);
      if (!target) return;
      if (!historySeenKeys.has(key)) {
        target.historicalMatchedOrderCount++;
        historySeenKeys.add(key);
      }
      if (entry.qty > 0) target.historicalSoldQuantity += entry.qty;
      else target.historicalUnknownQuantityOrderCount++;
    });

    const at = orderTime(order);
    if (!at || at < window.from || at > window.to) continue;
    const allocationComplete = allocationRows.length > 0 && allocationRows.every(row => row.sku && row.qty > 0);
    const totalQty = allocationComplete ? allocationRows.reduce((sum, row) => sum + row.qty, 0) : 0;
    const fees = orderStatistics.actualPlatformFees(order && order.finance || {});
    const seenKeys = new Set();
    allocationRows.forEach(function (entry) {
      if (!entry.sku) return;
      const key = productKey(shopId, entry.sku);
      const target = rows.get(key);
      if (!target) return;
      if (!seenKeys.has(key)) {
        target.matchedOrderCount++;
        seenKeys.add(key);
      }
      if (entry.qty > 0) target.soldQuantity += entry.qty;
      if (!allocationComplete) {
        target.unknownAllocationOrderCount++;
        return;
      }
      if (!fees.complete) target.incompleteOrderCount++;
      const share = entry.qty / totalQty;
      if (fees.hasKnown) target.knownPlatformFeeRub += Number(fees.total || 0) * share;
      FEE_KEYS.forEach(function (feeKey) {
        const value = fees[feeKey];
        if (value == null || !Number.isFinite(Number(value))) target.missingPlatformFeeBreakdownOrderCount[feeKey]++;
        else target.knownPlatformFeeBreakdownRub[feeKey] += Number(value) * share;
      });
    });
  }

  const items = [...rows.values()].map(row => {
    const soldQuantity = round(row.soldQuantity);
    const knownPlatformFeeRub = round(row.knownPlatformFeeRub);
    let coverage = 'complete';
    if (!row.matchedOrderCount) coverage = 'no_orders';
    else if (row.unknownAllocationOrderCount) coverage = 'allocation_unknown';
    else if (row.incompleteOrderCount) coverage = knownPlatformFeeRub > 0 ? 'partial' : 'unknown';
    const averagePlatformFeeRub = coverage === 'complete' && soldQuantity > 0 ? round(knownPlatformFeeRub / soldQuantity) : null;
    const averagePlatformFeeCny = averagePlatformFeeRub == null ? null : round(averagePlatformFeeRub * rate);
    const averageTotalCostCny = averagePlatformFeeCny == null || row.purchaseTotalCostCny == null ? null : round(row.purchaseTotalCostCny + averagePlatformFeeCny);
    const averagePlatformFeeBreakdownRub = {};
    const averagePlatformFeeBreakdownCny = {};
    FEE_KEYS.forEach(function (feeKey) {
      const canAverage = row.matchedOrderCount > 0 && soldQuantity > 0 && !row.unknownAllocationOrderCount && row.missingPlatformFeeBreakdownOrderCount[feeKey] === 0;
      const value = canAverage ? round(row.knownPlatformFeeBreakdownRub[feeKey] / soldQuantity) : null;
      averagePlatformFeeBreakdownRub[feeKey] = value;
      averagePlatformFeeBreakdownCny[feeKey] = value == null ? null : round(value * rate);
    });
    const missingPlatformFeeKeys = FEE_KEYS.filter(feeKey => averagePlatformFeeBreakdownRub[feeKey] == null);
    return {
      shopId: row.shopId,
      sku: row.sku,
      matchedOrderCount: row.matchedOrderCount,
      soldQuantity,
      historicalMatchedOrderCount: row.historicalMatchedOrderCount,
      historicalSoldQuantity: round(row.historicalSoldQuantity),
      historicalSoldQuantityComplete: row.historicalUnknownQuantityOrderCount === 0,
      historicalUnknownQuantityOrderCount: row.historicalUnknownQuantityOrderCount,
      purchaseCny: row.purchaseCny,
      domesticShippingCny: row.domesticShippingCny,
      purchaseTotalCostCny: row.purchaseTotalCostCny,
      purchaseMissingComponents: row.purchaseMissingComponents,
      knownPlatformFeeRub,
      averagePlatformFeeRub,
      averagePlatformFeeCny,
      averagePlatformFeeBreakdownRub,
      averagePlatformFeeBreakdownCny,
      missingPlatformFeeKeys,
      averageTotalCostCny,
      coverage,
      incompleteOrderCount: row.incompleteOrderCount,
      unknownAllocationOrderCount: row.unknownAllocationOrderCount
    };
  });

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString(), days: window.days, preset: window.preset },
    cnyPerRub: rate,
    items
  };
}

module.exports = { aggregate, normalizeWindow, itemSku, orderShopId, productKey };
