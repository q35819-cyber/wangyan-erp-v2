(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_PRODUCT_ATTRIBUTE_FIELDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Attribute identities are global; never branch on the currently selected category.
  var ids = {
    '4180': ['field', 'title'], '4191': ['field', 'description'],
    '11254': ['field', 'richContent'], '4497': ['field', 'weight'],
    '4131': ['field', 'barcode'], '9454': ['field', 'length'],
    '9455': ['field', 'width'], '9456': ['field', 'height'],
    '4082': ['dimensions', 'dimensions'],
    '10096': ['variant', 'color'], '10097': ['variant', 'colorName'],
    '21837': ['media', 'videoTitle', '视频标题'],
    '21841': ['media', 'video', '视频链接'],
    '22273': ['media', 'videoProducts', '视频关联商品'],
    '21845': ['media', 'videoCover', '视频封面链接']
  };
  var lengths = ['8415','7332','10231','6889','7956','4065','9762','9360','4566','4601','4611','7444','23003','6004','6680','20660'];
  var quantities = ['8513','4387','4981','4670','7770','9072','7062','9661'];
  lengths.forEach(function (id) { ids[id] = ['variant', 'itemLength']; });
  quantities.forEach(function (id) { ids[id] = ['variant', 'packQuantity']; });
  function classify(attribute) {
    var id = String(attribute.id || attribute.attribute_id || '');
    var match = Object.prototype.hasOwnProperty.call(ids, id) ? ids[id] : null;
    // Exact unit/name aliases cover new IDs without swallowing component dimensions or device video specs.
    if (!match && !Number(attribute.complexId || attribute.complex_id || attribute.attribute_complex_id)) {
      var name = String(attribute.name || '').replace(/\s+/g, '').replace(/,/g, '，').toLowerCase();
      if (/^长度，(?:厘米|cm)$/.test(name)) match = ['variant', 'itemLength'];
      if (/^每包数量，(?:件|个|pcs\.?|шт\.?)$/.test(name)) match = ['variant', 'packQuantity'];
    }
    return match ? { area: match[0], key: match[1], label: match[2] || '' } : null;
  }
  function bindings(attributes) {
    var result = attributes.map(classify), grouped = Object.create(null);
    result.forEach(function (binding, i) {
      if (binding && binding.area === 'dimensions' && text(attributes[i]) && !parseDimensions(text(attributes[i]))) { result[i] = null; return; }
      if (!binding || binding.area !== 'variant') return;
      (grouped[binding.key] || (grouped[binding.key] = [])).push(i);
    });
    // Distinct category attributes cannot safely share one input when both are present.
    Object.keys(grouped).forEach(function (key) {
      if (grouped[key].length > 1) grouped[key].forEach(function (i) { result[i] = null; });
    });
    return result;
  }
  function text(attribute) {
    if (attribute.value != null) return String(attribute.value);
    var values = Array.isArray(attribute.values) ? attribute.values : [];
    return values.map(function (item) {
      var value = item.value == null ? String(item.dictionary_value_id || '') : String(item.value);
      return (attribute.collection || values.length > 1) && /[;；"\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
    }).filter(Boolean).join('; ');
  }
  function splitValues(value) {
    var values = [], part = '', quoted = false;
    for (var i = 0; i < value.length; i++) {
      var character = value[i];
      if (character === '"') {
        if (quoted && value[i + 1] === '"') { part += '"'; i++; }
        else quoted = !quoted;
      } else if (!quoted && (character === ';' || character === '；')) { values.push(part.trim()); part = ''; }
      else part += character;
    }
    if (quoted) return null;
    values.push(part.trim());
    return values.filter(Boolean);
  }
  function shiftDecimal(value, places) {
    var source = String(value).trim().replace(/^\+/, '').replace(/^\./, '0.');
    var match = source.match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match || !Number.isFinite(Number(source)) || Math.abs(Number(match[3] || 0)) > 1000) return null;
    var digits = match[1] + (match[2] || ''), point = match[1].length + places + Number(match[3] || 0);
    if (point <= 0) { digits = '0'.repeat(1 - point) + digits; point = 1; }
    if (point >= digits.length) digits += '0'.repeat(point - digits.length);
    var whole = (digits.slice(0, point) || '0').replace(/^0+(?=\d)/, ''), fraction = digits.slice(point).replace(/0+$/, '');
    return whole + (fraction ? '.' + fraction : '');
  }
  function parseDimensions(value) {
    var parts = String(value).split(/[xх×*]/i).map(function (part) { return shiftDecimal(part, 1); });
    return parts.length === 3 && parts.every(function (part) { return part !== null; }) ? { length: parts[0], width: parts[1], height: parts[2] } : null;
  }
  function formatDimensions(value) {
    var parts = ['length','width','height'].map(function (key) { return shiftDecimal(value[key], -1); });
    return parts.every(function (part) { return part !== null; }) ? parts.join('x') : null;
  }
  function setText(attribute, value) {
    value = String(value == null ? '' : value);
    if (text(attribute) === value) return;
    attribute.value = value;
    if (Array.isArray(attribute.values)) {
      var old = attribute.values;
      var values = value ? (attribute.collection || old.length > 1 ? splitValues(value) || [value] : [value]) : [];
      attribute.values = values.map(function (v) {
        var same = old.find(function (item) { return String(item.value == null ? item.dictionary_value_id || '' : item.value) === v; });
        return same ? Object.assign({}, same) : { value: v };
      });
    }
  }
  return { classify: classify, bindings: bindings, text: text, setText: setText, parseDimensions: parseDimensions, formatDimensions: formatDimensions };
});
