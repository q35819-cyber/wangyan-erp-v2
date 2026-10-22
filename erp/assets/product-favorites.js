/* 网研ERP — 商品收藏夹模型（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_FAVORITES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function text(value) { return value == null ? '' : String(value).trim(); }
  function sku(product) { return text(product && (product.sku != null ? product.sku : (product.skuId != null ? product.skuId : product.id))); }
  function array(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
  function displayIdentity(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) return null; var masked=text(value.masked),raw=text(value.raw),kind=text(value.kind); return masked?{kind:kind||'unknown',raw:raw,masked:masked}:null; }
  function normalize(product) {
    product = product || {};
    return {
      sku: sku(product), name: text(product.name || product.title), image: text(product.image || product.imageUrl || product.primaryImage),
      category: text(product.category || product.cat3 || product.cat2 || product.cat1 || product.categoryName),
      price: product.price == null || product.price === '' ? null : Number(product.price), status: text(product.status) || '未上架',
      source: text(product.source), favoritedAt: text(product.favoritedAt),
      favoritedBy: text(product.favoritedBy), favoritedByUserId: text(product.favoritedByUserId), favoritedByIdentity: displayIdentity(product.favoritedByIdentity)
    };
  }
  function normalizeAll(value) { return array(value).map(normalize).filter(function (item) { return item.sku; }); }
  function add(value, product) {
    var list = normalizeAll(value), next = normalize(product), found = false;
    list = list.map(function (item) { if (item.sku.toLowerCase() === next.sku.toLowerCase()) { found = true; var merged = Object.assign({}, item, next); if (!next.favoritedBy) merged.favoritedBy = item.favoritedBy; if (!next.favoritedByUserId) merged.favoritedByUserId = item.favoritedByUserId; if (!next.favoritedByIdentity) merged.favoritedByIdentity = item.favoritedByIdentity; if (!next.favoritedAt) merged.favoritedAt = item.favoritedAt; return merged; } return item; });
    if (!found) list.unshift(next);
    return list;
  }
  function remove(value, skuValue) { var wanted=text(skuValue).toLowerCase(); return normalizeAll(value).filter(function(item){return item.sku.toLowerCase()!==wanted;}); }
  function filter(value, criteria) {
    criteria=criteria||{}; var keyword=text(criteria.keyword).toLowerCase(),category=text(criteria.category),status=text(criteria.status);
    return normalizeAll(value).filter(function(item){
      if(keyword&&(item.name+' '+item.sku).toLowerCase().indexOf(keyword)<0)return false;
      if(category&&item.category!==category)return false;
      return !status||item.status===status;
    });
  }
  return { add:add, array:array, filter:filter, normalize:normalize, normalizeAll:normalizeAll, remove:remove, sku:sku };
});
