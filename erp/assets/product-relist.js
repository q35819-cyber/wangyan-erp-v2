/* 网研ERP — 下架重上草稿身份转换（浏览器 / Node 共用）
 * 复制商品业务资料，但清除旧平台身份；新货号统一复用 product-article-generator。
 */
(function (root, factory) {
  var generator = root && root.WYERP_PRODUCT_ARTICLE_GENERATOR;
  if (typeof module === 'object' && module.exports) generator = require('./product-article-generator');
  var api = factory(generator);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_RELIST = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (articleGenerator) {
  'use strict';

  function arr(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return value == null ? '' : String(value).trim(); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

  function stripSellerCode(attributes) {
    return arr(attributes).filter(function (attribute) {
      return String(attribute && (attribute.id || attribute.attribute_id) || '') !== '9024';
    }).map(clone);
  }

  function cleanVariant(variant, offerId, newRef) {
    var next = clone(variant || {}) || {};
    next.erpVariantRef = newRef;
    next.offerId = offerId;
    next.sku = '';
    next.attributes = stripSellerCode(next.attributes);
    delete next.article;
    delete next.offer_id;
    delete next.id;
    delete next.productId;
    delete next.product_id;
    delete next.ozonSku;
    delete next.ozon_sku;
    delete next.status;
    delete next.statusKey;
    delete next.visibility;
    delete next.archived;
    delete next.is_archived;
    delete next.relistedAt;
    return next;
  }

  function remapNodeRef(value, refMap) {
    var ref = text(value);
    if (ref.indexOf('variant:') !== 0) return ref;
    var oldRef = ref.slice('variant:'.length);
    return refMap[oldRef] ? 'variant:' + refMap[oldRef] : ref;
  }

  function defaultRef(index) {
    var raw = Date.now().toString(36) + '_' + index + '_' + Math.random().toString(36).slice(2, 12);
    return 'erv_' + raw.replace(/[^A-Za-z0-9_-]/g, '');
  }

  function defaultRelationId(index) {
    return 'rel_relist_' + Date.now().toString(36) + '_' + index + '_' + Math.random().toString(36).slice(2, 10);
  }

  function sourceIdentity(source) {
    source = source || {};
    var clientId = text(source.clientId || source.client_id || source.externalShopId || source.shopId);
    var productId = text(source.productId || source.product_id || source.id);
    if (!/^\d{1,18}$/.test(clientId) || !/^\d+$/.test(productId) || !Number.isSafeInteger(Number(productId)) || Number(productId) <= 0) return null;
    return {
      clientId: clientId,
      productId: productId,
      sku: text(source.sku),
      offerId: text(source.offerId || source.offer_id || source.article)
    };
  }

  function prepare(state, options) {
    state = state || {};
    options = options || {};
    if (!articleGenerator || typeof articleGenerator.generate !== 'function') throw new Error('货号生成规则未加载');
    var variants = arr(state.variants);
    if (!variants.length) throw new Error('下架商品缺少可复制的SKU资料');
    var generated = articleGenerator.generate(variants.length, { date: options.date, random: options.random });
    var refFactory = typeof options.variantRefFactory === 'function' ? options.variantRefFactory : defaultRef;
    var relationFactory = typeof options.relationIdFactory === 'function' ? options.relationIdFactory : defaultRelationId;
    var refMap = {};
    var nextVariants = variants.map(function (variant, index) {
      var oldRef = text(variant && variant.erpVariantRef);
      var newRef = text(refFactory(index, oldRef));
      if (!/^erv_[A-Za-z0-9_-]{6,220}$/.test(newRef)) throw new Error('重上商品内部SKU标识生成失败');
      if (oldRef) refMap[oldRef] = newRef;
      return cleanVariant(variant, generated.values[index], newRef);
    });
    var now = options.now instanceof Date ? options.now.toISOString() : text(options.now) || new Date().toISOString();
    var relations = arr(state.combinationRelations).map(function (relation, index) {
      var next = clone(relation || {}) || {};
      next.id = text(relationFactory(index, next.id));
      next.parentRef = remapNodeRef(next.parentRef, refMap);
      next.childRef = remapNodeRef(next.childRef, refMap);
      next.createdAt = now;
      next.updatedAt = now;
      next.lastCombinedAt = now;
      return next;
    });
    return {
      attributes: stripSellerCode(state.attributes),
      variants: nextVariants,
      sourceBundles: clone(arr(state.sourceBundles)),
      combinationRelations: relations,
      combinationHistory: [],
      generated: generated,
      relistSource: sourceIdentity(options.source)
    };
  }

  return {
    prepare: prepare,
    sourceIdentity: sourceIdentity,
    stripSellerCode: stripSellerCode,
    remapNodeRef: remapNodeRef
  };
});
