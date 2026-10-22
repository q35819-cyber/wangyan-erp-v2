'use strict';

const mapper = require('../assets/order-sync-map');
const orderMappings = require('../assets/order-mappings');
const { withRetry, sleep } = require('./category-attribute-sync');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function iso(value) { return new Date(value).toISOString(); }
function amount(value) { return value && typeof value === 'object' ? value.amount : value; }
function currency(value, fallback) {
  if (value && typeof value === 'object') return String(value.currency_code || value.currency || fallback || '').trim().toUpperCase();
  return String(fallback || '').trim().toUpperCase();
}
function normalizeV4Posting(posting) {
  const normalized = clone(posting || {});
  normalized.products = (normalized.products || []).map(product => {
    const rawPrice = product && product.price;
    return { ...product, price: amount(rawPrice), price_currency_code: product.price_currency_code || currency(rawPrice, product.currency_code) };
  });
  if (normalized.financial_data && Array.isArray(normalized.financial_data.products)) normalized.financial_data.products = normalized.financial_data.products.map(product => {
    const rawPrice = product && product.price;
    const rawCustomerPrice = product && product.customer_price;
    return { ...product,
      price: amount(rawPrice),
      price_currency_code: product.price_currency_code || currency(rawPrice, product.currency_code),
      customer_price: amount(rawCustomerPrice),
      customer_currency_code: product.customer_currency_code || product.customerCurrency || currency(rawCustomerPrice, product.customer_currency_code),
      commission_amount: amount(product.commission), payout: amount(product.payout) };
  });
  return normalized;
}

