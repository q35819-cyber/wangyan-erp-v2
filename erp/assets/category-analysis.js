(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_CATEGORY_ANALYSIS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var METRIC_ALIASES = {
    qty: ['qty', 'monthlySales', 'monthSales', 'salesVolume'],
    sales: ['sales', 'monthlyRevenue', 'monthRevenue', 'salesAmount'],
    growth: ['growth', 'salesGrowth', 'monthlyGrowth'],
    price: ['price', 'averagePrice', 'avgPrice'],
    sellers: ['sellers', 'sellerCount'],
    brands: ['brands', 'brandCount'],
    brandShare: ['brandShare', 'brandSalesShare'],
    fbsShare: ['fbsShare', 'fbsSalesShare'],
    cancel: ['cancel', 'cancelRate', 'returnCancelRate'],
    topSeller: ['topSeller', 'topSellerShare', 'largeSellerShare']
  };

  function cleanText(value) {
    return String(value == null ? '' : value).trim();
  }

  function numberOrNull(value) {
    if (value == null || value === '' || value === '--') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    var text = cleanText(value).replace(/[,，\s₽¥￥%]/g, '');
    var multiple = 1;
    if (/亿$/.test(text)) { multiple = 100000000; text = text.slice(0, -1); }
    else if (/万$/.test(text)) { multiple = 10000; text = text.slice(0, -1); }
    var parsed = Number(text);
    return Number.isFinite(parsed) ? parsed * multiple : null;
  }

  function metric(node, key) {
    var sources = [node && node.metrics, node];
    var aliases = METRIC_ALIASES[key] || [key];
    for (var s = 0; s < sources.length; s += 1) {
      var source = sources[s];
      if (!source) continue;
      for (var a = 0; a < aliases.length; a += 1) {
        if (!Object.prototype.hasOwnProperty.call(source, aliases[a])) continue;
        var value = numberOrNull(source[aliases[a]]);
        if (value != null) return value;
      }
    }
    return null;
  }

  function rowFromNode(node, level, index) {
    var row = {
      id: cleanText(node && node.id),
      name: cleanText(node && (node.name || node.ru || node.id)),
      ru: cleanText(node && node.ru),
      level: level,
      sourceIndex: index
    };
    Object.keys(METRIC_ALIASES).forEach(function (key) { row[key] = metric(node, key); });
    return row;
  }

  function findL1(tree, id) {
    return (tree || []).find(function (node) { return cleanText(node && node.id) === cleanText(id); }) || null;
  }

  function findL2(l1, id) {
    return (l1 && l1.children || []).find(function (node) { return cleanText(node && node.id) === cleanText(id); }) || null;
  }

  function rowsForSelection(tree, selection) {
    selection = selection || {};
    var l1 = selection.l1 ? findL1(tree, selection.l1) : null;
    var l2 = l1 && selection.l2 ? findL2(l1, selection.l2) : null;
    var nodes = l2 ? (l2.children || []) : (l1 ? (l1.children || []) : (tree || []));
    var level = l2 ? 3 : (l1 ? 2 : 1);
    return nodes.map(function (node, index) { return rowFromNode(node, level, index); });
  }

  function inRange(value, min, max) {
    if (min == null && max == null) return true;
    if (value == null) return false;
    if (min != null && value < min) return false;
    if (max != null && value > max) return false;
    return true;
  }

  function filterRows(rows, filters) {
    filters = filters || {};
    return (rows || []).filter(function (row) {
      return inRange(row.qty, numberOrNull(filters.minQty), numberOrNull(filters.maxQty)) &&
        inRange(row.price, numberOrNull(filters.minPrice), numberOrNull(filters.maxPrice)) &&
        inRange(row.sales, numberOrNull(filters.minSales), numberOrNull(filters.maxSales)) &&
        inRange(row.growth, numberOrNull(filters.minGrowth), numberOrNull(filters.maxGrowth));
    });
  }

  function sortRows(rows, key, direction) {
    var dir = direction === 1 ? 1 : -1;
    return (rows || []).slice().sort(function (left, right) {
      var a = left[key];
      var b = right[key];
      if (a == null && b == null) return left.sourceIndex - right.sourceIndex;
      if (a == null) return 1;
      if (b == null) return -1;
      if (typeof a === 'string' || typeof b === 'string') return dir * String(a).localeCompare(String(b), 'zh-CN');
      if (a === b) return left.sourceIndex - right.sourceIndex;
      return dir * (a - b);
    });
  }

  function paginate(rows, page, pageSize) {
    var size = Math.max(1, Math.floor(numberOrNull(pageSize) || 20));
    var pages = Math.max(1, Math.ceil((rows || []).length / size));
    var current = Math.min(pages, Math.max(1, Math.floor(numberOrNull(page) || 1)));
    var start = (current - 1) * size;
    return { rows: (rows || []).slice(start, start + size), page: current, pageSize: size, pages: pages, total: (rows || []).length };
  }

  function countLevels(tree) {
    var l1 = (tree || []).length;
    var l2 = 0;
    var l3 = 0;
    (tree || []).forEach(function (one) {
      l2 += (one.children || []).length;
      (one.children || []).forEach(function (two) { l3 += (two.children || []).length; });
    });
    return { l1: l1, l2: l2, l3: l3 };
  }

  return {
    numberOrNull: numberOrNull,
    rowsForSelection: rowsForSelection,
    filterRows: filterRows,
    sortRows: sortRows,
    paginate: paginate,
    countLevels: countLevels
  };
});
