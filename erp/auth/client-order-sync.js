'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 'client-orders-v1';
const ORDER_CONTRACT_VERSION = 'seller-orders-v2';
const MAX_BATCH_ORDERS = 100;
const MAX_BATCH_BYTES = 1024 * 1024;
const DEVICE_LEASE_MS = 8 * 60 * 1000;
const RUN_LEASE_MS = 8 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MANUAL_WINDOW_MS = 28 * DAY_MS;
const MAX_MANUAL_RANGE_MS = 365 * DAY_MS;

function publicError(code, status = 400, message = '订单同步数据校验失败，请检查后重试。') {
  return Object.assign(new Error(message), { publicCode: code, status });
}

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(String(value)).digest(encoding);
}

function manifestHashForBatches(batches) {
  if (!Array.isArray(batches)) throw publicError('client_sync_manifest_invalid', 400, '订单同步清单格式不正确，未保存本批次。');
  return sha256(canonicalize(batches.map(orders => sha256(canonicalize(orders)))));
}

function safeUuid(value, code = 'client_sync_identity_invalid', message = '订单同步设备标识格式不正确，请重新登记设备。') {
  const text = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)) throw publicError(code, 400, message);
  return text;
}

function safeClientId(value) {
  const text = String(value || '').trim();
  if (!/^[1-9]\d{2,19}$/.test(text)) throw publicError('client_sync_shop_invalid', 400, '订单同步店铺标识不正确，请重新选择店铺。');
  return text;
}

function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalize(value[key])).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw publicError('client_sync_number_invalid', 400, '订单同步数据包含无效数字，未保存本批次。');
  return JSON.stringify(value);
}

function normalizeMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw publicError('client_sync_money_invalid', 400, '订单金额格式不正确，未保存本批次。');
  const text = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw publicError('client_sync_money_invalid', 400, '订单金额格式不正确，未保存本批次。');
  return text.replace(/^\+/, '');
}

function normalizeWhdPricing(order) {
  const invalidPrice = () => publicError('client_sync_seller_whd_cny_price_invalid', 400, '转售单人民币成交价或币种无效，未保存本批次。');
  if (!Array.isArray(order.items) || !order.items.length) throw invalidPrice('items_missing');
  let total = 0;
  order.items = order.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidPrice('item_' + index + '_invalid');
    const price = normalizeMoney(item.price);
    const quantity = Number(item.qty == null ? 1 : item.qty);
    if (price === null || !Number.isFinite(Number(price)) || Number(price) < 0) throw invalidPrice('item_' + index + '_amount');
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw invalidPrice('item_' + index + '_quantity');
    if (String(item.priceCurrency || '').toUpperCase() !== 'CNY') throw invalidPrice('item_' + index + '_currency');
    if (item.priceSource !== 'seller_fbo_posting_list_products_price') throw invalidPrice('item_' + index + '_source');
    total += Number(price) * quantity;
    const normalized = { ...item, price, priceCurrency: 'CNY', priceSource: 'seller_fbo_posting_list_products_price' };
    for (const key of ['customerPrice', 'customerCurrency', 'customerPriceSource', 'listingPrice', 'highestPrice']) delete normalized[key];
    return normalized;
  });
  const cnyTotal = normalizeMoney(order.finance && order.finance.cnyTotal);
  if (cnyTotal === null || !Number.isFinite(Number(cnyTotal)) || Number(cnyTotal) < 0
    || order.finance.cnyTotalSource !== 'seller_fbo_posting_list_products_price'
    || Math.abs(Number(cnyTotal) - total) > 0.000001) throw publicError('client_sync_seller_whd_cny_total_invalid', 400, '转售单人民币商品合计与订单金额不一致，未保存本批次。');
  order.finance.cnyTotal = cnyTotal;
  order.finance.cnyTotalSource = 'seller_fbo_posting_list_products_price';
}

