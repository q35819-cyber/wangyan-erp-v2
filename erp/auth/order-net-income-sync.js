'use strict';

const { sleep } = require('./category-attribute-sync');

function moneyAmount(value) {
  const raw = value && typeof value === 'object' ? value.amount : value;
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  if (value && typeof value === 'object') {
    const currency = String(value.currency_code || value.currency || '').trim().toUpperCase();
    if (currency && currency !== 'RUB') return null;
  }
  return number;
}

function deliveredDate(order) {
  const value = String(order && order.deliveredDate || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function selectTargets(orders, clientId, options = {}) {
  const selected = new Set((options.postingNumbers || []).map(String).filter(Boolean));
  const selectedMode = options.mode === 'selected' && selected.size > 0;
  const now = new Date(options.now || Date.now());
  const threshold = new Date(now.getTime() - Math.max(1, Number(options.refreshDays) || 30) * 86400000);
  return (Array.isArray(orders) ? orders : []).filter(order => {
    if (!order || order.status !== '已签收' || String(order.clientId || '') !== String(clientId || '')) return false;
    const date = deliveredDate(order);
    if (!date) return false;
    if (selectedMode) return selected.has(String(order.posting || ''));
    const net = order.finance && order.finance.ozonNetIncomeRub;
    if (net == null || net === '') return true;
    const delivered = new Date(date + 'T00:00:00Z');
    return !Number.isNaN(delivered.getTime()) && delivered >= threshold;
  });
}

function aggregateAccruals(accruals, wanted) {
  const sums = new Map();
  const counts = new Map();
  for (const accrual of Array.isArray(accruals) ? accruals : []) {
    const unit = String(accrual && accrual.unit_number || '').trim();
    if (!unit || (wanted && !wanted.has(unit))) continue;
    const value = moneyAmount(accrual && accrual.total_amount);
    if (value == null) continue;
    sums.set(unit, (sums.get(unit) || 0) + value);
    counts.set(unit, (counts.get(unit) || 0) + 1);
  }
  return { sums, counts };
}

async function fetchAccrualDay(request, date, options = {}) {
  let lastId = '';
  const rows = [];
  for (let page = 0; page < 100; page += 1) {
    const data = await request('/v1/finance/accrual/by-day', { date, last_id: lastId });
    rows.push(...(Array.isArray(data && data.accruals) ? data.accruals : []));
    lastId = String(data && data.last_id || '');
    if (!lastId) break;
    if (page === 99) throw Object.assign(new Error('Ozon财务应计分页超过安全上限，已停止同步。'), { code: 'order_net_income_page_limit' });
    await sleep(Math.max(50, Number(options.pageDelayMs) || 150));
  }
  return rows;
}

async function syncOrderNetIncome(options = {}) {
  const request = options.request;
  const persist = options.persist;
  if (typeof request !== 'function' || typeof persist !== 'function') throw Object.assign(new Error('订单净收入同步器未正确初始化。'), { code: 'order_net_income_sync_invalid' });
  const clientId = String(options.clientId || '');
  const targets = selectTargets(options.orders, clientId, options);
  const byDate = new Map();
  for (const order of targets) {
    const date = deliveredDate(order);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(order);
  }
  const patches = [];
  for (const [date, orders] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wanted = new Set(orders.map(order => String(order.posting || '')).filter(Boolean));
    const accruals = await fetchAccrualDay(request, date, options);
    const grouped = aggregateAccruals(accruals, wanted);
    for (const order of orders) {
      const posting = String(order.posting || '');
      if (!grouped.sums.has(posting)) continue;
      patches.push({
        posting,
        value: Math.round(grouped.sums.get(posting) * 100) / 100,
        source: 'ozon_finance_accrual_by_day_total_amount',
        accrualDate: date,
        accrualCount: grouped.counts.get(posting) || 0
      });
    }
    if (options.delayMs !== 0) await sleep(Math.max(50, Number(options.delayMs) || 200));
  }
  for (let offset = 0; offset < patches.length; offset += 100) await persist(patches.slice(offset, offset + 100));
  return { targeted: targets.length, updated: patches.length, missing: Math.max(0, targets.length - patches.length), dates: byDate.size };
}

module.exports = { moneyAmount, deliveredDate, selectTargets, aggregateAccruals, fetchAccrualDay, syncOrderNetIncome };
