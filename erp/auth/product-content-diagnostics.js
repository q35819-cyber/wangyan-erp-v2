'use strict';
const crypto = require('node:crypto');
const ACTION = 'ai.product.content.diagnostic';
const MAX_RAW_BYTES = 256 * 1024;
const statusText = { rechecking: '正在核对（未调用模型）', recheck: '规则核对已完成（未调用模型）', accepted_with_warnings: '已保留，含待核对风险', requested: '请求中', received: '已收到，处理尚未完成', persisting: '校验完成，正在保存公共映射', accepted: '已采用', partial: '部分采用', rejected: '已拒绝', request_failed: '模型请求失败' };
function storageFailure() { return Object.assign(new Error('模型处理记录保存失败，未采用本次内容，请联系系统管理员。'), { publicCode: 'ai_content_diagnostic_failed', status: 503 }); }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|token|cookie|authorization|api.?key|buyer|customer|recipient|phone|email|address|密码|密钥|买家|收件|电话|地址/i.test(key)).map(([key, item]) => [key, redact(item)]));
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') { const safe = redact(parsed); if (JSON.stringify(safe) !== JSON.stringify(parsed)) return JSON.stringify(safe); } } catch (_) {}
    return value.replace(/(?:Bearer\s+)[A-Za-z0-9._~-]+/gi, 'Bearer [已脱敏]').replace(/((?:api[_-]?key|password|token|cookie|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[已脱敏]');
  }
  return value;
}
function createContentDiagnostics(authStore, privateObjectStore) {
  async function start(account, fields, rules, system, input, purpose, materialMatches = []) {
    if (!privateObjectStore.encryptionAvailable()) throw storageFailure();
    const context = { materialMatches: redact(materialMatches), purpose, diagnosticId: crypto.randomUUID(), account, fields, rules, system: redact(system), input: redact(input), rawResponse: null, rawComplete: purpose !== 'product-content-recheck', rawBytes: 0, provider: purpose === 'product-content-recheck' ? { callStatus: 'not_called' } : {}, startedAt: new Date().toISOString(), finishedAt: null, createdAt: new Date().toISOString(), saved: false };
    await record(context, purpose === 'product-content-recheck' ? 'rechecking' : 'requested');
    return context;
  }
  async function record(context, status, reasons = []) {
    const provider = { callStatus: context.provider.callStatus || (context.received ? 'called' : 'pending'), actualModel: String(context.provider.actualModel || '不可用'), protocol: String(context.provider.protocol || '不可用'), httpSucceeded: context.provider.httpSucceeded === true, httpStatus: Number(context.provider.httpStatus) || 0, providerRequestId: String(context.provider.providerRequestId || '不可用') };
    const detail = { results: context.results || [], materialMatches: context.materialMatches, purpose: context.purpose, startedAt: context.startedAt, finishedAt: context.finishedAt, provider, diagnosticId: context.diagnosticId, createdAt: context.createdAt, fields: context.fields, rules: context.rules, system: context.system, input: context.input, rawResponse: context.rawResponse, rawComplete: context.rawComplete, rawRedacted: context.rawRedacted === true, rawBytes: context.rawBytes, status, statusText: statusText[status], reasons };
    try {
      const body = Buffer.from(JSON.stringify(detail));
      const object = await privateObjectStore.putEncryptedBuffer({ tenantId: context.account.tenantId, kind: 'product_content_diagnostic', body });
      await authStore.writeAudit(authStore.pool, context.account, ACTION, 'product_content_diagnostic', context.diagnosticId, ['accepted', 'accepted_with_warnings', 'recheck', 'rechecking', 'received', 'requested'].includes(status) ? 'success' : 'failed', { materialMatches: context.materialMatches.map(row => ({ term: row.term, source: row.source, field: row.field, evidenceHash: crypto.createHash('sha256').update(row.evidence).digest('hex') })), requestId: context.diagnosticId, purpose: context.purpose, startedAt: context.startedAt, finishedAt: context.finishedAt, provider, fields: context.fields, rules: context.rules, status, statusText: detail.statusText, reasons, objectKey: object.objectKey, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: body.length, rawHash: context.rawHash || null, rawBytes: context.rawBytes, rawComplete: context.rawComplete });
      context.saved = true;
      return context.diagnosticId;
    } catch (_) { context.saved = false; throw storageFailure(); }
  }
  async function received(context, raw) {
    context.finishedAt = new Date().toISOString();
    const value = String(raw);
    context.rawBytes = Buffer.byteLength(value);
    context.rawHash = crypto.createHash('sha256').update(value).digest('hex');
    context.rawComplete = context.rawBytes <= MAX_RAW_BYTES;
    context.rawResponse = context.rawComplete ? redact(value) : null;
    context.rawRedacted = context.rawResponse !== null && context.rawResponse !== value;
    await record(context, 'received');
    context.received = true;
    if (!context.rawComplete) throw Object.assign(new Error('模型返回内容超过处理记录大小上限，未采用本次内容，请重新生成。'), { publicCode: 'ai_content_response_too_large', status: 422 });
  }
  async function list(account, requestId) {
    const result = await authStore.pool.query(`SELECT resource_id,metadata,created_at FROM audit_events WHERE tenant_id=$1 AND action=$2 AND ($3::boolean OR actor_user_id=$4 OR metadata->>'systemAdminActorUserId'=$4::text) AND ($5::text IS NULL OR resource_id=$5) ORDER BY id DESC LIMIT 100`, [account.tenantId, ACTION, account.isSystemAdmin === true, account.userId, requestId || null]);
    if (!requestId) {
      const seen = new Set();
      return { items: result.rows.filter(row => !seen.has(row.resource_id) && seen.add(row.resource_id)).map(row => ({ diagnosticId: row.resource_id, createdAt: row.created_at, fields: row.metadata.fields, status: row.metadata.status, statusText: row.metadata.statusText })) };
    }
    const row = result.rows[0];
    if (!row) throw Object.assign(new Error('未找到可查看的商品内容处理记录。'), { publicCode: 'ai_content_diagnostic_not_found', status: 404 });
    try {
      if (!String(row.metadata.objectKey).startsWith(String(account.tenantId) + '/product_content_diagnostic/')) throw Error('scope');
      const body = await privateObjectStore.readEncryptedBuffer(row.metadata.objectKey);
      if (body.length !== Number(row.metadata.bytes) || crypto.createHash('sha256').update(body).digest('hex') !== row.metadata.sha256) throw Error('integrity');
      return JSON.parse(body.toString('utf8'));
    } catch (_) { throw Object.assign(new Error('商品内容处理记录暂时无法读取，请联系系统管理员。'), { publicCode: 'ai_content_diagnostic_unavailable', status: 503 }); }
  }
  async function failed(context, error) {
    if (!context || error.publicCode === 'ai_content_diagnostic_failed') return error;
    context.finishedAt = context.finishedAt || new Date().toISOString();
    const timedOut = /timeout|timed.?out/i.test(String(error.publicCode || '') + ' ' + String(error.message || ''));
    const message = (context.received || context.purpose === 'product-content-recheck') && error.publicCode ? error.message : (timedOut ? '模型请求超时，未采用本次内容，请稍后重试。' : '模型请求失败，未采用本次内容，请稍后重试。');
    const code = (context.received || context.purpose === 'product-content-recheck') ? (error.publicCode || 'ai_content_parse_failed') : timedOut ? 'ai_content_request_timeout' : 'ai_content_request_failed';
    try {
      await record(context, context.purpose === 'product-content-recheck' ? 'recheck' : context.received ? 'rejected' : 'request_failed', [{ field: '', code, message }]);
      return Object.assign(new Error(message), { publicCode: code, status: error.status || 502, diagnosticId: context.diagnosticId });
    } catch (storageError) { return storageError; }
  }
  return { start, record, received, list, failed };
}
module.exports = { createContentDiagnostics, MAX_RAW_BYTES, redact };