(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_COMMERCE_CALCULATORS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function n(value) { value = Number(value); return Number.isFinite(value) ? value : NaN; }
  function pricing(input) {
    var cost = n(input.cost), domestic = n(input.domestic), shipping = n(input.shipping);
    var commission = n(input.commission), margin = n(input.margin), cnyPerRub = n(input.cnyPerRub);
    var damageLossPct = n(input.damageLossPct == null ? 0 : input.damageLossPct), advertisingPct = n(input.advertisingPct == null ? 0 : input.advertisingPct);
    if ([cost, domestic, shipping, commission, margin, damageLossPct, advertisingPct].some(function (v) { return !Number.isFinite(v) || v < 0; })) return { error: '请输入有效的非负数' };
    var denominator = 1 - commission / 100 - damageLossPct / 100 - advertisingPct / 100 - margin / 100;
    if (denominator <= 0) return { error: '佣金率、货损率、广告费率与目标毛利率之和必须小于 100%' };
    var base = cost + domestic + shipping, price = base / denominator;
    var commissionCost = price * commission / 100, damageLossCost = price * damageLossPct / 100, advertisingCost = price * advertisingPct / 100;
    var profit = price - base - commissionCost - damageLossCost - advertisingCost;
    return { price: price, priceRub: cnyPerRub > 0 ? price / cnyPerRub : null, profit: profit, margin: price > 0 ? profit / price * 100 : 0, commissionCost: commissionCost, damageLossCost: damageLossCost, advertisingCost: advertisingCost, damageLossPct: damageLossPct, advertisingPct: advertisingPct };
  }
  function profit(input) {
    var price = n(input.price), cost = n(input.cost), domestic = n(input.domestic || 0), shipping = n(input.shipping), commission = n(input.commission);
    var refund = n(input.refund), quantity = n(input.quantity), ads = n(input.ads || 0), other = n(input.other || 0);
    var damageLossPct = n(input.damageLossPct == null ? 0 : input.damageLossPct), advertisingPct = n(input.advertisingPct == null ? 0 : input.advertisingPct);
    if ([price, cost, domestic, shipping, commission, refund, quantity, ads, other, damageLossPct, advertisingPct].some(function (v) { return !Number.isFinite(v) || v < 0; })) return { error: '请输入有效的非负数' };
    if ([commission, refund, damageLossPct, advertisingPct].some(function (v) { return v > 100; })) return { error: '比例不能超过 100%' };
    var damageLoss = price * damageLossPct / 100, advertising = price * advertisingPct / 100;
    var unit = price - cost - domestic - shipping - price * commission / 100 - damageLoss - advertising - ads - other;
    var monthly = unit * quantity;
    var afterRefund = monthly - price * refund / 100 * quantity;
    return { unit: unit, monthly: monthly, afterRefund: afterRefund, yearly: afterRefund * 12, margin: price > 0 ? unit / price * 100 : 0, damageLoss: damageLoss, advertising: advertising, damageLossPct: damageLossPct, advertisingPct: advertisingPct };
  }
  return { pricing: pricing, profit: profit };
});
