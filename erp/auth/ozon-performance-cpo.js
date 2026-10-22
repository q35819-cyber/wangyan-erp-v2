'use strict';

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api-performance.ozon.ru';
const MAX_REPORT_DAYS = 31;
const TOKEN_SKEW_MS = 60000;
const tokenCache = new Map();

function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
function text(value) { return String(value == null ? '' : value).trim(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function dateKeys(fromValue, toValue) {
  const from = new Date(String(fromValue || '') + 'T00:00:00Z');
  const to = new Date(String(toValue || '') + 'T00:00:00Z');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return [];
  const out = [];
  for (let cursor = new Date(from); cursor <= to; cursor = new Date(cursor.getTime() + 86400000)) out.push(cursor.toISOString().slice(0, 10));
  return out;
}
function chunks(dates, maximum = MAX_REPORT_DAYS) {
  const out = []; let current = [], previous = null;
  for (const date of dates) {
    const contiguous = !previous || new Date(date + 'T00:00:00Z').getTime() - new Date(previous + 'T00:00:00Z').getTime() === 86400000;
    if (!contiguous || current.length >= maximum) {
      if (current.length) out.push(current);
      current = [];
    }
    current.push(date);
    previous = date;
  }
  if (current.length) out.push(current);
  return out;
}
function credentialKey(clientId, clientSecret) {
  return text(clientId) + ':' + crypto.createHash('sha256').update(String(clientSecret || '')).digest('hex');
}
function publicError(code, message, status) {
  return Object.assign(new Error(message), { publicCode: code, status: status || 502 });
}
function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = text(value).replace(/\u00a0/g, ' ').replace(/[₽Рр]/g, '').replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes(',') && raw.includes('.')) {
    if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (raw.includes(',')) raw = raw.replace(',', '.');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseInteger(value) {
  const number = parseMoney(value);
  return number == null ? null : Math.trunc(number);
}
function normalizeHeader(value) {
  return text(value).toLowerCase().replace(/ё/g, 'е').replace(/[₽.(),:%"']/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitCsvLine(line, delimiter) {
  const cells = []; let value = '', quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  cells.push(value.trim());
  return cells;
}
function reportDate(value) {
  const raw = text(value);
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  match = raw.match(/^(\d{2})[.\/]([0-1]\d)[.\/](\d{4})/);
  return match ? match[3] + '-' + match[2] + '-' + match[1] : '';
}
function first(row, aliases) {
  const keys = Object.keys(row || {});
  for (const alias of aliases) {
    const exact = keys.find(key => normalizeHeader(key) === normalizeHeader(alias));
    if (exact) return row[exact];
  }
  return '';
}
function normalizeReportObject(row, source) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const orderNumber = text(first(row, ['номер заказа', 'заказ', 'order number', 'order_number', 'posting number', 'posting_number']));
  const orderId = text(first(row, ['id заказа', 'идентификатор заказа', 'order id', 'order_id']));
  const date = reportDate(first(row, ['дата', 'date', 'дата заказа', 'order date']));
  const expense = parseMoney(first(row, ['расход', 'расход с ндс', 'расход руб', 'expense', 'spend', 'cost']));
  if ((!orderNumber && !orderId) || expense == null) return null;
  const label = normalizeHeader(first(row, ['номер заказа', 'заказ', 'order number']));
  if (/всего|total/.test(label)) return null;
  return {
    date,
    orderId,
    orderNumber,
    sku: text(first(row, ['sku', 'ozon id', 'ozon_id'])),
    promotedSku: text(first(row, ['sku продвигаемого товара', 'sku рекламируемого товара', 'promoted sku', 'promoted_sku'])),
    offerId: text(first(row, ['артикул', 'offer id', 'offer_id', 'article'])),
    quantity: parseInteger(first(row, ['количество', 'кол во', 'quantity'])) || 0,
    orderAmountRub: parseMoney(first(row, ['стоимость', 'стоимость продажи', 'сумма заказа', 'order amount', 'amount'])),
    bidPercent: parseMoney(first(row, ['ставка', 'ставка %', 'bid percent'])),
    expenseRub: round(Math.abs(expense)),
    source
  };
}
function parseCsvReport(raw, source) {
  const lines = String(raw || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  let headerIndex = -1, delimiter = ';', headers = [];
  for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
    const candidateDelimiter = (lines[index].match(/;/g) || []).length >= (lines[index].match(/,/g) || []).length ? ';' : ',';
    const cells = splitCsvLine(lines[index], candidateDelimiter);
    const normalized = cells.map(normalizeHeader);
    if (normalized.some(value => /номер заказа|order number/.test(value)) && normalized.some(value => /расход|expense|spend/.test(value))) {
      headerIndex = index; delimiter = candidateDelimiter; headers = cells; break;
    }
  }
  if (headerIndex < 0) return [];
  const rows = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index], delimiter);
    if (cells.length < 2) continue;
    const object = {};
    headers.forEach((header, cellIndex) => { object[header] = cells[cellIndex] == null ? '' : cells[cellIndex]; });
    const normalized = normalizeReportObject(object, source);
    if (normalized) rows.push(normalized);
  }
  return rows;
}
function collectObjects(value, out) {
  if (Array.isArray(value)) {
    value.forEach(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item);
      collectObjects(item, out);
    });
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectObjects(item, out));
  }
}
function parseReport(raw, contentType, source) {
  const body = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw == null ? '' : raw);
  if (/json/i.test(String(contentType || '')) || /^[\s\uFEFF]*[\[{]/.test(body)) {
    try {
      const parsed = JSON.parse(body.replace(/^\uFEFF/, ''));
      const objects = []; collectObjects(parsed, objects);
      const rows = objects.map(row => normalizeReportObject(row, source)).filter(Boolean);
      if (rows.length) return rows;
    } catch (_) { /* fall through to CSV */ }
  }
  return parseCsvReport(body, source);
}
function dedupeRows(rows) {
  const map = new Map();
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const key = [row.date,row.orderId,row.orderNumber,row.sku,row.promotedSku,row.offerId,row.quantity,row.expenseRub].join('|');
    if (!map.has(key)) map.set(key, row);
  });
  return [...map.values()];
}
function rowAmount(rows) { return round((rows || []).reduce((sum, row) => sum + (Number(row.expenseRub) || 0), 0)); }

