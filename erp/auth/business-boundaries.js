'use strict';

const crypto = require('crypto');

const RELATIONAL_BUSINESS_KEYS = new Set([
  'erp_orders_data', 'erp_online_products',
  'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1',
  'erp_rate', 'erp_fee_manual', 'erp_bug_reports'
]);
const PLATFORM_KEYS = new Set(['erp_orders_data', 'erp_online_products', 'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1']);
const FINANCIAL_RECORD_KEYS = new Set(['erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1']);
const FINANCE_SETTING_KEYS = new Set(['erp_rate', 'erp_fee_manual']);
const SUPPLIER_URL_FIELDS = new Set(['srcUrl', 'sourceUrl', 'supplierUrl']);
const ORDER_SUPPLIER_URL_FIELDS = new Set([...SUPPLIER_URL_FIELDS, 'src']);
const SERVER_SOURCE_FIELDS = new Set(['platformSource', 'sourcePlatform', 'platformRecordId', 'sourceRecordId', 'platformSyncedAt', 'ozonEdit', 'editorDraft', '_syncRunId']);

function supplierHosts(value) {
  const configured = String(value || '1688.com,ozon.ru,ozon.by,ozon.kz').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set(configured)];
}

function validateSupplierUrl(value, allowedHosts) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch (error) { throw boundaryError('supplier_url_invalid', '货源链接格式不正确，请填写以 https:// 开头的完整网页地址。'); }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = (allowedHosts || []).some(host => hostname === host || hostname.endsWith('.' + host));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed) throw boundaryError('supplier_url_not_allowed', '货源链接不在允许的域名白名单内，请更换为1688等受信任货源地址。');
  parsed.hash = '';
  return parsed.toString();
}

function boundaryError(code, text) {
  const error = new Error(text || '服务端未给出中文提示，请按页面提示重试；仍未成功请联系管理员。');
  error.publicCode = code;
  return error;
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function scrubClientOwnedFields(value, allowedHosts, supplierUrlFields, nestedSupplierUrls, depth = 0) {
  if (Array.isArray(value)) return value.map(item => scrubClientOwnedFields(item, allowedHosts, supplierUrlFields, nestedSupplierUrls, depth));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (SERVER_SOURCE_FIELDS.has(key)) continue;
    if (supplierUrlFields.has(key) && (nestedSupplierUrls || depth === 0) && child != null && child !== '') {
      output[key] = validateSupplierUrl(child, allowedHosts);
    } else output[key] = scrubClientOwnedFields(child, allowedHosts, supplierUrlFields, nestedSupplierUrls, depth + 1);
  }
  return output;
}

function recordId(key, item, index) {
  const raw = key === 'erp_orders_data'
    ? item && (item.posting || item.posting_number || item.id)
    : key === 'erp_online_products'
      ? [item && (item.clientId || item.shopId || item.shop), item && (item.id || item.productId || item.sku || item.article || item.offer_id)].filter(Boolean).join('::')
      : item && (item.id || item.posting || item.posting_number || item.operation_id || item.sku);
  if (String(raw || '').trim()) return String(raw).trim().slice(0, 240);
  return 'row-' + index + '-' + crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24);
}

function normalizePlatformPayload(key, input, allowedHosts) {
  // Legacy order items use `src` for their supplier link. Ozon product/detail
  // payloads can also contain unrelated media objects named `src`; treating
  // every such value as a supplier URL makes a valid product refresh fail
  // before its transaction starts.
  const supplierUrlFields = key === 'erp_orders_data' ? ORDER_SUPPLIER_URL_FIELDS : SUPPLIER_URL_FIELDS;
  const cleaned = scrubClientOwnedFields(clone(input), allowedHosts, supplierUrlFields, key === 'erp_orders_data');
  if (!PLATFORM_KEYS.has(key)) return cleaned;
  const apply = (item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const platformRecordId = recordId(key, item, index);
    return { ...item, platformSource: 'ozon', platformRecordId };
  };
  if (Array.isArray(cleaned)) return cleaned.map(apply);
  if (cleaned && typeof cleaned === 'object') {
    const output = {};
    Object.entries(cleaned).forEach(([entryKey, value], index) => { output[entryKey] = apply(value, index); });
    return output;
  }
  return cleaned;
}

function rowsForPayload(key, payload) {
  if (Array.isArray(payload)) return { shape: 'array', rows: payload.map((item, index) => ({ recordKey: recordId(key, item, index), position: index, payload: item })) };
  if (payload && typeof payload === 'object') return { shape: 'object', rows: Object.entries(payload).map(([entryKey, item], index) => ({ recordKey: entryKey.slice(0, 240), position: index, payload: item })) };
  return { shape: 'scalar', rows: [{ recordKey: 'value', position: 0, payload }] };
}

function payloadFromRows(shape, rows) {
  if (shape === 'array') return rows.map(row => row.payload);
  if (shape === 'object') return Object.fromEntries(rows.map(row => [row.record_key || row.recordKey, row.payload]));
  return rows.length ? rows[0].payload : null;
}

module.exports = {
  RELATIONAL_BUSINESS_KEYS, FINANCIAL_RECORD_KEYS, FINANCE_SETTING_KEYS,
  supplierHosts, validateSupplierUrl, normalizePlatformPayload, rowsForPayload, payloadFromRows, recordId
};
