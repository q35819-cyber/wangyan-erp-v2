'use strict';

const crypto = require('crypto');
const SECRET_FIELDS = ['apiKey', 'apiSecret', 'secret', 'token', 'performanceClientSecret'];
const JSON_SECRET_FIELDS = ['sellerCookies'];

function parseCredentialKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let key = null;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else {
    try { key = Buffer.from(raw, 'base64'); } catch (error) { key = null; }
  }
  if (!key || key.length !== 32) {
    throw new Error('ERP_CREDENTIALS_KEY must be a 32-byte key encoded as 64 hex characters or base64');
  }
  return key;
}

function isEnvelope(value) {
  return Boolean(value && typeof value === 'object' && value.__wyerpSecret === 1 && value.algorithm === 'aes-256-gcm');
}

function hasPlaintextShopCredentials(payload) {
  return Array.isArray(payload) && payload.some(item => item && typeof item === 'object' && (
    SECRET_FIELDS.some(field => typeof item[field] === 'string' && item[field].length > 0) ||
    JSON_SECRET_FIELDS.some(field => Array.isArray(item[field]) && item[field].length > 0)
  ));
}

function encryptValue(value, key, context) {
  if (isEnvelope(value)) return value;
  const text = String(value == null ? '' : value);
  if (!text) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    __wyerpSecret: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptValue(value, key, context) {
  if (!isEnvelope(value)) return value;
  if (!key) throw new Error('Encrypted credential cannot be read without ERP_CREDENTIALS_KEY');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function transformShopCredentials(payload, key, tenantId, operation) {
  if (!Array.isArray(payload)) return payload;
  const context = `wyerp:${tenantId}:erp_shops_data`;
  return payload.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const copy = { ...item };
    for (const field of SECRET_FIELDS) {
      if (!(field in copy)) continue;
      copy[field] = operation === 'encrypt'
        ? encryptValue(copy[field], key, context)
        : decryptValue(copy[field], key, context);
    }
    for (const field of JSON_SECRET_FIELDS) {
      if (!(field in copy)) continue;
      if (operation === 'encrypt') copy[field] = encryptValue(JSON.stringify(copy[field]), key, context + ':' + field);
      else {
        const decrypted = decryptValue(copy[field], key, context + ':' + field);
        if (typeof decrypted === 'string') {
          try { copy[field] = JSON.parse(decrypted); } catch (_) { copy[field] = []; }
        }
      }
    }
    return copy;
  });
}

function encryptShopCredentials(payload, key, tenantId) {
  if (!key) return payload;
  return transformShopCredentials(payload, key, tenantId, 'encrypt');
}

function decryptShopCredentials(payload, key, tenantId) {
  return transformShopCredentials(payload, key, tenantId, 'decrypt');
}

module.exports = {
  parseCredentialKey, encryptShopCredentials, decryptShopCredentials,
  hasPlaintextShopCredentials, isEnvelope, encryptValue, decryptValue
};
