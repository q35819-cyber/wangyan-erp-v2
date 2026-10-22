'use strict';

const { withRetry } = require('./category-attribute-sync');

const DAY_MS = 86400000;

function validDate(value) { const date = new Date(value); return isNaN(date.getTime()) ? null : date; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function isFresh(refreshedAt, now, ttlMs) {
  const refreshed = validDate(refreshedAt);
  return Boolean(refreshed && now.getTime() - refreshed.getTime() >= 0 && now.getTime() - refreshed.getTime() < ttlMs);
}

function createOrderAcquiringSync(options = {}) {
  const request = options.request;
  if (typeof request !== 'function') throw Object.assign(new Error('收单业务费同步组件未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'order_acquiring_sync_invalid' });
  const ttlMs = Math.max(60000, Number(options.ttlMs) || 24 * 60 * 60 * 1000);
  const maximumPages = Math.max(1, Math.min(60, Number(options.maximumPages) || 60));
  const persist = typeof options.persist === 'function' ? options.persist : async () => {};
  let cache = options.cache && typeof options.cache === 'object' ? { ...options.cache } : {};
  let whd = options.whd && typeof options.whd === 'object' ? { ...options.whd } : {};
  let operations = options.operations && typeof options.operations === 'object' ? { ...options.operations } : null;
  let types = Array.isArray(options.types) ? options.types.slice() : [];
  let refreshedAt = String(options.refreshedAt || '');
  let active = null;
  let lastRequestAt = 0;
  async function call(endpoint, body) {
    const waitMs = 1200 - (Date.now() - lastRequestAt);
    if (waitMs > 0) await sleep(waitMs);
    try { return await withRetry(request, endpoint, body, { attempts: 5 }); }
    finally { lastRequestAt = Date.now(); }
  }
  async function refresh(input = {}) {
    const now = validDate(input.now) || new Date();
    const requested = [...new Set((Array.isArray(input.postingNumbers) ? input.postingNumbers : []).map(value => String(value || '').trim()).filter(Boolean))];
    const fresh = !input.force && operations && isFresh(refreshedAt, now, ttlMs);
    if (fresh && requested.every(posting => Object.prototype.hasOwnProperty.call(operations, posting))) return { cache, whd, operations, types, refreshedAt, cacheHit: true, requests: 0 };
    if (active) return active;
    active = (async () => {
      const next = fresh ? { ...cache } : {};
      const operationsByPosting = fresh ? { ...operations } : {};
      let nextTypes = types;
      let requests = 0;
      if (!nextTypes.length) {
        const typeData = await call('/v1/finance/accrual/types', {});
        requests += 1;
        nextTypes = Array.isArray(typeData && typeData.accrual_types) ? typeData.accrual_types : [];
        if (!nextTypes.length) throw Object.assign(new Error('未能从Ozon取得应计费用类型清单，请稍后重试同步订单费用。'), { code: 'order_acquiring_types_unavailable' });
      }
      const typeMap = new Map(nextTypes.map(type => [String(type && type.id), type || {}]));
      const needed = requested.filter(posting => !fresh || !Object.prototype.hasOwnProperty.call(operationsByPosting, posting));
      for (let offset = 0; offset < needed.length; offset += 100) {
        const batch = needed.slice(offset, offset + 100);
        const data = await call('/v1/finance/accrual/postings', { posting_numbers: batch });
        requests += 1;
        const returned = new Map((Array.isArray(data && data.posting_accruals) ? data.posting_accruals : []).filter(item => item && item.posting_number && Array.isArray(item.accruals)).map(item => [String(item.posting_number), item.accruals]));
        for (const posting of batch) {
          if (!returned.has(posting)) continue;
          const records = returned.get(posting).map(record => ({ ...record, posting_number: posting, finance_type: typeMap.get(String(record && record.type_id)) || null }));
          const seen = new Set();
          operationsByPosting[posting] = records;
          const acquiringRecords = records.filter(record => {
            const type = record.finance_type || {}, name = String(type.name || '') + ' ' + String(type.description || '');
            return String(record && record.type_id) === '66' || /acquir|эквайр|RfbsGlobalAgentFee|Агентское вознаграждение Ozon/i.test(name);
          });
          if (!acquiringRecords.length) continue;
          next[posting] = acquiringRecords.reduce((sum, record) => {
            const stable = record && (record.id || record.accrual_id || record.operation_id);
            if (stable != null) {
              const key = 'id:' + stable;
              if (seen.has(key)) return sum;
              seen.add(key);
            }
            const amount = Number(record && record.accrued && record.accrued.amount || 0);
            return Number.isFinite(amount) ? sum + (amount < 0 ? Math.abs(amount) : -Math.abs(amount)) : sum;
          }, 0);
        }
      }
      const completedAt = now.toISOString();
      const nextWhd = whd;
      for (const posting of Object.keys(next)) next[posting] = Number(next[posting].toFixed(2));
      await persist({ cache: next, whd: nextWhd, operations: operationsByPosting, types: nextTypes, refreshedAt: completedAt });
      cache = next;
      whd = nextWhd;
      operations = operationsByPosting;
      types = nextTypes;
      refreshedAt = completedAt;
      return { cache, whd, operations, types, refreshedAt, cacheHit: false, requests };
    })();
    try { return await active; } finally { active = null; }
  }
  return { refresh, state: () => ({ cache: { ...cache }, whd: { ...whd }, operations: operations ? { ...operations } : null, types: types.slice(), refreshedAt }) };
}

module.exports = { DAY_MS, isFresh, createOrderAcquiringSync };
