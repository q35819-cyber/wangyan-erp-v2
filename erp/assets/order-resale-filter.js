(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ORDER_RESALE_FILTER = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(value) { return String(value == null ? '' : value).trim(); }
  function isResaleOrder(order) {
    if (!order) return false;
    var schema = text(order.deliverySchema || order.delivery_schema || order.fulfillmentSchema).toUpperCase();
    return !!text(order.retFrom) || schema === 'WHD';
  }
  function isDestroyed(order) {
    if (!order) return false;
    if (['销毁中', '正在由Ozon进行销毁', '已销毁'].indexOf(text(order.ret)) >= 0) return true;
    return !!(order.finance && Array.isArray(order.finance.feeItems) && order.finance.feeItems.some(function (item) {
      return Number(item && item.type) === 15 || /(^|[^a-z])disposal([^a-z]|$)|утилизац/i.test(text(item && (item.type || item.name || item.desc)));
    }));
  }
  function hasReturnOutcome(order) {
    if (!order) return false;
    var reason = text(order.cancel && (order.cancel.whyZh || order.cancel.why));
    var refused = !!(order.cancel && order.cancel.refused) || /拒收|отказал|refus/i.test(reason);
    var marker = text(order.ret);
    return refused || !!text(order.retRel) || isDestroyed(order) || marker === '正在运往仓库' || marker === '在仓库' || marker === '已到退货仓库';
  }
  function unshipped(order) {
    var status = text(order && order.status);
    if (['等待备货', '等待打包', '等待发运', '等待装运', '等待发货'].indexOf(status) >= 0) return true;
    if (['运输中', '派送中', '司机自提', '到取货点', '已签收', '已送达'].indexOf(status) >= 0) return false;
    if (/取消|未接受/.test(status) && order && order.cancel && typeof order.cancel.shipped === 'boolean') return !order.cancel.shipped;
    return !text(order && order.track) || text(order && order.track) === '--';
  }
  function linkedResale(origin, orders) {
    var finance = origin && origin.finance || {};
    var posting = text(finance.retResalePosting || origin && origin.retResalePosting);
    if (posting) return (orders || []).find(function (order) { return text(order && order.posting) === posting; }) || null;
    var originPosting = text(origin && origin.posting);
    return (orders || []).find(function (order) { return text(order && order.retFrom) === originPosting; }) || null;
  }
  function isInWarehouse(order, orders) {
    // WHD 二次销售单已经是新订单，不是仓库存货；原退货一旦产生二次销售 posting 也立即离仓，不等新单发货。
    if (isResaleOrder(order)) return false;
    var marker = text(order && order.ret);
    var warehouse = marker === '在仓库' || marker === '已到退货仓库'; // 后者仅兼容尚未重写的旧缓存/旧库。
    if (!warehouse) return false;
    return !linkedResale(order, orders);
  }

  return { isResaleOrder: isResaleOrder, isDestroyed: isDestroyed, hasReturnOutcome: hasReturnOutcome, isInWarehouse: isInWarehouse, unshipped: unshipped, linkedResale: linkedResale };
});
