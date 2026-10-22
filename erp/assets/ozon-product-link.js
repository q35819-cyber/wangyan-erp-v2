/* 网研ERP — Ozon前台商品链接（浏览器 / Node 共用）
 * 只接受可验证的Ozon官方商品URL或真实Ozon数字SKU。
 * 禁止使用ERP内部id/productId、卖家货号offerId/article、店铺ID猜测前台URL。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_OZON_PRODUCT_LINK = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FRONT_ORIGIN = 'https://www.ozon.ru';

  function text(value) {
    return value == null ? '' : String(value).trim();
  }

  function safeOfficialUrl(value) {
    var raw = text(value);
    if (!raw) return '';
    try {
      var parsed = new URL(raw);
      var host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
      if (host !== 'ozon.ru' && host !== 'www.ozon.ru') return '';
      if (!/^\/product\//i.test(parsed.pathname)) return '';
      parsed.protocol = 'https:';
      parsed.hostname = 'www.ozon.ru';
      parsed.port = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.href;
    } catch (error) {
      return '';
    }
  }

  function numericSku(value) {
    var raw = text(value);
    return /^[1-9]\d{4,19}$/.test(raw) ? raw : '';
  }

  function officialUrlOf(product) {
    if (typeof product === 'string' || typeof product === 'number') return safeOfficialUrl(product);
    product = product || {};
    var fields = [
      product.ozonUrl, product.ozon_url,
      product.productUrl, product.product_url,
      product.marketplaceUrl, product.marketplace_url,
      product.frontUrl, product.front_url,
      product.url
    ];
    for (var i = 0; i < fields.length; i += 1) {
      var safe = safeOfficialUrl(fields[i]);
      if (safe) return safe;
    }
    return '';
  }

  function hasNonOzonSource(product) {
    if (!product || typeof product !== 'object') return false;
    var source = text(product.sourcePlatform || product.platformSource || product.source).toLowerCase();
    if (!source || source.indexOf('ozon') >= 0) return false;
    return /1688|alibaba|阿里巴巴|采集|货源/.test(source);
  }

  function skuOf(product) {
    if (typeof product === 'number') return numericSku(product);
    if (typeof product === 'string') return numericSku(product);
    product = product || {};
    var explicitFields = [product.ozonSku, product.ozon_sku];
    for (var i = 0; i < explicitFields.length; i += 1) {
      var explicitSku = numericSku(explicitFields[i]);
      if (explicitSku) return explicitSku;
    }
    if (hasNonOzonSource(product)) return '';
    var fields = [product.sku, product.productSku, product.product_sku, product.marketplaceSku, product.marketplace_sku];
    for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
      var sku = numericSku(fields[fieldIndex]);
      if (sku) return sku;
    }
    return '';
  }

  function href(product) {
    var official = officialUrlOf(product);
    if (official) return official;
    var sku = skuOf(product);
    return sku ? FRONT_ORIGIN + '/product/' + encodeURIComponent(sku) + '/' : '';
  }

  function unavailableReason(product) {
    return href(product) ? '' : '未关联Ozon在线商品，无法打开Ozon前台';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"'\r\n]/g, function (char) {
      if (char === '\r') return '';
      if (char === '\n') return '&#10;';
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function titleHtml(product, label, options) {
    options = options || {};
    var visible = text(label) || '未命名商品';
    var fullLabel = text(options.fullLabel) || visible;
    var className = text(options.className) || 'ozon-product-title-link';
    var target = href(product);
    if (target) {
      return '<a class="' + escapeHtml(className) + '" href="' + escapeHtml(target) + '" target="_blank" rel="noopener" title="' +
        escapeHtml(fullLabel) + '" aria-label="' + escapeHtml('在Ozon前台打开商品：' + fullLabel) + '">' + escapeHtml(visible) + '</a>';
    }
    var reason = unavailableReason(product);
    return '<span class="' + escapeHtml(className) + '" title="' + escapeHtml(fullLabel) + '" data-wy-tooltip="' +
      escapeHtml(fullLabel + '\n' + reason) + '">' + escapeHtml(visible) + '</span>';
  }

  return {
    FRONT_ORIGIN: FRONT_ORIGIN,
    escapeHtml: escapeHtml,
    hasNonOzonSource: hasNonOzonSource,
    href: href,
    numericSku: numericSku,
    officialUrlOf: officialUrlOf,
    safeOfficialUrl: safeOfficialUrl,
    skuOf: skuOf,
    titleHtml: titleHtml,
    unavailableReason: unavailableReason
  };
});
