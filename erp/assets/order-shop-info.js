(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_ORDER_SHOP_INFO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function sellerId(value) {
    var text = String(value == null ? '' : value).trim();
    return /^[1-9]\d{2,19}$/.test(text) ? text : '';
  }

  function buyerId(order) {
    order = order && typeof order === 'object' ? order : {};
    var direct = String(order.buyer && order.buyer.id != null ? order.buyer.id : '').trim();
    if (direct && direct !== '0') return { value: direct, fallback: false, fallbackSource: '' };
    var firstPostingPart = String(order.posting || order.posting_number || '').split('-')[0].trim();
    if (firstPostingPart.charAt(0) === '0') firstPostingPart = firstPostingPart.slice(1);
    var fallback = /^\d+$/.test(firstPostingPart) ? firstPostingPart : '';
    return { value: fallback, fallback: !!fallback, fallbackSource: fallback ? 'posting_prefix' : '' };
  }

  function resolve(order, shops) {
    order = order && typeof order === 'object' ? order : {};
    shops = Array.isArray(shops) ? shops : [];
    var clientId = String(order.clientId == null ? '' : order.clientId).trim();
    var savedName = String(order.shop == null ? '' : order.shop).trim();
    var shop = shops.find(function (item) { return String(item && item.clientId || '') === clientId; }) ||
      shops.find(function (item) { return String(item && item.name || '') === savedName; }) || null;
    var directId = sellerId(order.sellerId) || sellerId(order.seller && order.seller.id);
    var boundId = sellerId(shop && shop.clientId) || sellerId(clientId);
    var firstPostingPart = String(order.posting || order.posting_number || '').split('-')[0];
    var postingId = sellerId(firstPostingPart.charAt(0) === '0' ? firstPostingPart.slice(1) : firstPostingPart);
    var postingMatchesShop = !!postingId && !!boundId && postingId === boundId;
    var fallbackId = postingMatchesShop ? postingId : boundId;
    return {
      name: String(shop && shop.name || savedName || '--'),
      sellerId: directId || fallbackId,
      fallback: !directId && !!fallbackId,
      fallbackSource: directId ? '' : postingMatchesShop ? 'posting_prefix' : fallbackId ? 'shop_binding' : ''
    };
  }

  return { resolve: resolve, buyerId: buyerId };
});
