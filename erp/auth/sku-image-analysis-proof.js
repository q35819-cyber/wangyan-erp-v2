'use strict';

const crypto = require('node:crypto');

const TTL_MS = 10 * 60 * 1000;

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function stable(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function issue(account, target, sourceHash, resultHash, secret, now = Date.now(), ruleHash = '') {
  const payload = {
    v: 2, tenantId: String(account.tenantId), userId: String(account.userId),
    clientId: String(target.clientId), productId: String(target.productId), variantRef: String(target.variantRef),
    sourceHash: String(sourceHash), resultHash: String(resultHash), ruleHash: String(ruleHash || ''), exp: now + TTL_MS
  };
  return { analysisProof: sign(payload, secret), expiresAt: new Date(payload.exp).toISOString() };
}

function verify(value, account, target, secret, now = Date.now()) {
  const [body, mac] = String(value || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || ![1, 2].includes(payload.v) || !Number.isSafeInteger(payload.exp) || payload.exp < now ||
      String(payload.tenantId) !== String(account.tenantId) || String(payload.userId) !== String(account.userId) ||
      String(payload.clientId) !== String(target.clientId) || String(payload.productId) !== String(target.productId) ||
      String(payload.variantRef) !== String(target.variantRef)) return null;
  return payload;
}

module.exports = { digest, stable, issue, verify, TTL_MS };
