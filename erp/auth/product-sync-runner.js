'use strict';

const mapper = require('../assets/online-product-sync-map');
const statusModel = require('../assets/online-product-status');
const format = require('../assets/online-product-format');
const { withRetry, sleep } = require('./category-attribute-sync');

function values(payload, key) {
  const value = payload && payload[key];
  return Array.isArray(value) ? value : [];
}

async function runProductSync(options = {}) {
  const request = options.request;
  const persistBatch = options.persistBatch;
  const finalize = options.finalize;
  const checkpoint = typeof options.checkpoint === 'function' ? options.checkpoint : async () => {};
  const progress = typeof options.progress === 'function' ? options.progress : async () => {};
  if (typeof request !== 'function' || typeof persistBatch !== 'function' || typeof finalize !== 'function') throw Object.assign(new Error('商品同步执行器未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'product_sync_runner_invalid' });
  const shop = { ...(options.shop || {}) };
  const full = options.mode !== 'selected';
  const selectedIds = [...new Set((Array.isArray(options.productIds) ? options.productIds : []).map(String).filter(Boolean))].slice(0, 1000);
  if (!full && !selectedIds.length) throw Object.assign(new Error('请先勾选要同步的商品，或选择同步全部商品。'), { code: 'product_sync_product_ids_required' });
  const oldMap = new Map((Array.isArray(options.existing) ? options.existing : []).filter(item => String(item.clientId || item.shopId || '') === String(shop.clientId)).map(item => [String(item.id || item.productId || ''), item]));
  const state = options.state || {};
  const runId = String(options.runId || state.runId || '');
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('本轮商品同步任务编号无效，请在任务中心重新发起一次同步。'), { code: 'product_sync_run_id_invalid' });
  let processed = 0;

  async function call(endpoint, body) { return withRetry(request, endpoint, body, { attempts: 5 }); }
  try {
    const warehouses = await call('/v2/warehouse/list', { limit: 200 });
    const mode = format.warehouseMode(warehouses && (warehouses.warehouses || warehouses.result) || [], shop.fulfillmentSchema || 'rFBS');
    Object.assign(shop, { fulfillmentSchema: mode.schema || 'rFBS', fulfillmentWarehouseNames: mode.names, warehouseOptions: mode.options, warehouse: mode.options.length });
    if (typeof options.persistShop === 'function') await options.persistShop(shop);
  } catch (_) {
    shop.fulfillmentSchema = shop.fulfillmentSchema || 'rFBS';
  }

  async function processIds(ids, archived) {
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const info = await call('/v3/product/info/list', { product_id: batch, limit: 100, sort_dir: 'ASC' });
      const items = values(info, 'items');
      const returnedIds = new Set(items.map(item => String(item && item.id)));
      if (batch.some(id => !returnedIds.has(String(id)))) throw Object.assign(new Error('商品同步返回的结果缺少部分商品，本轮已停止入库，请稍后重试。'), { code: 'product_sync_incomplete_batch' });
      const pricePromise = archived ? Promise.resolve({ items: [] }) : call('/v5/product/info/prices', { filter: { product_id: batch, visibility: 'ALL' }, limit: 100, cursor: '' }).catch(() => ({ items: [] }));
      const attributePromise = call('/v4/product/info/attributes', { filter: { product_id: batch, visibility: 'ALL' }, limit: 100, last_id: '', sort_dir: 'ASC' }).catch(() => ({ result: [] }));
      const [priceData, attributeData] = await Promise.all([pricePromise, attributePromise]);
      const priceById = new Map(), priceByOffer = new Map(), attributeById = new Map(), attributeByOffer = new Map();
      values(priceData, 'items').forEach(item => {
        if (item.product_id != null) priceById.set(String(item.product_id), item.price || {});
        if (item.offer_id) priceByOffer.set(String(item.offer_id), item.price || {});
      });
      const attributes = Array.isArray(attributeData && attributeData.result) ? attributeData.result : values(attributeData, 'items');
      attributes.forEach(item => {
        if (item.id != null) attributeById.set(String(item.id), item);
        if (item.offer_id) attributeByOffer.set(String(item.offer_id), item);
      });
      const converted = [];
      items.forEach(item => {
        if (!statusModel.shouldInclude(item)) return;
        item._ozonPrice = priceById.get(String(item.id)) || priceByOffer.get(String(item.offer_id)) || {};
        item._ozonAttributes = attributeById.get(String(item.id)) || attributeByOffer.get(String(item.offer_id)) || null;
        if (archived) item.is_archived = true;
        const row = mapper.convert(shop, item, oldMap.get(String(item.id)), options.mapOptions || {});
        oldMap.set(String(item.id), row);
        converted.push(row);
      });
      if (converted.length) await persistBatch(converted, runId);
      processed += batch.length;
      await progress({ processed, batch: batch.length, saved: converted.length });
      if (offset + 100 < ids.length) await sleep(Math.max(250, Number(options.delayMs) || 350));
    }
  }

  if (!full) {
    await processIds(selectedIds, false);
    return { processed, ...(await finalize(runId, false)) };
  }

  const phases = ['ALL', 'ARCHIVED'];
  let phaseIndex = Math.max(0, phases.indexOf(String(state.phase || 'ALL')));
  let lastId = String(state.lastId || '');
  for (; phaseIndex < phases.length; phaseIndex += 1) {
    const phase = phases[phaseIndex];
    let pages = 0;
    while (true) {
      const data = await call('/v3/product/list', { filter: { visibility: phase }, last_id: lastId, limit: 1000 });
      const result = data && data.result || {};
      const ids = values(result, 'items').map(item => item && item.product_id).filter(id => id != null);
      if (ids.length) await processIds(ids, phase === 'ARCHIVED');
      const nextId = String(result.last_id || '');
      pages += 1;
      if (!ids.length || !nextId || nextId === lastId) break;
      if (pages >= 100) throw Object.assign(new Error('商品同步翻页次数已达上限，请缩小同步范围后分批重试。'), { code: 'product_sync_page_limit_reached' });
      lastId = nextId;
      await checkpoint({ phase, lastId, runId });
    }
    lastId = '';
    await checkpoint({ phase: phases[phaseIndex + 1] || 'FINALIZE', lastId: '', runId });
  }
  const result = await finalize(runId, true);
  await checkpoint({ phase: 'DONE', lastId: '', runId });
  return { processed, ...result };
}

module.exports = { runProductSync };