function normalizeSellerInfo(value, sellerId, deliverySchema) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || String(value.id || '') !== sellerId || !['seller_warehouse_details', 'seller_company_finance_info'].includes(value.source)) throw publicError('client_sync_seller_info_invalid', 400, '卖家信息格式不正确，未保存本批次。');
  const company = value.company;
  if (!company || typeof company !== 'object' || Array.isArray(company) || String(company.id || '') !== sellerId || company.source !== 'seller_company_finance_info') throw publicError('client_sync_seller_company_invalid', 400, '卖家公司资料与订单不一致，未保存本批次。');
  if (deliverySchema === 'WHD') {
    const fulfillment = value.fulfillment;
    if (!fulfillment || typeof fulfillment !== 'object' || Array.isArray(fulfillment) || fulfillment.deliverySchema !== 'WHD' || fulfillment.source !== 'seller_fbo_posting_details') throw publicError('client_sync_seller_whd_fulfillment_invalid', 400, '转售单履约信息不完整，未保存本批次。');
  } else {
    const warehouse = value.warehouse;
    const warehouseId = String(value.warehouseId || '').trim();
    if (!/^[1-9]\d{2,19}$/.test(warehouseId) || !warehouse || typeof warehouse !== 'object' || Array.isArray(warehouse) || String(warehouse.id || '') !== warehouseId || String(warehouse.sellerId || '') !== sellerId || warehouse.source !== 'seller_warehouse_details') throw publicError('client_sync_seller_warehouse_invalid', 400, '订单仓库与卖家仓库资料不一致，未保存本批次。');
    const address = value.address;
    if (!address || typeof address !== 'object' || Array.isArray(address) || !['country', 'region', 'city', 'street', 'house', 'building', 'zipcode', 'address'].some(key => String(address[key] || '').trim())) throw publicError('client_sync_seller_address_missing', 400, '卖家仓库缺少发货地址，未保存本批次。');
    if (canonicalize(address) !== canonicalize(warehouse.address)) throw publicError('client_sync_seller_address_mismatch', 400, '订单发货地址与仓库资料不一致，未保存本批次。');
  }
  const inspect = (item, depth = 0) => {
    if (!item || typeof item !== 'object') return;
    if (depth > 8) throw publicError('client_sync_seller_info_invalid', 400, '卖家信息格式不正确，未保存本批次。');
    for (const [key, child] of Object.entries(item)) {
      if (/cookie|token|secret|authorization|credential|session|fingerprint/i.test(key)) throw publicError('client_sync_seller_sensitive_field_forbidden', 400, '卖家资料包含禁止保存的凭据字段，未保存本批次。');
      inspect(child, depth + 1);
    }
  };
  inspect(value);
  return value;
}

