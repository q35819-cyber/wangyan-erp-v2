/* 订单与在线商品按完整 SKU 关联共用货源字段（浏览器 / Node 共用）。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_SOURCE_LINK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ORDER_TO_PRODUCT = {
    src: 'srcUrl',
    srcPrice: 'srcPrice',
    srcRemark: 'srcNote',
    purchasePrice: 'purchasePrice',
    domesticShipping: 'domesticShipping'
  };
  var PLATFORM_HOSTS = {
    '1688': ['1688.com'],
    'ozon': ['ozon.ru', 'ozon.by', 'ozon.kz']
  };

  function sku(value) { return String(value == null ? '' : value).trim(); }
  function itemQuantity(item) {
    var raw = item && (item.qty != null ? item.qty : item.quantity);
    if (raw == null || raw === '') return null;
    var value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  function canShareDomesticShipping(item) { return itemQuantity(item) === 1; }
  function safeSupplierUrl(value) {
    try {
      var parsed = new URL(String(value || ''));
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
      return parsed.href;
    } catch (error) { return ''; }
  }
  function sourcePlatformKey(value) {
    var normalized = String(value || '').trim().toLowerCase();
    if (normalized.indexOf('1688') >= 0) return '1688';
    if (normalized.indexOf('ozon') >= 0) return 'ozon';
    return '';
  }
  function hostMatches(hostname, roots) {
    var host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
    return (Array.isArray(roots) ? roots : []).some(function (rootHost) {
      return host === rootHost || host.endsWith('.' + rootHost);
    });
  }
  function safePlatformSupplierUrl(value, platform) {
    var href = safeSupplierUrl(value), key = sourcePlatformKey(platform);
    if (!href || !key || !PLATFORM_HOSTS[key]) return '';
    try {
      return hostMatches(new URL(href).hostname, PLATFORM_HOSTS[key]) ? href : '';
    } catch (error) { return ''; }
  }
  function clean(value) { return value == null || value === '--' ? '' : value; }
  function copy(value) { return value == null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value)); }
  function timestamp(order) {
    var value = order && (order.lastOperatedAt || order.updatedAt || order.orderTime || order.createdAt);
    var parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }
  function profile(item) {
    var result = {};
    Object.keys(ORDER_TO_PRODUCT).forEach(function (orderField) {
      if (orderField === 'domesticShipping' && !canShareDomesticShipping(item)) return;
      result[ORDER_TO_PRODUCT[orderField]] = copy(clean(item && item[orderField]));
    });
    return result;
  }
  function hasSource(item) {
    var sourceProfile = profile(item);
    return Object.keys(sourceProfile).some(function (field) { return clean(sourceProfile[field]) !== ''; });
  }
  function profilesFromOrders(orders) {
    var profiles = {};
    (Array.isArray(orders) ? orders : []).forEach(function (order, orderIndex) {
      (Array.isArray(order && order.items) ? order.items : []).forEach(function (item, itemIndex) {
        var key = sku(item && item.sku);
        if (!key) return;
        var candidate = {
          data: profile(item),
          hasSource: hasSource(item),
          time: timestamp(order),
          orderIndex: orderIndex,
          itemIndex: itemIndex
        };
        var current = profiles[key];
        if (!current || (candidate.hasSource && !current.hasSource) ||
          (candidate.hasSource === current.hasSource && (candidate.time > current.time ||
            (candidate.time === current.time && (candidate.orderIndex > current.orderIndex ||
              (candidate.orderIndex === current.orderIndex && candidate.itemIndex > current.itemIndex)))))) profiles[key] = candidate;
      });
    });
    Object.keys(profiles).forEach(function (key) { profiles[key] = profiles[key].data; });
    return profiles;
  }
  function applyProfile(product, sourceProfile) {
    if (!product || !sourceProfile) return false;
    var changed = false;
    Object.keys(sourceProfile).forEach(function (field) {
      var next = copy(sourceProfile[field]);
      if (JSON.stringify(product[field]) !== JSON.stringify(next)) { product[field] = next; changed = true; }
    });
    return changed;
  }
  function applyOrdersToProducts(products, orders) {
    var profiles = profilesFromOrders(orders), changed = 0;
    (Array.isArray(products) ? products : []).forEach(function (product) {
      var sourceProfile = profiles[sku(product && product.sku)];
      if (sourceProfile && applyProfile(product, sourceProfile)) changed += 1;
    });
    return changed;
  }
  function applyProductToOrders(orders, product) {
    var key = sku(product && product.sku), changed = 0;
    if (!key) return 0;
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      (Array.isArray(order && order.items) ? order.items : []).forEach(function (item) {
        if (sku(item && item.sku) !== key) return;
        Object.keys(ORDER_TO_PRODUCT).forEach(function (orderField) {
          if (orderField === 'domesticShipping' && !canShareDomesticShipping(item)) return;
          var productField = ORDER_TO_PRODUCT[orderField];
          var next = copy(clean(product[productField]));
          if (JSON.stringify(item[orderField]) !== JSON.stringify(next)) { item[orderField] = next; changed += 1; }
        });
      });
    });
    return changed;
  }
  function repairOrderSources(orders, products, overwrite) {
    var profiles = {};
    (Array.isArray(products) ? products : []).forEach(function (product) {
      var key = sku(product && product.sku);
      if (!key) return;
      var target = profiles[key] || (profiles[key] = {});
      Object.keys(ORDER_TO_PRODUCT).forEach(function (orderField) {
        var value = clean(product && product[ORDER_TO_PRODUCT[orderField]]);
        if (value !== '' && clean(target[orderField]) === '') target[orderField] = copy(value);
      });
    });
    if (!overwrite) {
      (Array.isArray(orders) ? orders : []).slice().sort(function (a, b) { return timestamp(a) - timestamp(b); }).forEach(function (order) {
        (Array.isArray(order && order.items) ? order.items : []).forEach(function (item) {
          var key = sku(item && item.sku);
          if (!key) return;
          var target = profiles[key] || (profiles[key] = {});
          Object.keys(ORDER_TO_PRODUCT).forEach(function (orderField) {
            var value = clean(item && item[orderField]);
            if (value !== '') target[orderField] = copy(value);
          });
        });
      });
    }
    var changedItems = 0, changedFields = 0, missingItems = 0;
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      (Array.isArray(order && order.items) ? order.items : []).forEach(function (item) {
        var sourceProfile = profiles[sku(item && item.sku)], itemChanged = false;
        if (!sourceProfile || !Object.keys(sourceProfile).some(function (field) { return clean(sourceProfile[field]) !== ''; })) {
          missingItems += 1;
          return;
        }
        Object.keys(ORDER_TO_PRODUCT).forEach(function (orderField) {
          if (orderField === 'domesticShipping' && !canShareDomesticShipping(item)) return;
          if ((!overwrite && clean(item[orderField]) !== '') || clean(sourceProfile[orderField]) === '') return;
          if (JSON.stringify(item[orderField]) === JSON.stringify(sourceProfile[orderField])) return;
          item[orderField] = copy(sourceProfile[orderField]);
          changedFields += 1;
          itemChanged = true;
        });
        if (itemChanged) changedItems += 1;
      });
    });
    return { changedItems: changedItems, changedFields: changedFields, missingItems: missingItems };
  }
  function repairProductSources(products, orders) {
    var profiles = profilesFromOrders(orders), changedProducts = 0, changedFields = 0, missingProducts = 0;
    (Array.isArray(products) ? products : []).forEach(function (product) {
      var sourceProfile = profiles[sku(product && product.sku)], productChanged = false;
      if (!sourceProfile || !Object.keys(sourceProfile).some(function (field) { return clean(sourceProfile[field]) !== ''; })) {
        missingProducts += 1;
        return;
      }
      Object.keys(sourceProfile).forEach(function (field) {
        if (clean(product[field]) !== '' || clean(sourceProfile[field]) === '') return;
        product[field] = copy(sourceProfile[field]);
        changedFields += 1;
        productChanged = true;
      });
      if (productChanged) changedProducts += 1;
    });
    return { changedProducts: changedProducts, changedFields: changedFields, missingProducts: missingProducts };
  }
  function repairAllSources(orders, products) {
    var orderResult = repairOrderSources(orders, products);
    var productResult = repairProductSources(products, orders);
    return { orders: orderResult, products: productResult };
  }
  return {
    applyOrdersToProducts: applyOrdersToProducts,
    applyProductToOrders: applyProductToOrders,
    repairOrderSources: repairOrderSources,
    repairProductSources: repairProductSources,
    repairAllSources: repairAllSources,
    profilesFromOrders: profilesFromOrders,
    safePlatformSupplierUrl: safePlatformSupplierUrl,
    sourcePlatformKey: sourcePlatformKey,
    safeSupplierUrl: safeSupplierUrl,
    sku: sku,
    itemQuantity: itemQuantity,
    canShareDomesticShipping: canShareDomesticShipping
  };
});
