/* 在线商品同步数据与人工覆盖分层（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ONLINE_MANUAL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var FIELDS = ['priceSell', 'priceOriginal', 'priceLowest', 'stock', 'stockWarehouseId', 'stockWarehouseName', 'purchasePrice', 'srcUrl', 'srcPrice', 'srcNote', 'domesticShipping'];
  function key(product) {
    product = product || {};
    return String(product.shop || '') + '::' + String(product.id != null ? product.id : (product.sku || product.article || ''));
  }
  function toMap(entries) {
    var map = {};
    (Array.isArray(entries) ? entries : []).forEach(function (entry) { if (entry && entry.key) map[entry.key] = Object.assign({}, entry); });
    return map;
  }
  function capture(entries, product) {
    var map = toMap(entries), productId = key(product), flags = product && product._manual || {};
    var entry = map[productId] || { key: productId, shop: product.shop, id: product.id, sku: product.sku, article: product.article };
    FIELDS.forEach(function (field) {
      var isSource = ['purchasePrice', 'srcUrl', 'srcPrice', 'srcNote', 'domesticShipping'].indexOf(field) >= 0;
      if (flags[field] || (isSource && product[field] != null && product[field] !== '')) entry[field] = product[field];
    });
    map[productId] = entry;
    return Object.keys(map).map(function (itemKey) { return map[itemKey]; });
  }
  function apply(product, entries) {
    var result = Object.assign({}, product), saved = toMap(entries)[key(product)];
    if (!saved) return result;
    FIELDS.forEach(function (field) {
      if (Object.prototype.hasOwnProperty.call(saved, field)) result[field] = saved[field];
    });
    return result;
  }
  function clearSynced(products, entries) {
    var saved = Array.isArray(entries) ? entries : [];
    (Array.isArray(products) ? products : []).forEach(function (product) { saved = capture(saved, product); });
    return { products: [], manual: saved };
  }
  return { apply: apply, capture: capture, clearSynced: clearSynced, key: key, toMap: toMap };
});
