(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_PRODUCT_MODEL_NAME_GENERATOR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function pad(value) { return String(value).padStart(2, '0'); }

  function timestamp(value) {
    var date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('型号名称日期无效');
    return pad(date.getFullYear() % 100) + pad(date.getMonth() + 1) + pad(date.getDate()) + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function randomDigits(random) {
    var draw = typeof random === 'function' ? random : Math.random;
    var output = '';
    for (var index = 0; index < 4; index += 1) {
      var value = Number(draw());
      if (!Number.isFinite(value)) value = 0;
      value = Math.max(0, Math.min(0.9999999999999999, value));
      output += String(Math.floor(value * 10));
    }
    return output;
  }

  function generate(options) {
    options = options || {};
    var time = timestamp(options.date), digits = randomDigits(options.random);
    return { timestamp: time, digits: digits, value: time + digits };
  }

  return { timestamp: timestamp, randomDigits: randomDigits, generate: generate };
});