function normalizeOrder(order, clientId) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw publicError('client_sync_order_invalid', 400, '订单数据格式不正确，未保存本批次。');
  const posting = String(order.posting || order.posting_number || '').trim();
  if (!posting || posting.length > 180) throw publicError('client_sync_posting_invalid', 400, '订单货件号缺失或过长，未保存本批次。');
  const sellerId = String(order.sellerId || '').trim();
  if (!/^[1-9]\d{2,19}$/.test(sellerId)) throw publicError('client_sync_seller_id_missing', 400, '订单缺少卖家标识，未保存本批次。');
  if (sellerId !== clientId) throw publicError('client_sync_seller_id_mismatch', 403, '订单卖家与授权店铺不一致，未保存本批次。');
  const sellerIdSource = String(order.sellerIdSource || '').trim();
  if (!['seller_posting_list', 'seller_posting_details', 'seller_fbo_posting_list'].includes(sellerIdSource)) throw publicError('client_sync_seller_id_source_invalid', 400, '订单卖家标识来源无效，未保存本批次。');
  const deliverySchema = String(order.deliverySchema || '').trim().toUpperCase();
  const seller = normalizeSellerInfo(order.seller, sellerId, deliverySchema);
  const buyer = order.buyer;
  if (buyer !== null && buyer !== undefined) {
    if (typeof buyer !== 'object' || Array.isArray(buyer) || buyer.source !== 'seller_posting_details') throw publicError('client_sync_buyer_invalid', 400, '订单买家信息格式不正确，未保存本批次。');
    const buyerId = String(buyer.id || '').trim();
    const isProvided = /^[1-9]\d{0,30}$/.test(buyerId) && buyer.idStatus === 'provided' && buyer.idSource === 'seller_posting_details';
    const unavailableSource = String(buyer.idSource || '');
    const unavailableReason = String(buyer.idReason || '');
    const isUnavailable = !buyerId && buyer.idStatus === 'unavailable'
      && ((unavailableSource === 'seller_posting_details_customer_id_zero' && unavailableReason === 'zero')
        || (unavailableSource === 'seller_posting_details_customer_id_not_returned' && unavailableReason === 'not_returned'));
    if (!isProvided && !isUnavailable) throw publicError('client_sync_buyer_id_invalid', 400, '订单买家标识无效，未保存本批次。');
    if (deliverySchema === 'WHD' && (!['natural_person', 'legal_entity'].includes(String(buyer.typeCode || ''))
      || buyer.typeSource !== 'seller_fbo_posting_details_is_legal')) throw publicError('client_sync_buyer_type_invalid', 400, '订单买家类型来源无效，未保存本批次。');
  }
  if (deliverySchema === 'WHD') {
    const participants = order.deliveryParticipants;
    if (!Array.isArray(participants) || participants.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || !/^[a-z0-9_-]{1,40}$/.test(String(item.type || '')) || !String(item.name || '').trim()
      || !/^\d{5,20}$/.test(String(item.inn || '')) || item.source !== 'seller_fbo_posting_details_delivery_agents')) {
      throw publicError('client_sync_seller_whd_delivery_agent_invalid', 400, '转售单配送参与方资料不完整，未保存本批次。');
    }
  }
  const next = { ...order, clientId, sellerId, sellerIdSource, seller, posting };
  delete next.posting_number;
  if (next.finance && typeof next.finance === 'object' && !Array.isArray(next.finance)) {
    next.finance = { ...next.finance };
    for (const key of ['listingAmount', 'listingCurrency', 'listingAmountSource']) delete next.finance[key];
  }
  if (deliverySchema === 'WHD') normalizeWhdPricing(next);
  for (const key of ['price', 'amount', 'orderAmount', 'orderAmountRub', 'estimatedRevenueRub']) {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = normalizeMoney(next[key]);
  }
  return next;
}

function normalizeBatch(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const runId = safeUuid(source.runId, 'client_sync_run_invalid', '订单同步任务标识格式不正确，请重新发起同步。');
  const installationId = safeUuid(source.installationId);
  const clientId = safeClientId(source.clientId);
  const backupGenerationId = Number(source.backupGenerationId);
  if (!Number.isSafeInteger(backupGenerationId) || backupGenerationId < 1) throw publicError('client_sync_backup_generation_invalid', 400, '订单同步备份代次无效，本批次未入库。');
  const batchId = String(source.batchId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(batchId)) throw publicError('client_sync_batch_id_invalid', 400, '订单同步批次编号无效，本批次未入库。');
  const sequenceNo = Number(source.sequenceNo);
  if (!Number.isSafeInteger(sequenceNo) || sequenceNo < 0 || sequenceNo > 100000) throw publicError('client_sync_batch_sequence_invalid', 400, '订单同步批次顺序无效，本批次未入库。');
  if (!Array.isArray(source.orders) || !source.orders.length || source.orders.length > MAX_BATCH_ORDERS) throw publicError('client_sync_batch_count_invalid', 400, '订单同步批次数量不正确，本批次未入库。');
  const orders = source.orders.map(order => normalizeOrder(order, clientId));
  const payloadText = canonicalize(orders);
  const bodyBytes = Buffer.byteLength(payloadText, 'utf8');
  if (bodyBytes > MAX_BATCH_BYTES) throw publicError('client_sync_batch_too_large', 413, '订单同步批次超过大小上限，请缩小批次后重试。');
  return { runId, installationId, clientId, backupGenerationId, batchId, sequenceNo, orders, bodyBytes, bodySha256: sha256(payloadText) };
}

