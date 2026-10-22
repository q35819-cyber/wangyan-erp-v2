(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_PRODUCT_ARTICLE_GENERATOR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function pad(value, width) { return String(value).padStart(width, '0'); }

  function datePart(value) {
    var date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) throw new TypeError('货号日期无效');
    return String(date.getFullYear()) + pad(date.getMonth() + 1, 2) + pad(date.getDate(), 2);
  }

  function randomLetters(random) {
    var draw = typeof random === 'function' ? random : Math.random;
    var output = '';
    for (var index = 0; index < 4; index += 1) {
      var value = Number(draw());
      if (!Number.isFinite(value)) value = 0;
      value = Math.max(0, Math.min(0.9999999999999999, value));
      output += ALPHABET.charAt(Math.floor(value * ALPHABET.length));
    }
    return output;
  }

  function generate(count, options) {
    options = options || {};
    count = Number(count);
    if (!Number.isInteger(count) || count < 1 || count > 9999) throw new RangeError('变体数量必须是 1 到 9999');
    var day = datePart(options.date), letters = randomLetters(options.random), values = [];
    for (var index = 1; index <= count; index += 1) values.push('wy-' + day + '-' + letters + '-' + pad(index, 4));
    return { date: day, letters: letters, values: values };
  }

  return { datePart: datePart, randomLetters: randomLetters, generate: generate };
});
