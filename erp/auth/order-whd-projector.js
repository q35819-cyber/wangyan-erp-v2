'use strict';

const { rub } = require('../assets/order-sync-map');
const feeClassifier = require('../assets/order-fee-classification');
const orderMappings = require('../assets/order-mappings');

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function normalizedFee(fee) {
  if (fee && Array.isArray(fee.items) && fee.items.length && feeClassifier && feeClassifier.summarize) return feeClassifier.summarize(fee.items);
  return fee || {};
}
function feeTotal(fee) {
  const value = normalizedFee(fee);
  const total = ['comm','acq','intl','logistics','last','return','advertising','other'].reduce((sum, key) => sum + (Number(value[key]) || 0), 0);
  return round(total - (Number(value.advertisingUnallocatedRub) || 0));
}
function orderTime(order) { const time = new Date(order && order.orderTime || '').getTime(); return isNaN(time) ? null : time; }
function sameScope(order, shop) { return Boolean(order && shop && shop.clientId && String(order.clientId || '') === String(shop.clientId) && (!shop.tenantId || String(order.tenantId || '') === String(shop.tenantId))); }

function matchingOrigin(orders, skus, saleDate, shop = null) {
  const sameSku = order => order && (!shop || sameScope(order, shop)) && !order.retFrom && String(order.deliverySchema || order.delivery_schema || '').toUpperCase() !== 'WHD' && (order.items || []).some(item => skus.includes(String(item && item.sku || '')));
  const marker = order => String(order && order.ret || '').trim();
  const returnStatus = order => String(order && order.returnInfo && order.returnInfo.status || '').trim();
  const returnStatusName = order => String(order && order.returnInfo && order.returnInfo.statusName || '').trim();
  const returnAddress = order => String(order && order.returnInfo && order.returnInfo.currentAddress || '').trim();
  const destroyed = order => ['销毁中', '正在由Ozon进行销毁', '已销毁'].includes(marker(order)) || /utiliz/i.test(returnStatus(order)) || /утилиз/i.test(returnStatusName(order));
  const warehouse = (orders || []).filter(order => sameSku(order) && !destroyed(order) && order.returnInfo && (
    /^(ReturnedToOzon|ArrivedAtReturnPlace|ArrivedAtWarehouse)$/i.test(returnStatus(order)) || /на складе|在仓库中/i.test(returnStatusName(order)) || /\bWHD\b/i.test(returnAddress(order))
  ));
  const returned = (orders || []).filter(order => sameSku(order) && !destroyed(order) && order.returnInfo && (order.returned || /return|warehouse|склад|仓库/i.test(returnStatus(order) + ' ' + returnStatusName(order) + ' ' + returnAddress(order))));
  const refused = (orders || []).filter(order => sameSku(order) && !destroyed(order) && order.status === '已取消' && order.cancel && order.cancel.refused);
  const delivered = (orders || []).filter(order => sameSku(order) && !destroyed(order) && order.status === '已签收');
  const candidates = warehouse.length ? warehouse : (returned.length ? returned : (refused.length ? refused : delivered));
  if (!candidates.length) return { origin: null, ambiguous: false };
  const saleTime = new Date(saleDate || '').getTime();
  const dated = candidates.map(order => ({ order, time: orderTime(order) })).filter(item => item.time != null && (isNaN(saleTime) || item.time <= saleTime)).sort((a, b) => b.time - a.time);
  if (dated.length && (dated.length === 1 || dated[0].time !== dated[1].time)) return { origin: dated[0].order, ambiguous: false };
  if (candidates.length === 1) return { origin: candidates[0], ambiguous: false };
  return { origin: null, ambiguous: true };
}
function restoreRawReturnMarker(order) {
  if (!order.returnInfo) {
    if (String(order.ret || '') === 'WHD仓库（二次销售）') delete order.ret;
    return;
  }
  const status = order && order.returnInfo && (order.returnInfo.status || order.returnInfo.statusName);
  const mapped = orderMappings && orderMappings.returnStatusZh ? orderMappings.returnStatusZh(status) : '';
  if (mapped) order.ret = mapped;
  else if (String(order && order.ret || '') === 'WHD仓库（二次销售）') delete order.ret;
}

function clearStaleOriginLink(order, resalePosting) {
  if (!order) return false;
  const finance = order.finance && typeof order.finance === 'object' ? order.finance : null;
  const linked = String(order.retRel || '') === resalePosting || String(finance && finance.retResalePosting || '') === resalePosting;
  if (!linked) return false;
  delete order.retRel;
  restoreRawReturnMarker(order);
  if (finance) {
    const projectorSource = ['origin_actual_fee_items', 'origin_fee_pending_sync'].includes(String(finance.returnFeeSource || ''));
    delete finance.retResalePosting;
    delete finance.resaleIncomeRub;
    delete finance.resaleFeeRub;
    delete finance.firstIntlLogisticsRub;
    if (projectorSource) {
      delete finance.returnFeeRub;
      delete finance.returnFeePending;
      delete finance.returnFeeSource;
    }
    // projector 把原单收入强制置 0；解除错误关系时宁可暂时缺失，随后由正常 Seller 同步恢复，也不能继续保留假 0。
    delete finance.orderAmountRub;
    delete finance.orderAmount;
    if (Number(finance.sellerGrossRub) === 0) {
      delete finance.sellerGrossRub;
      delete finance.sellerGrossRubSource;
    }
  }
  return true;
}

