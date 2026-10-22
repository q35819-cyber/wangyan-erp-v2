'use strict';

const crypto = require('node:crypto');

const TTL_MS = 2 * 60 * 60 * 1000;
function digest(value) { return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value || '')).digest('hex'); }
function invalid(code = 'sku_image_result_reference_invalid', text) { return Object.assign(new Error(text || '图片结果数据异常，请重新生成图片后再试。'), { publicCode: code, retryable: false }); }

async function save(store, tenantId, taskId, providerTaskId, resultUrl, now = new Date()) {
  const url = String(resultUrl || '');
  if (!url || url.length > 8192) throw invalid('sku_image_result_reference_invalid', '图片结果地址缺失或过长，未能保存结果引用，请重新生成图片后再试。');
  const createdAt = now.toISOString(), expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
  const record = { version: 1, taskId: String(taskId), providerTaskId: String(providerTaskId || ''), createdAt, expiresAt, resultUrl: url };
  const body = Buffer.from(JSON.stringify(record), 'utf8');
  const stored = await store.putEncryptedBuffer({ tenantId, kind: 'sku_image_result_reference', body });
  return { version: 1, objectKey: stored.objectKey, sha256: stored.sha256, urlHash: digest(url), size: stored.size, createdAt, expiresAt };
}

async function read(store, taskId, providerTaskId, reference, now = new Date()) {
  if (!reference?.objectKey) throw invalid('sku_image_result_reference_invalid', '这条图片结果缺少存储位置记录，无法取回原图，请重新生成图片后再试。');
  const body = await store.readEncryptedBuffer(reference.objectKey);
  if (body.length !== Number(reference.size) || digest(body) !== String(reference.sha256)) throw invalid('sku_image_result_reference_invalid', '图片结果文件与记录校验不一致，为避免返回错误图片已停止读取，请重新生成图片。');
  let record;
  try { record = JSON.parse(body.toString('utf8')); } catch (_) { throw invalid('sku_image_result_reference_invalid', '图片结果内容无法解析，请重新生成图片后再试。'); }
  if (record.version !== 1 || record.taskId !== String(taskId) || record.providerTaskId !== String(providerTaskId || '') || typeof record.resultUrl !== 'string' || digest(record.resultUrl) !== String(reference.urlHash) || record.expiresAt !== reference.expiresAt) throw invalid('sku_image_result_reference_invalid', '图片结果与本次任务不匹配或记录已损坏，请重新发起一次图片生成。');
  if (new Date(record.expiresAt).getTime() <= now.getTime()) throw invalid('sku_image_result_reference_expired', '该图片结果的引用已经过期，请重新生成图片后再下载。');
  return record;
}

async function remove(store, reference) {
  if (reference?.objectKey && typeof store.deleteEncryptedBuffer === 'function') await store.deleteEncryptedBuffer(reference.objectKey);
}

module.exports = { save, read, remove, digest, TTL_MS };
