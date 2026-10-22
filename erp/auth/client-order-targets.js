'use strict';

function clientIdOf(shop) {
  const value = String(shop && shop.clientId || '').trim();
  return /^[1-9]\d{2,19}$/.test(value) ? value : '';
}

function hasPersistentSellerAuthorization(shop) {
  const clientId = clientIdOf(shop);
  const authorization = shop && shop.sellerCookieAuthorization;
  return Boolean(clientId && shop.cookie === '已授权' && authorization?.status === 'authorized' &&
    Array.isArray(shop.sellerCookies) && shop.sellerCookies.length > 0);
}

function partitionTenantShops(shops) {
  const authorized = [];
  const unauthorized = [];
  const seen = new Set();
  for (const shop of Array.isArray(shops) ? shops : []) {
    const clientId = clientIdOf(shop);
    if (!clientId || seen.has(clientId)) continue;
    seen.add(clientId);
    (hasPersistentSellerAuthorization(shop) ? authorized : unauthorized).push({ clientId, shop });
  }
  return { authorized, unauthorized };
}

module.exports = { clientIdOf, hasPersistentSellerAuthorization, partitionTenantShops };
