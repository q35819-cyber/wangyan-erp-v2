/* 网研ERP — 人工输入字段统一清洗规则（浏览器 / Node 共用） */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_INPUT_RULES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeFullWidth(value) {
    return String(value == null ? '' : value).replace(/[！-～]/g, function (character) {
      return String.fromCharCode(character.charCodeAt(0) - 0xFEE0);
    }).replace(/。/g, '.').replace(/　/g, ' ');
  }

  function decimal(value) {
    var input = normalizeFullWidth(value);
    var output = '';
    var hasDot = false;
    var decimalPlaces = 0;
    for (var i = 0; i < input.length; i += 1) {
      var character = input.charAt(i);
      if (/\d/.test(character) && (!hasDot || decimalPlaces < 2)) {
        output += character;
        if (hasDot) decimalPlaces += 1;
      }
      else if (character === '.' && !hasDot) { output += character; hasDot = true; }
    }
    return output;
  }

  function integer(value) {
    var match = normalizeFullWidth(value).match(/\d+/);
    return match ? match[0] : '';
  }

  function orderIdentifier(value) {
    var input = normalizeFullWidth(value).trim();
    input = input.replace(/^\s*(?:采购)?(?:订单编号|订单号|快递单号|物流单号|运单号|货件编号|单号|编号)\s*[:#：-]?\s*/i, '');
    return input.replace(/[^A-Za-z0-9._\/-]/g, '');
  }

  function sanitizeElement(input) {
    if (!input || !input.dataset) return '';
    var kind = input.dataset.inputKind;
    var clean = kind === 'decimal' ? decimal(input.value)
      : kind === 'integer' ? integer(input.value)
      : kind === 'order-id' ? orderIdentifier(input.value) : input.value;
    if (clean !== input.value) input.value = clean;
    return clean;
  }

  function bind(container) {
    if (!container || container.__wyerpInputRulesBound) return;
    container.__wyerpInputRulesBound = true;
    container.addEventListener('input', function (event) {
      if (!event.isComposing) sanitizeElement(event.target);
    });
    container.addEventListener('compositionend', function (event) { sanitizeElement(event.target); });
  }

  return { decimal: decimal, integer: integer, orderIdentifier: orderIdentifier, sanitizeElement: sanitizeElement, bind: bind };
});
