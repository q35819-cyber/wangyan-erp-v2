/* SKU 仅在界面显示时遮住末 4 位；搜索、匹配、复制和服务端原始数据保持完整。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_SKU_MASK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function mask(value) {
    var text = String(value == null ? '' : value);
    if (!text) return '--';
    if (text.length <= 4) return '****';
    return text.slice(0, text.length - 4) + '****';
  }
  function maskShopId(value) {
    var text = String(value == null ? '' : value);
    if (!text) return '--';
    var keep = Math.floor(text.length / 2);
    return text.slice(0, keep) + '*'.repeat(text.length - keep);
  }
  return { mask: mask, maskShopId: maskShopId };
});
