'use strict';

const feeClassifier = require('../assets/order-fee-classification');

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function text(value) { return String(value == null ? '' : value).trim(); }

function flattenAdvertisingAccruals(payload, typeMap, context = {}) {
  const out = [];
  const types = typeMap instanceof Map ? typeMap : new Map((Array.isArray(typeMap) ? typeMap : []).map(item => [String(item.id), item]));
  const push = (typeId, accrued, meta) => {
    const id = String(typeId == null ? '' : typeId);
    if (!id) return;
    const type = types.get(id) || {};
    const raw = Number(accrued && accrued.amount != null ? accrued.amount : accrued);
    if (!Number.isFinite(raw) || raw === 0) return;
    const probe = { type: id, name: type.name || '', desc: type.description || '', rawName: type.name || '', description: type.description || '' };
    if (feeClassifier.classify(probe) !== 'advertising') return;
    const amount = Math.abs(raw);
    const chargeModel = feeClassifier.advertisingChargeModel(probe);
    out.push({
      date: text(context.date),
      clientId: text(context.clientId),
      type: id,
      typeName: text(type.name),
      description: text(type.description),
      label: feeClassifier.displayLabel(probe, 'advertising'),
      chargeModel,
      chargeLabel: feeClassifier.AD_CHARGE_LABELS[chargeModel] || feeClassifier.AD_CHARGE_LABELS.OTHER,
      amountRub: amount,
      signedAmount: raw,
      direction: raw < 0 ? 'charge' : 'credit',
      unitNumber: text(context.unitNumber),
      posting: text(context.posting),
      source: text(meta && meta.source) || 'ozon_finance_accrual_by_day'
    });
  };
  for (const accrual of Array.isArray(payload && payload.accruals) ? payload.accruals : []) {
    const base = {
      date: text(accrual && accrual.date) || text(context.date),
      clientId: text(context.clientId),
      unitNumber: text(accrual && accrual.unit_number),
      posting: text(accrual && accrual.posting && (accrual.posting.posting_number || accrual.posting.postingNumber))
    };
    if (accrual && accrual.non_item_fee) push(accrual.non_item_fee.type_id, accrual.non_item_fee.accrued, { source: 'ozon_finance_accrual_by_day_non_item' });
    for (const group of Array.isArray(accrual && accrual.item_fees && accrual.item_fees.fees) ? accrual.item_fees.fees : []) {
      for (const fee of Array.isArray(group && group.fees) ? group.fees : []) push(fee.type_id, fee.accrued, { source: 'ozon_finance_accrual_by_day_item' });
    }
    for (const product of Array.isArray(accrual && accrual.posting && accrual.posting.products) ? accrual.posting.products : []) {
      for (const service of Array.isArray(product && product.delivery && product.delivery.services) ? product.delivery.services : []) push(service.type_id, service.accrued, { source: 'ozon_finance_accrual_by_day_delivery' });
      if (product && product.commission && product.commission.type_id != null) push(product.commission.type_id, product.commission.accrued, { source: 'ozon_finance_accrual_by_day_commission' });
    }
    // Restore the parent accrual context on records just appended for this accrual.
    for (let i = out.length - 1; i >= 0 && !out[i]._contextApplied; i -= 1) {
      out[i].date = base.date; out[i].clientId = base.clientId; out[i].unitNumber = base.unitNumber; out[i].posting = base.posting; out[i]._contextApplied = true;
    }
  }
  out.forEach(item => { delete item._contextApplied; });
  return out;
}

function summarize(records) {
  const byKey = new Map();
  for (const item of Array.isArray(records) ? records : []) {
    const key = [item.clientId, item.chargeModel, item.type, item.label].join('|');
    let row = byKey.get(key);
    if (!row) {
      row = { clientId: item.clientId, chargeModel: item.chargeModel, chargeLabel: item.chargeLabel, type: item.type, typeName: item.typeName, label: item.label, amountRub: 0, count: 0 };
      byKey.set(key, row);
    }
    row.amountRub += item.direction === 'credit' ? -Number(item.amountRub || 0) : Number(item.amountRub || 0);
    row.count += 1;
  }
  return Array.from(byKey.values()).map(row => ({ ...row, amountRub: round(row.amountRub) }))
    .filter(row => row.amountRub !== 0)
    .sort((a, b) => Math.abs(b.amountRub) - Math.abs(a.amountRub));
}