function countChunks(values, maximum = 100) {
  const out = [];
  for (let index = 0; index < values.length; index += maximum) out.push(values.slice(index, index + maximum));
  return out;
}
function exactSellerPostingMatches(row, postings) {
  const orderId = text(row && row.orderId), orderNumber = text(row && row.orderNumber);
  let candidates = (Array.isArray(postings) ? postings : []).filter(posting => {
    const idMatch = orderId && text(posting && posting.order_id) === orderId;
    const numberMatch = orderNumber && text(posting && posting.order_number) === orderNumber;
    return idMatch || numberMatch;
  });
  if (candidates.length <= 1) return candidates;
  const skuSet = new Set([text(row && row.sku), text(row && row.promotedSku)].filter(Boolean));
  const offerId = text(row && row.offerId);
  const productMatched = candidates.filter(posting => (Array.isArray(posting && posting.products) ? posting.products : []).some(product => {
    const sku = text(product && (product.sku ?? product.product_id));
    const offer = text(product && (product.offer_id ?? product.product_offer_id));
    return (sku && skuSet.has(sku)) || (offerId && offer === offerId);
  }));
  return productMatched.length ? productMatched : candidates;
}
async function resolveSellerPostings(requestSeller, rows, input = {}) {
  if (typeof requestSeller !== 'function') throw publicError('performance_seller_request_invalid', 'Ozon订单身份核对接口未正确初始化。');
  const from = text(input.from), to = text(input.to);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const orderNumbers = [...new Set(sourceRows.map(row => text(row && row.orderNumber)).filter(Boolean))];
  const postings = [];
  for (const batch of countChunks(orderNumbers, 100)) {
    let cursor = '', guard = 0;
    do {
      const payload = await requestSeller('/v4/posting/fbs/list', {
        sort_dir: 'asc',
        filter: { order_numbers: batch, since: from + 'T00:00:00Z', to: to + 'T23:59:59Z' },
        limit: 100,
        cursor,
        with: { analytics_data: false, barcodes: false, financial_data: false, legal_info: false, translit: false }
      });
      postings.push(...(Array.isArray(payload && payload.postings) ? payload.postings : []));
      cursor = payload && payload.has_next === true ? text(payload.cursor) : '';
      guard += 1;
      if (guard > 100) throw publicError('performance_seller_posting_page_limit', 'Ozon订单身份核对分页超过安全上限，请缩小统计日期范围后重试。');
    } while (cursor);
  }

  let unresolved = sourceRows.filter(row => exactSellerPostingMatches(row, postings).length !== 1);
  if (unresolved.length) {
    let cursor = '', guard = 0;
    do {
      const payload = await requestSeller('/v3/posting/fbo/list', {
        sort_dir: 'ASC',
        filter: { since: from + 'T00:00:00Z', to: to + 'T23:59:59Z' },
        limit: 100,
        cursor,
        translit: false,
        with: { analytics_data: false, financial_data: false, legal_info: false }
      });
      postings.push(...(Array.isArray(payload && payload.postings) ? payload.postings : []));
      cursor = payload && payload.has_next === true ? text(payload.cursor) : '';
      guard += 1;
      if (guard > 100) throw publicError('performance_seller_fbo_page_limit', 'Ozon FBO订单身份核对分页超过安全上限，请缩小统计日期范围后重试。');
    } while (cursor);
    unresolved = unresolved.filter(row => exactSellerPostingMatches(row, postings).length !== 1);
  }

  const matchedRows = [], unmatchedRows = [];
  sourceRows.forEach(row => {
    const candidates = exactSellerPostingMatches(row, postings);
    if (candidates.length !== 1 || !text(candidates[0].posting_number)) {
      unmatchedRows.push(row);
      return;
    }
    matchedRows.push({
      ...row,
      matchedPosting: text(candidates[0].posting_number),
      sellerOrderId: text(candidates[0].order_id),
      sellerOrderNumber: text(candidates[0].order_number)
    });
  });
  return { matchedRows, unmatchedRows, postings };
}

