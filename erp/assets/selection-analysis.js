/* 网研ERP — 选品数据规范化与排序（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_SELECTION_ANALYSIS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function cleanText(value) {
    return value == null ? '' : String(value).trim();
  }

  function numberOrNull(value) {
    if (value === '' || value == null) return null;
    var normalized = typeof value === 'string' ? value.replace(/[\s,%￥¥₽]/g, '') : value;
    var number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function arrayFrom(value) {
    if (Array.isArray(value)) return value;
    return value && Array.isArray(value.items) ? value.items : [];
  }

  function firstMetric(product, names) {
    for (var i = 0; i < names.length; i += 1) {
      var number = numberOrNull(product && product[names[i]]);
      if (number !== null) return number;
    }
    return null;
  }

  function trueFlag(value) {
    return value === true || value === 1 || /^(?:1|true|yes|是)$/i.test(cleanText(value));
  }

  function skuOf(product) {
    return cleanText(product && (product.sku != null ? product.sku : (product.skuId != null ? product.skuId : product.id)));
  }

  function findBySku(value, sku) {
    var wanted = cleanText(sku).toLowerCase();
    if (!wanted) return null;
    var products = arrayFrom(value);
    for (var i = 0; i < products.length; i += 1) {
      if (skuOf(products[i]).toLowerCase() === wanted) return products[i];
    }
    return null;
  }

  function tagsOf(product) {
    var value = product && (product.tags != null ? product.tags : product.labels);
    var tags = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,，;；]/) : []);
    return tags.map(cleanText).filter(Boolean).filter(function (tag, index, all) {
      return all.indexOf(tag) === index;
    });
  }

  function rankingRow(product) {
    return {
      raw: product,
      sku: skuOf(product),
      name: cleanText(product && (product.name || product.title)),
      image: cleanText(product && (product.image || product.primaryImage || product.imageUrl)),
      category: cleanText(product && (product.category || product.cat3 || product.cat2 || product.cat1 || product.categoryName)),
      monthlySales: firstMetric(product, ['monthlySales', 'monthSales', 'salesVolume']),
      monthlyRevenue: firstMetric(product, ['monthlyRevenue', 'monthRevenue', 'salesAmount']),
      price: firstMetric(product, ['averagePrice', 'avgPrice', 'priceSell', 'price']),
      growth: firstMetric(product, ['salesGrowth', 'monthlyGrowth', 'growth']),
      dailySales: firstMetric(product, ['dailySales']),
      views: firstMetric(product, ['monthlyViews', 'views']),
      cartRate: firstMetric(product, ['cartRate']),
      searchCartRate: firstMetric(product, ['searchCartRate']),
      conversionRate: firstMetric(product, ['conversionRate']),
      fulfillment: cleanText(product && (product.fulfillment || product.deliveryMode || product.rfbs)),
      weight: firstMetric(product, ['weight']),
      createdAt: cleanText(product && (product.createdAt || product.created_at || product.listingDate)),
      blueOcean: trueFlag(product && (product.blueOcean != null ? product.blueOcean : product.isBlueOcean)),
      origin: cleanText(product && (product.origin || product.originCountry || product.countryOfOrigin))
    };
  }

  function rankingRows(value) {
    return arrayFrom(value).map(rankingRow).filter(function (row) {
      return row.monthlySales !== null || row.monthlyRevenue !== null;
    });
  }

  function timestamp(value) {
    var parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function metric(value) { return value == null ? -Infinity : value; }

  function sortRanking(rows, mode) {
    return (rows || []).slice().sort(function (a, b) {
      if (mode === 'new') return timestamp(b.createdAt) - timestamp(a.createdAt) || metric(b.monthlySales) - metric(a.monthlySales);
      if (mode === 'potential') return metric(b.growth) - metric(a.growth) || metric(b.monthlySales) - metric(a.monthlySales);
      return metric(b.monthlySales) - metric(a.monthlySales) || metric(b.monthlyRevenue) - metric(a.monthlyRevenue);
    });
  }

  return {
    arrayFrom: arrayFrom,
    cleanText: cleanText,
    findBySku: findBySku,
    numberOrNull: numberOrNull,
    rankingRow: rankingRow,
    rankingRows: rankingRows,
    skuOf: skuOf,
    sortRanking: sortRanking,
    tagsOf: tagsOf
  };
});
