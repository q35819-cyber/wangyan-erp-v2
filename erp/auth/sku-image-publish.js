'use strict';

const crypto = require('node:crypto');

function fail(code, message, status = 503) {
  return Object.assign(new Error(message), { publicCode: code, status });
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw fail('sku_image_public_origin_invalid', '公网访问地址配置不正确，无法把图片提交到 Ozon。'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search || parsed.pathname !== '/') {
    throw fail('sku_image_public_origin_invalid', '公网访问地址必须是 HTTPS 站点根地址，无法把图片提交到 Ozon。');
  }
  const host = String(parsed.hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(host)) {
    throw fail('sku_image_public_origin_invalid', '公网访问地址不能使用本机、内网或裸 IP，无法把图片提交到 Ozon。');
  }
  return parsed.origin;
}

function key(secret) {
  const source = String(secret || '');
  if (source.length < 16) throw fail('sku_image_publish_secret_unavailable', '图片发布签名密钥未就绪，无法把图片提交到 Ozon。');
  return crypto.createHash('sha256').update('wyerp:sku-image-publish:v1:' + source).digest();
}

function payload(objectId, sha256, expiresAt) {
  return [String(objectId || ''), String(sha256 || '').toLowerCase(), String(expiresAt || '')].join('|');
}

function createPublisher({ publicOrigin, secret, ttlSeconds = 6 * 60 * 60 } = {}) {
  const origin = normalizeOrigin(publicOrigin);
  const signingKey = key(secret);
  const ttl = Math.min(Math.max(Number(ttlSeconds) || 21600, 900), 24 * 60 * 60);

  function configured() { return Boolean(origin); }

  function sign(item, now = Date.now()) {
    if (!origin) throw fail('sku_image_public_origin_required', '当前服务器还没有配置公网 HTTPS 地址，图片已保存在 ERP，但不能提交到 Ozon。请先配置 PUBLIC_ORIGIN。');
    const objectId = String(item && item.objectId || '');
    const sha256 = String(item && item.sha256 || '').toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(objectId) || !/^[0-9a-f]{64}$/.test(sha256)) throw fail('sku_image_publish_target_invalid', '待发布图片信息不完整，请重新保存图片后再试。', 409);
    const expiresAt = Math.floor(now / 1000) + ttl;
    const signature = crypto.createHmac('sha256', signingKey).update(payload(objectId, sha256, expiresAt)).digest('hex');
    return {
      url: origin + '/public/sku-images/' + encodeURIComponent(objectId) + '?exp=' + expiresAt + '&sig=' + signature,
      expiresAt
    };
  }

  function verify(item, exp, sig, now = Date.now()) {
    const objectId = String(item && item.id || item && item.objectId || '');
    const sha256 = String(item && item.sha256 || '').toLowerCase();
    const expiresAt = Number(exp);
    if (!/^[0-9a-f-]{36}$/i.test(objectId) || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(expiresAt)) return false;
    const current = Math.floor(now / 1000);
    if (expiresAt < current || expiresAt > current + 24 * 60 * 60) return false;
    if (!/^[a-f0-9]{64}$/i.test(String(sig || ''))) return false;
    const expected = crypto.createHmac('sha256', signingKey).update(payload(objectId, sha256, expiresAt)).digest();
    const supplied = Buffer.from(String(sig), 'hex');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  return { configured, sign, verify, origin };
}

module.exports = { createPublisher, normalizeOrigin };
