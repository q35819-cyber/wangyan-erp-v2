/* 网研ERP — 采集箱图片来源分流（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_COLLECTION_IMAGES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function array(value) { return Array.isArray(value) ? value : []; }
  function text(value) { return value == null ? '' : String(value).trim(); }
  function aliOriginalImageUrl(value) {
    var raw = text(value);
    if (!raw) return '';
    try {
      var parsed = new URL(raw);
      if (!/(?:^|\.)alicdn(?:1688)?\.com$/i.test(parsed.hostname) && !/(?:^|\.)1688img\.com$/i.test(parsed.hostname)) return raw;
      parsed.pathname = parsed.pathname.replace(/\.jpg_(?:sum|b)\.jpg$/i, '.jpg');
      return parsed.href;
    } catch (error) { return raw; }
  }
  function imageIdentity(value) {
    var raw = text(value);
    if (!raw) return '';
    try {
      var parsed = new URL(raw);
      parsed.hash = '';
      if (/alicdn(?:1688)?\.com$/i.test(parsed.hostname) || /(?:^|\.)1688img\.com$/i.test(parsed.hostname)) {
        parsed.pathname = parsed.pathname.replace(/_(?:sum\.jpg|\.(?:webp|avif))$/i, '');
      }
      return parsed.origin.toLowerCase() + parsed.pathname + parsed.search;
    } catch (error) { return raw; }
  }
  function rawImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object' || Array.isArray(value)) return '';
    return text(value.url || value.file_name_url || value.src || value.imageUrl || value.image || value.thumbnailUrl);
  }
  function previewImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'object' && !Array.isArray(value) && value.thumbnailUrl) return text(value.thumbnailUrl);
    return rawImageUrl(value);
  }
  function imageUrl(value) {
    return aliOriginalImageUrl(rawImageUrl(value));
  }
  function entry(value, fallbackLabel, role) {
    var url = imageUrl(value);
    if (!url) return null;
    return {
      url: url,
      previewUrl: previewImageUrl(value) || url,
      label: text(value && typeof value === 'object' ? value.label || value.name || value.title : '') || fallbackLabel || '',
      role: role || text(value && typeof value === 'object' ? value.role : '')
    };
  }
  function pushUnique(list, seen, item) {
    if (!item || !item.url) return;
    var key = imageIdentity(item.url);
    if (!key || seen[key]) return;
    seen[key] = true;
    list.push(item);
  }

  function sources(product) {
    product = product && typeof product === 'object' ? product : {};
    var capture = product.capture && typeof product.capture === 'object' && !Array.isArray(product.capture) ? product.capture : {};
    var sku = [], detail = [], skuSeen = {}, detailSeen = {};

    // 有规格图时，SKU 来源只使用采集器明确识别出的规格图；主图通常只是当前已选规格的重复图。
    // 完全没有规格图时，才回退为单张采集主图。
    array(capture.skuImages).forEach(function (item, index) {
      pushUnique(sku, skuSeen, entry(item, text(item && item.label) || ('规格图 ' + (index + 1)), 'sku'));
    });
    array(capture.variants).forEach(function (variant, index) {
      pushUnique(sku, skuSeen, entry(variant, text(variant && variant.label) || ('规格图 ' + (index + 1)), 'sku'));
    });
    if (!sku.length) pushUnique(sku, skuSeen, entry(capture.primarySkuImage || product.image || product.imageUrl, '主图', 'sku'));

    // “采集详情图片”按业务定义是采集箱里的其它商品图片，不等同于只取正文详情区。
    // 允许采集箱 main / detail 图片，但排除 variant、视频、与SKU同源的图片以及重复图。
    array(capture.media).forEach(function (item, index) {
      if (!item || typeof item !== 'object') return;
      var kind = text(item.kind).toLowerCase(), role = text(item.role).toLowerCase();
      if (kind !== 'image' || (role !== 'main' && role !== 'detail')) return;
      var candidate = entry(item, '采集图 ' + (index + 1), role || 'detail');
      if (!candidate || skuSeen[imageIdentity(candidate.url)]) return;
      pushUnique(detail, detailSeen, candidate);
    });

    // 货源没有任何SKU主图时，用其它采集图片的第一张补位为主图；从详情列表移除避免重复。
    if (!sku.length && detail.length) {
      var fallbackMain = detail.shift();
      pushUnique(sku, skuSeen, { url: fallbackMain.url, label: '主图（其它图片补位）', role: 'sku' });
    }

    return { sku: sku, detail: detail };
  }

  return { sources: sources, imageUrl: imageUrl, previewImageUrl: previewImageUrl, imageIdentity: imageIdentity, aliOriginalImageUrl: aliOriginalImageUrl };
});