function isUnknownPostingError(error) {
  const message = String(error && (error.externalMessage || error.message) || '').trim();
  return /^Unknown posting number(?:\s|\"|$)/i.test(message);
}

function returnState(value) {
  return orderMappings.returnStatusZh(value);
}

function applyReturnRecord(order, record) {
  if (!order || !record) return order;
  const reason = String(record.return_reason_name || record.return_reason && record.return_reason.name || '').trim();
  const visual = record.visual && record.visual.status || record.state || {};
  const state = returnState(visual.sys_name || visual.state);
  order.returnInfo = {
    id: String(record.id || record.return_id || ''),
    number: String(record.return_number || ''),
    type: String(record.type || ''),
    status: String(visual.sys_name || visual.state || ''),
    statusName: String(visual.display_name || visual.state_name || ''),
    reason,
    updatedAt: String(record.visual && record.visual.change_moment || record.logistic && record.logistic.return_date || '')
  };
  order.returnReason = reason;
  order.returnReasonZh = reason ? orderMappings.cancelReasonZh(reason) : '暂无原因';
  if (state) order.ret = state;
  return order;
}

async function runOrderSync(options = {}) {
  const request = options.request;
  const persistBatch = options.persistBatch;
  const finalize = options.finalize;
  const checkpoint = typeof options.checkpoint === 'function' ? options.checkpoint : async () => {};
  const progress = typeof options.progress === 'function' ? options.progress : async () => {};
  const enrichBatch = options.enrichBatch;
  if (typeof request !== 'function' || typeof persistBatch !== 'function' || typeof finalize !== 'function' || typeof enrichBatch !== 'function') throw Object.assign(new Error('订单同步执行器未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'order_sync_runner_invalid' });
  const shop = { ...(options.shop || {}) };
  const state = options.state || {};
  const mode = options.mode === 'selected' ? 'selected' : 'all';
  const runId = String(options.runId || state.runId || '');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('本轮订单同步任务编号无效，请在任务中心重新发起一次同步。'), { code: 'order_sync_run_id_invalid' });
  const oldMap = new Map((Array.isArray(options.existing) ? options.existing : []).filter(item => String(item.clientId || '') === String(shop.clientId || '')).map(item => [String(item.posting || ''), item]));
  let processed = 0;
  async function call(endpoint, body) { return withRetry(request, endpoint, body, { attempts: 5 }); }
  const returnByPosting = new Map();
  if (options.discoverReturns) {
    let lastId = 0;
    for (let page = 0; page < 20; page += 1) {
      const filter = mode === 'selected'
        ? { posting_numbers: [...new Set((options.postingNumbers || []).map(String).filter(Boolean))].slice(0, 1000) }
        : { logistic_return_date: { time_from: iso(new Date(new Date(options.rangeEnd || state.rangeEnd || new Date()).getTime() - 365 * 86400000)), time_to: iso(options.rangeEnd || state.rangeEnd || new Date()) } };
      const data = await call('/v1/returns/list', { filter, limit: 500, last_id: lastId });
      const returns = Array.isArray(data && data.returns) ? data.returns : [];
      returns.forEach(item => { if (item && item.posting_number) returnByPosting.set(String(item.posting_number), item); });
      if (!data || !data.has_next || !returns.length) break;
      lastId = Number(returns[returns.length - 1].id) || 0;
      if (!lastId) throw Object.assign(new Error('退货订单分页读取中断，请稍后重试；若持续失败请重新同步订单。'), { code: 'order_returns_page_invalid' });
    }
    const rfbsFilters = mode === 'selected'
      ? [...new Set((options.postingNumbers || []).map(String).filter(Boolean))].map(posting_number => ({ posting_number }))
      : [{ created_at: { from: iso(new Date(new Date(options.rangeEnd || state.rangeEnd || new Date()).getTime() - 365 * 86400000)), to: iso(options.rangeEnd || state.rangeEnd || new Date()) } }];
    for (const filter of rfbsFilters) {
      let rfbsLastId = 0;
      for (let page = 0; page < 20; page += 1) {
        const data = await call('/v2/returns/rfbs/list', { filter, limit: 1000, last_id: rfbsLastId });
        const returns = Array.isArray(data && data.returns) ? data.returns : [];
        for (const item of returns) {
          if (!item || !item.return_id) continue;
          const detail = await call('/v2/returns/rfbs/get', { return_id: item.return_id });
          const record = detail && detail.returns;
          if (record && record.posting_number) returnByPosting.set(String(record.posting_number), { ...item, ...record, return_id: item.return_id });
        }
        if (returns.length < 1000) break;
        rfbsLastId = Number(returns[returns.length - 1].return_id) || 0;
        if (!rfbsLastId) throw Object.assign(new Error('realFBS退货分页读取中断，请稍后重试；若持续失败请重新同步订单。'), { code: 'order_rfbs_returns_page_invalid' });
      }
    }
  }
  async function save(postings) {
    const rows = [];
    for (const posting of postings) {
      const number = String(posting && posting.posting_number || '');
      if (!number) continue;
      const list = oldMap.has(number) ? [clone(oldMap.get(number))] : [];
      const result = mapper.upsert(list, posting, shop, null, options.mapOptions || {});
      applyReturnRecord(result.order, returnByPosting.get(number));
      oldMap.set(number, result.order);
      rows.push(result.order);
    }
    const enriched = await enrichBatch(rows, postings, shop);
    if (!Array.isArray(enriched) || enriched.length !== rows.length) throw Object.assign(new Error('订单费用与图片补算条数不一致，本轮已停止入库，请稍后重试。'), { code: 'order_sync_enrichment_incomplete' });
    if (enriched.length) await persistBatch(enriched, runId);
    processed += postings.length;
    await progress({ processed, saved: enriched.length });
  }
  async function selectedFboPosting(postingNumber) {
    const endValue = options.rangeEnd || state.rangeEnd || new Date();
    const end = new Date(endValue);
    const safeEnd = isNaN(end.getTime()) ? new Date() : end;
    const sinceValue = options.since || state.since;
    const parsedSince = sinceValue ? new Date(sinceValue) : new Date(safeEnd.getTime() - 365 * 86400000);
    const safeSince = isNaN(parsedSince.getTime()) || parsedSince >= safeEnd ? new Date(safeEnd.getTime() - 365 * 86400000) : parsedSince;
    let cursor = '';
    for (let page = 0; page < 100; page += 1) {
      const data = await call('/v3/posting/fbo/list', {
        sort_dir: 'ASC', filter: { since: iso(safeSince), to: iso(safeEnd) }, limit: 100, cursor, translit: false,
        with: { analytics_data: true, financial_data: true, legal_info: false }
      });
      const exact = (Array.isArray(data && data.postings) ? data.postings : []).filter(posting => String(posting && posting.posting_number || '') === postingNumber);
      if (exact.length > 1) throw Object.assign(new Error('Ozon FBO/WHD订单返回了重复货件号，本单已停止同步，请稍后重试。'), { code: 'order_sync_fbo_posting_ambiguous' });
      if (exact.length === 1) {
        const normalized = normalizeV4Posting(exact[0]);
        if (!normalized.delivery_schema) normalized.delivery_schema = String(oldMap.get(postingNumber) && oldMap.get(postingNumber).deliverySchema || '').toUpperCase() === 'WHD' ? 'WHD' : 'FBO';
        return normalized;
      }
      cursor = data && data.has_next === true ? String(data.cursor || '') : '';
      if (!cursor) break;
    }
    return null;
  }
  if (mode === 'selected') {
    const postingNumbers = [...new Set((Array.isArray(options.postingNumbers) ? options.postingNumbers : []).map(String).filter(Boolean))].slice(0, 1000);
    if (!postingNumbers.length) throw Object.assign(new Error('本次收单业务费查询没有可用的货件号，请先同步订单后再试。'), { code: 'order_sync_posting_numbers_required' });
    const start = Math.max(0, Math.min(postingNumbers.length, Number(state.offset) || 0));
    for (let index = start; index < postingNumbers.length; index += 1) {
      const postingNumber = postingNumbers[index];
      let posting;
      try {
        const data = await call('/v3/posting/fbs/get', { posting_number: postingNumber, with: { analytics_data: true, financial_data: true } });
        posting = data && data.result;
        if (!posting || String(posting.posting_number || '') !== postingNumber) throw Object.assign(new Error('Ozon返回的订单与请求货件号不一致，本单已停止同步，请稍后重试。'), { code: 'order_sync_posting_response_invalid' });
      } catch (error) {
        if (!isUnknownPostingError(error)) throw error;
        posting = await selectedFboPosting(postingNumber);
        if (!posting) throw Object.assign(new Error('Ozon FBS与FBO/WHD接口都没有找到这个完整货件号，本单已停止同步，请核对订单号后重试。'), { code: 'order_sync_selected_posting_not_found' });
      }
      await save([posting]);
      await checkpoint({ mode, postingNumbers, offset: index + 1, runId, rangeEnd: '' });
      if (index + 1 < postingNumbers.length) await sleep(Math.max(200, Number(options.delayMs) || 350));
    }
    const result = await finalize(runId, false);
    await checkpoint({ mode, postingNumbers, offset: postingNumbers.length, runId, rangeEnd: '', phase: 'DONE' });
    return { processed, ...result };
  }
  const rangeEnd = iso(options.rangeEnd || state.rangeEnd || new Date());
  const anchor = new Date(rangeEnd);
  const rangeStart = options.since ? new Date(options.since) : null;
  if (rangeStart && (isNaN(rangeStart.getTime()) || rangeStart >= anchor)) throw Object.assign(new Error('所选同步日期范围无效，开始时间必须早于结束时间且不超过允许天数，请重新选择日期范围。'), { code: 'order_sync_range_invalid' });
  // WHD转售单在备货阶段尚无成交流水，优先从未处理货件接口发现并保存。
  if (options.discoverUnfulfilled && !state.unfulfilledDone) {
    let cursor = '', page = 0;
    do {
      const from = new Date(anchor.getTime() - 365 * 86400000), to = new Date(anchor.getTime() + 31 * 86400000);
      const data = await call('/v4/posting/fbs/unfulfilled/list', { sort_dir: 'asc', limit: 100, cursor, filter: { cutoff_from: iso(from), cutoff_to: iso(to), delivery_method_ids: [], provider_ids: [], statuses: [], warehouse_ids: [], last_change_status_date: { from: iso(from), to: rangeEnd } }, with: { barcodes: true, analytics_data: true, financial_data: true, legal_info: false } });
      const postings = Array.isArray(data && data.postings) ? data.postings : [];
      const whd = postings.filter(posting => String(posting && posting.delivery_schema || '').toUpperCase() === 'WHD').map(normalizeV4Posting);
      if (whd.length) await save(whd);
      cursor = data && data.has_next ? String(data.cursor || '') : '';
      page += 1;
    } while (cursor && page < 10);
    await checkpoint({ mode, postingNumbers: [], windowIndex: 0, offset: 0, runId, rangeEnd, unfulfilledDone: true });
  }
  const windowCount = Math.max(1, Math.min(14, Number(options.windowCount) || 13));
  let windowIndex = Math.max(0, Math.min(windowCount - 1, Number(state.windowIndex) || 0));
  let offset = Math.max(0, Math.min(1000, Number(state.offset) || 0));
  for (; windowIndex < windowCount; windowIndex += 1) {
    const to = new Date(anchor.getTime() - windowIndex * 28 * 86400000);
    const defaultSince = new Date(to.getTime() - 28 * 86400000 + 1);
    const since = rangeStart && rangeStart > defaultSince ? rangeStart : defaultSince;
    if (since > to) break;
    while (offset < 1000) {
      const data = await call('/v3/posting/fbs/list', { dir: 'asc', filter: { since: iso(since), to: iso(to), delivery_method_id: [], provider_id: [], warehouse_id: [] }, limit: 100, offset, translit: false, with: { analytics_data: true, financial_data: true } });
      const result = data && data.result || {};
      const postings = Array.isArray(result.postings) ? result.postings : [];
      if (postings.length) await save(postings);
      const count = Math.max(0, Number(result.count) || postings.length);
      const nextOffset = offset + 100;
      if (!postings.length || nextOffset >= count || nextOffset >= 1000) break;
      offset = nextOffset;
      await checkpoint({ mode, postingNumbers: [], windowIndex, offset, runId, rangeEnd });
    }
    offset = 0;
    await checkpoint({ mode, postingNumbers: [], windowIndex: windowIndex + 1, offset: 0, runId, rangeEnd });
  }
  const result = await finalize(runId, options.fullFinalize !== false);
  await checkpoint({ mode, postingNumbers: [], windowIndex: windowCount - 1, offset: 1000, runId, rangeEnd, phase: 'DONE' });
  return { processed, ...result };
}

module.exports = { normalizeV4Posting, isUnknownPostingError, returnState, applyReturnRecord, runOrderSync };
