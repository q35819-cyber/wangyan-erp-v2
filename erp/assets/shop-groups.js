(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_SHOP_GROUPS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function clean(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
  function normalize(item) {
    item = item && typeof item === 'object' ? item : {};
    return {
      id: clean(item.id, 80) || ('group-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
      name: clean(item.name, 80) || '未命名分组',
      manager: clean(item.manager, 80),
      description: clean(item.description, 300),
      shopIds: [...new Set((Array.isArray(item.shopIds) ? item.shopIds : []).map(function (id) { return clean(id, 120); }).filter(Boolean))],
      updatedAt: clean(item.updatedAt, 40) || new Date().toISOString()
    };
  }
  function normalizeAll(items) { return (Array.isArray(items) ? items : []).map(normalize); }
  function upsert(items, input) {
    var list = normalizeAll(items), item = normalize(input), found = false;
    list = list.map(function (current) { if (current.id !== item.id) return current; found = true; return item; });
    if (!found) list.push(item);
    return list;
  }
  function remove(items, id) { return normalizeAll(items).filter(function (item) { return item.id !== String(id); }); }
  return { normalize: normalize, normalizeAll: normalizeAll, upsert: upsert, remove: remove };
});
