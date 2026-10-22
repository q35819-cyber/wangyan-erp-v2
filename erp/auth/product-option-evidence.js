'use strict';
const crypto = require('node:crypto');
function createOptionEvidence({ now = Date.now, maxEntries = 20000, ttlMs = 10 * 60 * 1000 } = {}) {
  const entries = new Map();
  function expire() { for (const [key, row] of entries) { if (row.expiresAt > now()) break; entries.delete(key); } }
  function attach(payload, account, shop, request) {
    if (!['RU', 'DEFAULT', ''].includes(String(request.language || '').toUpperCase()) || !Array.isArray(payload && payload.result)) return payload;
    if (![request.description_category_id, request.type_id, request.attribute_id].every(value => /^[1-9]\d*$/.test(String(value)))) return payload;
    expire();
    for (const item of payload.result) {
      if (!item || !/^[1-9]\d*$/.test(String(item.id)) || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 100) continue;
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      const token = crypto.randomBytes(24).toString('hex');
      entries.set(token, { tenantId: String(account.tenantId), userId: String(account.userId), shop: String(shop), categoryId: String(request.description_category_id), typeId: String(request.type_id), attributeId: String(request.attribute_id), valueId: String(item.id), raw: item.value, expiresAt: now() + ttlMs });
      item.evidenceToken = token;
    }
    return payload;
  }
  function verify(values, account) {
    const invalid = () => Object.assign(new Error('属性选项来源已失效或不匹配，请重新读取平台字典后再试；公共映射未更新。'), { publicCode: 'option_source_invalid', status: 409 });
    if (!Array.isArray(values) || !values.length || values.length > 100) throw invalid();
    expire();
    const verified = new Map();
    for (const item of values) {
      if (!item || typeof item.text !== 'string' || typeof item.evidenceToken !== 'string' || Object.keys(item).some(key => !['text', 'evidenceToken'].includes(key))) throw invalid();
      const row = entries.get(item.evidenceToken);
      if (!row || row.expiresAt <= now() || row.tenantId !== String(account.tenantId) || row.userId !== String(account.userId) || row.raw !== item.text) throw invalid();
      if (!verified.has(row.raw)) verified.set(row.raw, { ...row });
    }
    return [...verified.values()];
  }
  function find(account, shop, request, valueId) {
    expire();
    for (const row of entries.values()) if (row.expiresAt > now() && row.tenantId === String(account.tenantId) && row.userId === String(account.userId) && row.shop === String(shop) && row.categoryId === String(request.description_category_id) && row.typeId === String(request.type_id) && row.attributeId === String(request.attribute_id) && row.valueId === String(valueId)) return row.raw;
    return undefined;
  }
  return { attach, verify, find };
}
module.exports = { createOptionEvidence };