function createClient(credentials, options = {}) {
  const clientId = text(credentials && credentials.clientId);
  const clientSecret = text(credentials && credentials.clientSecret);
  if (!clientId || !clientSecret) throw publicError('performance_credentials_not_configured', '该店铺尚未配置广告费接口 Client ID / Client Secret，请先在店铺列表编辑店铺。', 409);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw publicError('performance_fetch_unavailable', '服务器当前无法访问 Ozon Performance API，请联系系统管理员检查运行环境。');
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const pollIntervalMs = Number(options.pollIntervalMs) >= 0 ? Number(options.pollIntervalMs) : 1000;
  const pollLimit = Math.max(1, Number(options.pollLimit) || 90);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 45000);
  const cacheKey = credentialKey(clientId, clientSecret);

  async function rawRequest(method, endpoint, body, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (body != null) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetchImpl(baseUrl + endpoint, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal });
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!response.ok) {
        let message = '';
        try { const parsed = JSON.parse(buffer.toString('utf8')); message = text(parsed.message || parsed.error || parsed.details); } catch (_) {}
        const error = publicError(response.status === 401 ? 'performance_unauthorized' : 'performance_request_failed',
          message || 'Ozon 广告费接口请求失败，请检查 Performance API 密钥及接口权限。', response.status);
        error.externalMessage = message; error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return { buffer, contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      if (error && error.name === 'AbortError') throw publicError('performance_request_timeout', 'Ozon 广告费接口请求超时，请稍后重试。', 504);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function accessToken(force) {
    const cached = !force && tokenCache.get(cacheKey);
    if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.token;
    const response = await rawRequest('POST', '/api/client/token', { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' }, '');
    let payload;
    try { payload = JSON.parse(response.buffer.toString('utf8')); }
    catch (_) { throw publicError('performance_token_invalid', 'Ozon 广告费接口返回了无法识别的授权结果，请稍后重试。'); }
    const token = text(payload && payload.access_token), expiresIn = Number(payload && payload.expires_in);
    if (!token) throw publicError('performance_token_missing', 'Ozon 广告费接口没有返回授权 Token，请检查 Performance API 密钥。', 401);
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 25 * 60 * 1000) });
    return token;
  }

  async function authorized(method, endpoint, body, retried) {
    let token = await accessToken(false);
    try { return await rawRequest(method, endpoint, body, token); }
    catch (error) {
      if (!retried && error && error.status === 401) {
        tokenCache.delete(cacheKey); token = await accessToken(true);
        return rawRequest(method, endpoint, body, token);
      }
      throw error;
    }
  }
  async function json(method, endpoint, body) {
    const response = await authorized(method, endpoint, body, false);
    try { return JSON.parse(response.buffer.toString('utf8')); }
    catch (_) { throw publicError('performance_json_invalid', 'Ozon 广告费接口返回了无法识别的数据，请稍后重试。'); }
  }
  async function waitAndDownload(uuid, source) {
    let status = null;
    for (let attempt = 0; attempt < pollLimit; attempt += 1) {
      status = await json('GET', '/api/client/statistics/' + encodeURIComponent(uuid), null);
      const state = text(status && status.state).toUpperCase();
      if (state === 'OK') break;
      if (state === 'ERROR') throw publicError('performance_report_failed', 'Ozon 按订单付费报告生成失败：' + text(status && status.error || '平台未返回具体原因'));
      if (!['NOT_STARTED','IN_PROGRESS',''].includes(state)) throw publicError('performance_report_state_invalid', 'Ozon 按订单付费报告状态无法识别，请稍后重试。');
      if (attempt + 1 < pollLimit) await sleep(pollIntervalMs);
    }
    if (!status || text(status.state).toUpperCase() !== 'OK') throw publicError('performance_report_timeout', 'Ozon 按订单付费报告生成超时，请稍后重试。', 504);
    const response = await authorized('GET', '/api/client/statistics/report?UUID=' + encodeURIComponent(uuid), null, false);
    return parseReport(response.buffer, response.contentType, source);
  }
  async function generateSelected(from, to) {
    const payload = await json('POST', '/api/client/statistic/orders/generate', { from, to });
    const uuid = text(payload && (payload.UUID || payload.uuid));
    if (!uuid) throw publicError('performance_report_uuid_missing', 'Ozon 没有返回按订单付费报告编号，请稍后重试。');
    return waitAndDownload(uuid, 'selected_cpo');
  }
  async function generateAllSku(from, to) {
    const endpoint = '/api/client/statistics/all_sku_promo/orders/generate?timeBounds.from=' + encodeURIComponent(from) + '&timeBounds.to=' + encodeURIComponent(to);
    const payload = await json('GET', endpoint, null);
    const uuid = text(payload && (payload.UUID || payload.uuid));
    if (!uuid) throw publicError('performance_report_uuid_missing', 'Ozon 没有返回全商品按订单付费报告编号，请稍后重试。');
    return waitAndDownload(uuid, 'all_sku_cpo');
  }
  async function fetchChunk(fromDate, toDate) {
    const from = fromDate + 'T00:00:00Z', to = toDate + 'T23:59:59Z';
    const selected = await generateSelected(from, to);
    const allSku = await generateAllSku(from, to);
    return dedupeRows(selected.concat(allSku));
  }
  return { accessToken, fetchChunk };
}

