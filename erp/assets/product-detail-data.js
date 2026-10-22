(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./product-attribute-fields'));
  else root.WYERP_PRODUCT_DETAIL_DATA = factory(root.WYERP_PRODUCT_ATTRIBUTE_FIELDS);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fields) {
  'use strict';
  var arr = function (v) { return Array.isArray(v) ? v : []; };
  function present(v) { return v != null && String(v).trim() !== ''; }
  function first() { var value = Array.prototype.find.call(arguments, present); return value == null ? '' : value; }
  function attributeKey(a) { return String(a.id || a.attribute_id || '') + ':' + String(a.complex_id || a.complexId || a.attribute_complex_id || 0); }
  function flattenAttributes(value) {
    var result = [];
    arr(value).forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      if (Array.isArray(entry.attributes)) {
        arr(entry.attributes).forEach(function (attribute) {
          if (!attribute || typeof attribute !== 'object') return;
          var copy = Object.assign({}, attribute);
          if (!copy.complex_id && !copy.complexId && !copy.attribute_complex_id) {
            var inherited = entry.complex_id || entry.complexId || entry.attribute_complex_id;
            if (inherited) copy.complex_id = inherited;
          }
          result.push(copy);
        });
        return;
      }
      if (entry.id || entry.attribute_id) result.push(Object.assign({}, entry));
    });
    return result;
  }
  function mergeAttributes(base, overrides) {
    var result = flattenAttributes(base);
    flattenAttributes(overrides).forEach(function (a) {
      var i = result.findIndex(function (b) { return attributeKey(a) === attributeKey(b); });
      if (i < 0) result.push(Object.assign({}, a));
      else {
        result[i] = Object.assign({}, result[i], a);
        if (Array.isArray(a.values) && a.value == null) delete result[i].value;
      }
    });
    return result;
  }
  function match(data, id) {
    var items = arr(data && (data.items || data.result && data.result.items || data.result));
    return items.find(function (item) { return String(item.id) === String(id); }) || null;
  }
  function images(value) {
    return (Array.isArray(value) ? value : [value]).map(function (item) {
      var url = typeof item === 'string' ? item : item && (item.file_name_url || item.url || item.src);
      return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
    }).filter(Boolean);
  }
  function measure(value, unit, kind) {
    if (!present(value)) return '';
    var factor = (kind === 'weight' ? { g: 1, kg: 1000 } : { mm: 1, cm: 10, in: 25.4 })[String(unit || '').toLowerCase()];
    if (!factor || !Number.isFinite(Number(value)) || Number(value) < 0) return '';
    return String(Math.round(Number(value) * factor * 1000000) / 1000000);
  }
  function project(local, info, detail) {
    info = info || {}; detail = detail || {};
    var output = Object.assign({}, local), edited = Boolean(local.editorDraftId);
    function put(key, live, fallback) { output[key] = edited && present(local[key]) ? local[key] : first(live, local[key], fallback, ''); }
    put('name', first(detail.name, info.name));
    put('article', first(detail.offer_id, info.offer_id));
    put('sku', first(detail.sku, info.sku));
    put('priceLowest', info.min_price); put('priceSell', info.price); put('priceOriginal', info.old_price);
    // Category can be completed if missing, but an existing listing's category is never editable.
    output.descriptionCategoryId = first(local.descriptionCategoryId, local.description_category_id, detail.description_category_id, info.description_category_id, '');
    output.typeId = first(local.typeId, local.type_id, detail.type_id, info.type_id, '');
    put('weightG', measure(detail.weight, detail.weight_unit, 'weight'));
    [['length','depth'], ['width','width'], ['height','height']].forEach(function (pair) {
      var fallback = first(local[pair[0] + 'Mm'], measure(local[pair[1]], local.dimensionUnit || 'mm', 'dimension'));
      put(pair[0], measure(detail[pair[1]], detail.dimension_unit, 'dimension'), fallback);
    });
    put('barcode', first(detail.barcode, arr(detail.barcodes).join('; '), arr(info.barcodes).join('; ')));
    var live = mergeAttributes(detail.attributes, detail.complex_attributes);
    // Previously saved editor values (including explicit clears) remain user-owned.
    output.editorAttributes = mergeAttributes(mergeAttributes(local.attributes, live), local.editorAttributes);
    function value(id) { var a = output.editorAttributes.find(function (a) { return String(a.id) === id; }); return a && fields.text(a); }
    put('brand', value('85') || value('31'));
    put('description', value('4191')); put('richContent', value('11254'));
    var urls = images(detail.primary_image).concat(images(detail.images), images(info.primary_image), images(info.images));
    urls = urls.filter(function (url, i) { return urls.indexOf(url) === i; });
    if (urls.length && !edited) { output.images = urls; output.img = urls[0]; }
    var rows = arr(local.variants).filter(function (v) { return v && typeof v === 'object'; }).map(function (v) { return Object.assign({}, v); });
    var row = Object.assign({ name: local.name, offerId: local.article, sku: local.sku,
      image: first(local.img, local.image, local.primaryImage), images: images(local.images),
      color: local.color, colorName: local.colorName, packQuantity: local.packQuantity, itemLength: local.itemLength,
      video: local.video, videoCover: local.videoCover, stock: local.stock }, rows[0] || {});
    function variant(key, value) { if (!edited || !present(row[key])) row[key] = first(value, row[key], ''); }
    variant('name', output.name); variant('offerId', output.article); variant('sku', output.sku);
    variant('lowest', output.priceLowest); variant('sale', output.priceSell); variant('old', output.priceOriginal);
    if (!present(row.purchase)) row.purchase = first(local.purchasePrice, '');
    if (row.domesticShipping == null) row.domesticShipping = first(local.domesticShipping, '');
    if (urls.length && !edited) { row.images = urls; row.image = urls[0]; }
    variant('video', value('21841')); variant('videoCover', value('21845'));
    rows[0] = row; output.variants = rows;
    return output;
  }
  function refresh(local, info, detail) {
    // A completed platform read must also clear removed attributes, rather than
    // letting a previous editor snapshot override the newly synchronized value.
    var clean = Object.assign({}, local, { editorDraftId: undefined, editorAttributes: [], attributes: [],
      brand: '', description: '', richContent: '', barcode: '', color: '', colorName: '',
      packQuantity: '', itemLength: '', video: '', videoCover: '', variants: [] });
    var next = project(clean, info, detail);
    next.attributes = next.editorAttributes;
    function text(id) { var a = next.editorAttributes.find(function (a) { return Number(a.id) === id; }); return a ? fields.text(a) : ''; }
    Object.assign(next.variants[0], { color: text(10096), colorName: text(10097), packQuantity: text(8513), itemLength: text(8415), attributes: next.editorAttributes });
    next.mergedCount = Number(info.model_info && info.model_info.count || local.mergedCount || (typeof local.variants === 'number' ? local.variants : 0));
    return next;
  }
  return { project: project, refresh: refresh, match: match, images: images, measure: measure, mergeAttributes: mergeAttributes, flattenAttributes: flattenAttributes, attributeKey: attributeKey };
});