function projectWhdOrders(options = {}) {
  const orders = Array.isArray(options.orders) ? options.orders : [];
  const whd = options.whd && typeof options.whd === 'object' ? options.whd : {};
  const feeMap = options.feeMap && typeof options.feeMap === 'object' ? options.feeMap : {};
  const shop = options.shop || {};
  const now = String(options.now || new Date().toISOString()).replace('T', ' ').slice(0, 19);
  let added = 0, linked = 0, ambiguous = 0, skippedNoIncome = 0;
  const changed = new Set();
  for (const [posting, operations] of Object.entries(whd)) {
    if (!shop.clientId) continue;
    const list = Array.isArray(operations) ? operations : [];
    const sale = list.find(operation => operation && operation.operation_type === 'OperationAgentDeliveredToCustomer');
    const skus = [...new Set((sale && sale.items || []).map(item => String(item && item.sku || '')).filter(Boolean))];
    const saleDate = list.map(operation => operation && operation.posting && operation.posting.order_date).find(Boolean) || '';
    const fee = feeMap[posting] || null;
    const income = round(fee && fee.sellerRub > 0 ? fee.sellerRub : sale && sale.accruals_for_sale);
    if (!(income > 0)) { skippedNoIncome += 1; continue; }
    const matched = matchingOrigin(orders, skus, saleDate, shop);
    if (matched.ambiguous) ambiguous += 1;
    const origin = matched.origin;
    for (const candidate of orders) {
      if (candidate === origin || ((candidate.clientId || candidate.tenantId) && !sameScope(candidate, shop)) || !clearStaleOriginLink(candidate, posting)) continue;
      changed.add(candidate);
    }
    const actualAcquiring = fee && fee.acq != null ? round(fee.acq) : null;
    const acquiring = actualAcquiring != null ? actualAcquiring : round(Math.min(income, 1500) * 0.014 + Math.max(income - 1500, 0) * 0.019);
    const acquiringSource = actualAcquiring != null ? fee.acqSource || 'ozon_v1_finance_accrual_postings' : '分层公式预估';
    // Legacy WHD operations are not the current FBO posting; they cannot prove a CNY sale price.
    const cnyTotal = null;
    const commission = fee ? round(fee.comm) : null, international = fee ? round(fee.intl) : null, last = fee && fee.last > 0 ? round(fee.last) : null;
    const returnHandling = fee ? round(fee.return || 0) : null;
    const other = fee ? round(fee.other || 0) : null;
    const normalized = normalizedFee(fee);
    let operationAcquiring = 0;
    list.forEach(operation => {
      const services = Array.isArray(operation && operation.services) ? operation.services : [];
      const isAcquiring = String(operation && operation.operation_type || '').includes('Acquiring') || services.some(service => String(service && service.name || '').includes('Acquiring'));
      const amount = Number(operation && operation.amount || 0);
      if (isAcquiring && amount < 0) operationAcquiring += Math.abs(amount);
    });
    const feeAcquiring = fee && normalized.acq != null ? round(normalized.acq) : 0;
    const acquiringExtra = feeAcquiring > 0 ? 0 : acquiring;
    const totalAcquiring = feeAcquiring > 0 ? feeAcquiring : acquiring;
    const logistics = round(normalized.logistics);
    const advertising = round(normalized.advertising);
    const ownItems = fee && Array.isArray(fee.items) ? fee.items.map(item => item && {
      ...item, kind: feeClassifier.classify(item), normalizedKind: feeClassifier.classify(item), feeRole: item.feeRole || 'resale_second'
    }) : [];
    if (acquiringExtra > 0 && !ownItems.some(item => feeClassifier.classify(item) === 'acq')) ownItems.push({
      type: 1, name: 'Acquiring', desc: 'Эквайринг', amount: acquiringExtra, direction: 'charge', kind: 'acq',
      feeRole: 'resale_second', source: 'whd_operation'
    });
    const originFee = origin ? feeMap[String(origin.posting || '')] || null : null;
    const originNormalized = originFee ? normalizedFee(originFee) : null;
    const originItems = originFee && Array.isArray(originFee.items) ? originFee.items.map(item => item && {
      ...item, kind: feeClassifier.classify(item), normalizedKind: feeClassifier.classify(item),
      feeRole: 'origin_refusal', originPosting: String(origin && origin.posting || '')
    }) : [];
    const originFeeTotal = originFee ? feeTotal(originFee) : null;
    const originInternational = originNormalized ? round(originNormalized.intl || 0) : null;
    const combinedInternational = originInternational == null ? international : round(international + originInternational);
    const foreignResale = orders.find(order => String(order && order.posting || '') === posting && !sameScope(order, shop));
    if (foreignResale) continue;
    let resale = orders.find(order => String(order && order.posting || '') === posting && sameScope(order, shop));
    if (!resale) {
      const firstItem = origin && origin.items && origin.items[0] ? { ...origin.items[0] } : null;
      resale = { posting, shop: shop.name || origin && origin.shop || '', clientId: shop.clientId, tenantId: shop.tenantId || undefined, status: '已签收', deliverySchema: 'WHD', items: firstItem ? [firstItem] : [],
        finance: { orderAmount: rub(income), cnyTotal, orderAmountRub: income, purchaseCost: origin && origin.finance && origin.finance.purchaseCost || '--', ozonFeeRub: commission, ozonFee: rub(commission), intlLogisticsRub: international, intlLogistics: rub(international), lastMileRub: last, lastMile: last == null ? null : rub(last), otherFeeRub: other, otherFee: rub(other), acquiringRub: acquiring, acquiringComplete: actualAcquiring != null, acquiringEstimated: actualAcquiring == null, acquiringSource, returnHandlingFeeRub: returnHandling, returnHandlingFee: returnHandling == null ? null : rub(returnHandling), feeItems: fee && Array.isArray(fee.items) ? fee.items.slice() : [], profit: '--' },
        retFrom: origin ? String(origin.posting) : '', orderTime: saleDate || now.slice(0, 10) + ' 00:00:00', updateTime: now, buyer: { name: '--', id: '', address: '--', addressZh: '--', phone: '' }, track: '--' };
      orders.unshift(resale); added += 1;
      changed.add(resale);
    } else {
      const finance = resale.finance || (resale.finance = {});
      if (fee && fee.sellerRub > 0) { finance.orderAmountRub = income; finance.orderAmount = rub(income); }
      finance.cnyTotal = null;
      if (fee) Object.assign(finance, { ozonFeeRub: commission, ozonFee: rub(commission), intlLogisticsRub: international, intlLogistics: rub(international), lastMileRub: last, lastMile: last == null ? null : rub(last), otherFeeRub: other, otherFee: rub(other), acquiringRub: acquiring, acquiringComplete: actualAcquiring != null, acquiringEstimated: actualAcquiring == null, acquiringSource, returnHandlingFeeRub: returnHandling, returnHandlingFee: rub(returnHandling), feeItems: Array.isArray(fee.items) ? fee.items.slice() : [] });
      changed.add(resale);
    }
    if (resale.deliverySchema !== 'WHD') { resale.deliverySchema = 'WHD'; changed.add(resale); }
    const resaleFinance = resale.finance || (resale.finance = {});
    const purchaseCost = resaleFinance.purchaseCost != null ? resaleFinance.purchaseCost : (origin && origin.finance && origin.finance.purchaseCost != null ? origin.finance.purchaseCost : '--');
    Object.assign(resaleFinance, {
      orderAmount: rub(income), cnyTotal: null, orderAmountRub: income, purchaseCost,
      ozonFeeRub: commission, ozonFee: rub(commission), acquiringRub: totalAcquiring, acquiring: rub(totalAcquiring), acquiringComplete: actualAcquiring != null, acquiringEstimated: actualAcquiring == null,
      intlLogisticsRub: combinedInternational, intlLogistics: rub(combinedInternational), secondIntlLogisticsRub: international,
      logisticsFeeRub: logistics, logisticsFee: rub(logistics), advertisingFeeRub: advertising, advertisingFee: rub(advertising),
      lastMileRub: last, lastMile: last == null ? null : rub(last), otherFeeRub: other, otherFee: rub(other),
      returnHandlingFeeRub: returnHandling, returnHandlingFee: returnHandling == null ? null : rub(returnHandling),
      accrualsComplete: !!fee, feeItems: ownItems.concat(originItems), resaleFeeRub: round(feeTotal(fee) + acquiringExtra),
      originPosting: origin ? String(origin.posting) : '', originFeeTotalRub: originFeeTotal, originIntlLogisticsRub: originInternational,
      returnFeeRub: originFeeTotal, returnFeeMerged: !!originFee, returnFeePending: !!origin && !originFee,
      profit: resaleFinance.profit || '--'
    });
    changed.add(resale);
    if (origin) {
      // 二次销售 posting 一旦存在，原退货即不再属于 WHD 仓库存货；只保留关联号，不制造额外“仓库（二次销售）”状态。
      delete origin.ret; origin.retRel = posting;
      const originFinance = origin.finance || (origin.finance = {});
      const originalFee = feeMap[origin.posting];
      if (originalFee) originFinance.returnFeeRub = round(feeTotal(originalFee));
      originFinance.resaleIncomeRub = income;
      if (fee) originFinance.resaleFeeRub = round(feeTotal(fee) + acquiringExtra);
      originFinance.retResalePosting = posting; originFinance.orderAmountRub = 0; originFinance.orderAmount = rub(0);
      resale.retFrom = String(origin.posting); linked += 1;
      changed.add(origin); changed.add(resale);
    }
  }
  return { orders, changedOrders: [...changed], added, linked, ambiguous, skippedNoIncome };
}

module.exports = { feeTotal, matchingOrigin, projectWhdOrders };