async function fetchDate(request, date, clientId, types) {
  let lastId = '', guard = 0;
  const records = [];
  do {
    const payload = await request('/v1/finance/accrual/by-day', { date, last_id: lastId });
    records.push(...flattenAdvertisingAccruals(payload, types, { date, clientId }));
    lastId = text(payload && payload.last_id);
    guard += 1;
    if (guard > 100) {
      const error = new Error('Ozon 广告财务分页超过安全上限，请缩小统计日期范围后重试。');
      error.publicCode = 'order_advertising_page_limit';
      throw error;
    }
  } while (lastId);
  return records;
}

function dateKeys(fromValue, toValue) {
  const from = new Date(String(fromValue || '') + 'T00:00:00Z');
  const to = new Date(String(toValue || '') + 'T00:00:00Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
  const out = [];
  for (let cursor = new Date(from); cursor <= to; cursor = new Date(cursor.getTime() + 86400000)) out.push(cursor.toISOString().slice(0, 10));
  return out;
}

function daySnapshot(date, clientId, records) {
  const rows = Array.isArray(records) ? records : [];
  // 只有点击/展示类广告允许永久没有订单归属。CPO（按订单付费）必须由 Performance API 订单报告继续归属，不能因为 Seller 日级记录暂时没有 posting 就标成“无法归属”。
  const unallocatedRecords = rows.filter(item => !item.posting && /_non_item$/.test(String(item.source || '')) && ['CPC','CPM'].includes(String(item.chargeModel || '')));
  return {
    date: text(date), clientId: text(clientId), fetchedAt: new Date().toISOString(),
    records: rows, breakdown: summarize(rows),
    unallocatedRecords, unallocatedBreakdown: summarize(unallocatedRecords)
  };
}

function combineDays(days, dates) {
  const selected = (Array.isArray(dates) ? dates : Object.keys(days || {})).map(date => days && days[date]).filter(Boolean);
  const records = [], unallocatedRecords = [];
  selected.forEach(day => {
    records.push(...(Array.isArray(day.records) ? day.records : []));
    unallocatedRecords.push(...(Array.isArray(day.unallocatedRecords) ? day.unallocatedRecords : []));
  });
  return {
    records, breakdown: summarize(records),
    unallocatedRecords, unallocatedBreakdown: summarize(unallocatedRecords)
  };
}

async function fetchRangeCached(request, input = {}) {
  const clientId = text(input.clientId);
  const dates = dateKeys(input.from, input.to);
  if (!clientId || !dates.length) {
    const error = new Error('广告统计日期或店铺信息不正确，请重新选择统计范围。');
    error.publicCode = 'order_advertising_range_invalid';
    throw error;
  }
  if (dates.length > 93) {
    const error = new Error('广告费用一次最多读取93天，请缩小日期范围后重试。');
    error.publicCode = 'order_advertising_range_too_large';
    throw error;
  }
  const sourceDays = input.cachedDays && typeof input.cachedDays === 'object' ? input.cachedDays : {};
  const days = {};
  dates.forEach(date => {
    const cached = sourceDays[date];
    if (cached && cached.date === date && String(cached.clientId || '') === clientId && Array.isArray(cached.records)) {
      // 旧缓存曾把 CPO 也标成永久无法归属；每次复用时按当前规则从原始 records 重新投影，避免历史错误继续污染统计。
      days[date] = { ...daySnapshot(date, clientId, cached.records), fetchedAt: cached.fetchedAt || new Date().toISOString() };
    }
  });
  const missingDates = input.force === true ? dates.slice() : dates.filter(date => !days[date]);
  let types = null;
  if (missingDates.length) {
    const typePayload = await request('/v1/finance/accrual/types', {});
    types = new Map((Array.isArray(typePayload && typePayload.accrual_types) ? typePayload.accrual_types : []).map(item => [String(item.id), item]));
  }
  for (const date of missingDates) {
    const records = await fetchDate(request, date, clientId, types);
    days[date] = daySnapshot(date, clientId, records);
  }
  const combined = combineDays(days, dates);
  return {
    ...combined, days,
    fetchedDates: missingDates,
    cachedDates: dates.filter(date => !missingDates.includes(date))
  };
}

async function fetchRange(request, input = {}) {
  return fetchRangeCached(request, input);
}

module.exports = { flattenAdvertisingAccruals, summarize, dateKeys, daySnapshot, combineDays, fetchDate, fetchRangeCached, fetchRange };
