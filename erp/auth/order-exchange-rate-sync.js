'use strict';

const { historicalCnyRubRate } = require('./cny-rub-rate');

function orderDate(order) {
  const value = String(order && order.orderTime || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function hasLockedRate(order) {
  const finance = order && order.finance || {};
  const cnyPerRub = Number(finance.orderCnyPerRub);
  const rubPerCny = Number(finance.orderRubPerCny);
  const date = String(finance.orderRateDate || '').slice(0, 10);
  const source = String(finance.orderRateSource || '');
  return cnyPerRub > 0 && rubPerCny > 0 && date === orderDate(order) && source === 'bank_of_russia';
}

function selectTargets(orders, clientId) {
  return (Array.isArray(orders) ? orders : []).filter(order => {
    if (!order || String(order.clientId || '') !== String(clientId || '')) return false;
    if (!orderDate(order)) return false;
    return !hasLockedRate(order);
  });
}

async function syncOrderExchangeRates(options = {}) {
  const store = options.store;
  const persist = options.persist;
  if (!store || typeof persist !== 'function') {
    throw Object.assign(new Error('订单历史汇率同步器未正确初始化。'), { code: 'order_rate_sync_invalid' });
  }
  const targets = selectTargets(options.orders, options.clientId);
  const byDate = new Map();
  for (const order of targets) {
    const date = orderDate(order);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(order);
  }
  const patches = [];
  for (const [date, rows] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const value = await historicalCnyRubRate({
      now: new Date(date + 'T12:00:00+08:00'),
      store,
      timeoutMs: Number(options.timeoutMs) || 12000
    });
    if (!value || value.fallback || !(Number(value.rate) > 0) || String(value.source || '') !== 'bank_of_russia') {
      throw Object.assign(new Error('订单 ' + date + ' 的历史官方汇率不可用，已停止同步。'), { code: 'order_history_rate_unavailable', date });
    }
    const rubPerCny = Math.round(Number(value.rate) * 10000) / 10000;
    const cnyPerRub = Math.round((1 / rubPerCny) * 100000000) / 100000000;
    rows.forEach(order => patches.push({
      posting: String(order.posting || ''),
      rubPerCny,
      cnyPerRub,
      rateDate: date,
      effectiveDate: String(value.effectiveDate || date).slice(0, 10),
      source: 'bank_of_russia'
    }));
  }
  for (let offset = 0; offset < patches.length; offset += 100) {
    await persist(patches.slice(offset, offset + 100));
  }
  return { targeted: targets.length, updated: patches.length, dates: byDate.size };
}

module.exports = { orderDate, hasLockedRate, selectTargets, syncOrderExchangeRates };
