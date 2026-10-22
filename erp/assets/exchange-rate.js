/* 网研ERP — 汇率显示与旧存储口径转换 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_EXCHANGE_RATE = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var FALLBACK_RUB_PER_CNY = 12;

  function rubPerCny(storedCnyPerRub) {
    var value = Number(storedCnyPerRub);
    return isFinite(value) && value > 0 ? 1 / value : FALLBACK_RUB_PER_CNY;
  }

  function cnyPerRub(displayedRubPerCny) {
    var value = Number(displayedRubPerCny);
    return isFinite(value) && value > 0 ? 1 / value : 1 / FALLBACK_RUB_PER_CNY;
  }

  function display(value) {
    var rate = Number(value);
    return (isFinite(rate) && rate > 0 ? rate : FALLBACK_RUB_PER_CNY).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  }

  return {
    FALLBACK_RUB_PER_CNY: FALLBACK_RUB_PER_CNY,
    rubPerCny: rubPerCny,
    cnyPerRub: cnyPerRub,
    display: display
  };
});