async function fetchRangeCached(client, input = {}) {
  if (!client || typeof client.fetchChunk !== 'function') throw publicError('performance_client_invalid', '广告费接口客户端未正确初始化。');
  const dates = dateKeys(input.from, input.to);
  if (!dates.length) throw publicError('performance_range_invalid', '按订单付费统计日期不正确，请重新选择日期。', 400);
  if (dates.length > 93) throw publicError('performance_range_too_large', '按订单付费一次最多同步93天，请缩小日期范围后重试。', 400);
  const sourceDays = input.cachedDays && typeof input.cachedDays === 'object' ? input.cachedDays : {};
  const days = {};
  dates.forEach(date => {
    const cached = sourceDays[date];
    if (input.force !== true && cached && cached.date === date && Array.isArray(cached.rows)) days[date] = cached;
  });
  const missingDates = input.force === true ? dates.slice() : dates.filter(date => !days[date]);
  const unresolvedRows = [];
  for (const group of chunks(missingDates)) {
    if (!group.length) continue;
    const rows = await client.fetchChunk(group[0], group[group.length - 1]);
    group.forEach(date => { days[date] = { date, fetchedAt: new Date().toISOString(), rows: [] }; });
    rows.forEach(row => {
      if (row.date && days[row.date]) days[row.date].rows.push(row);
      else unresolvedRows.push(row);
    });
  }
  const rows = dedupeRows(dates.flatMap(date => days[date] && Array.isArray(days[date].rows) ? days[date].rows : []));
  return { days, rows, unresolvedRows, amountRub: rowAmount(rows), fetchedDates: missingDates, cachedDates: dates.filter(date => !missingDates.includes(date)) };
}

module.exports = {
  DEFAULT_BASE_URL, MAX_REPORT_DAYS, dateKeys, parseMoney, parseCsvReport, parseReport,
  normalizeReportObject, dedupeRows, rowAmount, exactSellerPostingMatches, resolveSellerPostings, createClient, fetchRangeCached
};
