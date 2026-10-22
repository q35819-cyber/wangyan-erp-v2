(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_PRODUCT_SHOPS = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function text(value) { return String(value == null ? '' : value).trim(); }
  function id(shop) { return text(shop && (shop.clientId || shop.externalShopId || shop.id || shop.shopId)); }
  function ids(shop) { return [shop.clientId, shop.externalShopId, shop.id, shop.shopId].map(text).filter(Boolean); }
  function list(items) {
    var seen = new Set();
    return (Array.isArray(items) ? items : []).filter(function (shop) {
      if (!shop || typeof shop !== 'object' || shop.status === 'disabled') return false;
      var key = id(shop);
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function resolve(shops, reference) {
    var value = typeof reference === 'object' && reference ? reference : { shop: reference };
    // Explicit identifiers take precedence. A stale identifier must not fall back to another shop's name.
    var explicit = ids(value);
    if (explicit.length) {
      var matches = shops.filter(function (shop) { return explicit.some(function (key) { return ids(shop).indexOf(key) >= 0; }); });
      return matches.length === 1 ? matches[0] : null;
    }
    var name = text(value.shop || value.shopName);
    if (!name) return null;
    var byId = shops.filter(function (shop) { return ids(shop).indexOf(name) >= 0; });
    if (byId.length) return byId.length === 1 ? byId[0] : null;
    var byName = shops.filter(function (shop) { return [text(shop.name), text(shop.shopName)].indexOf(name) >= 0; });
    return byName.length === 1 ? byName[0] : null;
  }
  return { id: id, list: list, resolve: resolve };
});
