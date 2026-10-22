'use strict';

const crypto = require('node:crypto');

const TYPES = new Set(['template', 'selling_points', 'raw_response', 'final_prompt']);
function digest(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value || '')).digest('hex'); }
function invalid() { return Object.assign(new Error('提示词快照数据不完整，请重新整理一次卖点后再生成。'), { publicCode: 'sku_image_prompt_snapshot_invalid', retryable: false }); }

async function save(store, tenantId, taskId, type, content, now = new Date()) {
  if (!TYPES.has(type) || !String(content || '')) throw invalid();
  const createdAt = now.toISOString();
  const record = { version: 1, taskId: String(taskId), type, createdAt, content: String(content) };
  const body = Buffer.from(JSON.stringify(record), 'utf8');
  const stored = await store.putEncryptedBuffer({ tenantId, kind: 'sku_image_prompt_snapshot', body });
  return { version: 1, type, objectKey: stored.objectKey, sha256: stored.sha256, contentHash: digest(record.content), size: stored.size, chars: record.content.length, createdAt };
}

async function read(store, taskId, expectedType, reference) {
  if (!reference || reference.type !== expectedType || !TYPES.has(expectedType)) throw invalid();
  const body = await store.readEncryptedBuffer(reference.objectKey);
  if (body.length !== Number(reference.size) || digest(body) !== String(reference.sha256)) throw invalid();
  let record;
  try { record = JSON.parse(body.toString('utf8')); } catch (_) { throw invalid(); }
  if (record.version !== 1 || record.taskId !== String(taskId) || record.type !== expectedType || typeof record.content !== 'string' || digest(record.content) !== String(reference.contentHash) || record.content.length !== Number(reference.chars)) throw invalid();
  return record;
}

module.exports = { save, read, digest, TYPES };