function normalizeManifest(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if ('orders' in source || 'payload' in source || 'items' in source) throw publicError('client_sync_manifest_content_forbidden', 400, '订单同步清单包含不允许提交的订单内容，本批次未入库。');
  const runId = safeUuid(source.runId, 'client_sync_run_invalid', '订单同步任务标识格式不正确，请重新发起同步。');
  const installationId = safeUuid(source.installationId);
  const clientId = safeClientId(source.clientId);
  const orderCount = Number(source.orderCount);
  const batchCount = Number(source.batchCount);
  const contentSha256 = String(source.contentSha256 || '').toLowerCase();
  if (!Number.isSafeInteger(orderCount) || orderCount < 0 || orderCount > 1000000 || !Number.isSafeInteger(batchCount) || batchCount < 0 || batchCount > 10000 || !/^[a-f0-9]{64}$/.test(contentSha256)) throw publicError('client_sync_manifest_invalid', 400, '订单同步清单格式不正确，未保存本批次。');
  return { runId, installationId, clientId, orderCount, batchCount, contentSha256 };
}

function createUploadTicket() {
  const ticket = crypto.randomBytes(32).toString('base64url');
  return { ticket, ticketHash: Buffer.from(sha256(ticket), 'hex') };
}

function verifyUploadTicket(ticket, expectedHash) {
  const actual = Buffer.from(sha256(String(ticket || '')), 'hex');
  const expected = Buffer.isBuffer(expectedHash) ? expectedHash : Buffer.from(expectedHash || []);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function rangeFor(mode, now = new Date()) {
  const end = new Date(now);
  if (Number.isNaN(end.getTime())) throw publicError('client_sync_time_invalid', 400, '订单同步时间无效，请重新选择时间范围。');
  if (mode === 'auto_daily' || mode === 'manual_all') return { start: new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000), end };
  if (mode === 'auto_new') return { start: new Date(end.getTime() - 135 * 60 * 1000), end };
  return { start: null, end };
}

function manualRange(input = {}, now = new Date()) {
  if (!input.rangeStart && !input.rangeEnd) return rangeFor('manual_all', now);
  if (!input.rangeStart || !input.rangeEnd) throw publicError('order_sync_range_invalid', 400, '订单同步时间范围无效，请重新选择。');
  const start = new Date(input.rangeStart), requestedEnd = new Date(input.rangeEnd), current = new Date(now);
  if ([start, requestedEnd, current].some(value => Number.isNaN(value.getTime()))) throw publicError('order_sync_range_invalid', 400, '订单同步时间范围无效，请重新选择。');
  const end = requestedEnd > current ? current : requestedEnd;
  if (start >= end || end.getTime() - start.getTime() > MAX_MANUAL_RANGE_MS) throw publicError('order_sync_range_invalid', 400, '订单同步时间范围无效，请重新选择。');
  return { start, end };
}

function windowCountForRange(start, end) {
  const range = manualRange({ rangeStart: start, rangeEnd: end }, end);
  return Math.max(1, Math.ceil((range.end.getTime() - range.start.getTime()) / MANUAL_WINDOW_MS));
}

function runLeaseMs(mode, start, end) {
  if (mode !== 'manual_all') return RUN_LEASE_MS;
  return Math.min(60 * 60 * 1000, Math.max(RUN_LEASE_MS, windowCountForRange(start, end) * 3 * 60 * 1000));
}

module.exports = {
  SCHEMA_VERSION, ORDER_CONTRACT_VERSION, MAX_BATCH_ORDERS, MAX_BATCH_BYTES,
  DEVICE_LEASE_MS, RUN_LEASE_MS, DAY_MS, MANUAL_WINDOW_MS, MAX_MANUAL_RANGE_MS, canonicalize, normalizeMoney, normalizeOrder,
  normalizeBatch, normalizeManifest, createUploadTicket, verifyUploadTicket,
  safeUuid, safeClientId, rangeFor, manualRange, windowCountForRange, runLeaseMs, publicError, sha256, manifestHashForBatches
};
