(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_PRODUCT_VARIANT_PRICING = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function number(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  function requiredNumber(value) {
    if (value === null || value === undefined || value === '') return NaN;
    return number(value);
  }
  function roundMoney(value) { return Math.round(Number(value) * 100) / 100; }
  function roundPrice(value, rule) {
    var amount = number(value);
    if (!(amount >= 0)) return NaN;
    if (rule === 'rub_10_up') return Math.ceil((amount - 1e-9) / 10) * 10;
    if (rule === 'none') return roundMoney(amount);
    return Math.ceil(amount - 1e-9);
  }
  function missingLabel(code) {
    return {
      weightG: '商品重量',
      lengthMm: '包装长度',
      widthMm: '包装宽度',
      heightMm: '包装高度'
    }[code] || '包装参数';
  }
  function calculate(input, deps) {
    input = input || {}; deps = deps || {};
    var settings = input.settings || {};
    var margin = requiredNumber(settings.targetMarginPct), commission = requiredNumber(input.commissionPct != null ? input.commissionPct : settings.defaultCommissionPct);
    var damageLossPct = number(settings.damageLossPct == null ? 6 : settings.damageLossPct), advertisingPct = number(settings.advertisingPct == null ? 2 : settings.advertisingPct);
    if (!Number.isFinite(margin)) return { ok:false, error:'pricing_margin_missing', message:'未配置目标利润率' };
    if (!Number.isFinite(commission)) return { ok:false, error:'pricing_commission_missing', message:'未配置默认平台佣金率' };
    if (margin < 0 || commission < 0 || damageLossPct < 0 || advertisingPct < 0 || margin + commission + damageLossPct + advertisingPct >= 100) return { ok:false, error:'pricing_rate_invalid', message:'目标利润率、平台佣金率、货损率与广告费率配置不正确' };

    var costTotal = number(input.costTotal);
    if (!(costTotal > 0)) return { ok:false, error:'purchase_cost_missing', message:'采购总成本缺失或为0' };

    if (!deps.quoteModel || !deps.calculator) throw new Error('商品规格定价缺少必要计算组件。');
    var quote = deps.quoteModel.quote(input.logisticsConfig || {}, {
      weightG: input.weightG,
      lengthMm: input.lengthMm,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      market: settings.market || '俄罗斯',
      scheme: settings.logisticsScheme || ''
    });
    if (!quote.ok) {
      if (quote.error === 'missing_package_data') return {
        ok:false,
        error:'package_data_missing',
        missing:quote.missing || [],
        message:'缺少' + (quote.missing || []).map(missingLabel).join('、')
      };
      return { ok:false, error:'logistics_no_match', message:'重量/尺寸没有匹配到可用国际物流' };
    }

    var pricing = deps.calculator.pricing({
      cost: costTotal,
      domestic: 0,
      shipping: quote.recommended.freightCny,
      commission: commission,
      margin: margin,
      damageLossPct: damageLossPct,
      advertisingPct: advertisingPct
    });
    if (!pricing || pricing.error) return { ok:false, error:'pricing_formula_failed', message:pricing && pricing.error || '定价公式计算失败' };

    var rawCny = number(pricing.price);
    var roundingRule = settings.roundingRule || 'rub_integer_up';
    var minimumCny = roundPrice(rawCny, roundingRule);
    var saleCny = roundPrice(minimumCny * 1.5, roundingRule);
    var oldCny = roundPrice(saleCny * 2, roundingRule);
    if (!(minimumCny > 0 && saleCny > minimumCny && oldCny > saleCny)) return { ok:false, error:'pricing_result_invalid', message:'最低价、销售价或划线价结果不正确' };

    return {
      ok:true,
      costTotalCny:roundMoney(costTotal),
      internationalFreightCny:roundMoney(quote.recommended.freightCny),
      commissionPct:commission,
      commissionSource:input.commissionSource || 'default_setting',
      targetMarginPct:margin,
      damageLossPct:damageLossPct,
      advertisingPct:advertisingPct,
      damageLossCny:roundMoney(pricing.damageLossCost || 0),
      advertisingCny:roundMoney(pricing.advertisingCost || 0),
      priceCny:roundMoney(pricing.price),
      rawPriceCny:roundMoney(rawCny),
      minimumCny:minimumCny,
      saleCny:saleCny,
      oldCny:oldCny,
      roundingRule:roundingRule,
      logistics:quote.recommended,
      logisticsCandidates:quote.candidates || []
    };
  }

  function explain(result, quoteModel) {
    if (!result || !result.ok) return result && result.message || '';
    var freight = quoteModel && quoteModel.describe ? quoteModel.describe(result.logistics) : '';
    return '采购总成本 ¥' + result.costTotalCny.toFixed(2)
      + '；国际运费 ¥' + result.internationalFreightCny.toFixed(2)
      + '；默认佣金 ' + result.commissionPct + '%'
      + '；目标利润率 ' + result.targetMarginPct + '%'
      + '；货损率 ' + result.damageLossPct + '%'
      + '；广告费率 ' + result.advertisingPct + '%'
      + '；最低价 ¥' + result.minimumCny
      + '；销售价 ¥' + result.saleCny + '（最低价×1.5）'
      + '；划线价 ¥' + result.oldCny + '（销售价×2）'
      + (freight ? '；' + freight : '');
  }

  return { calculate:calculate, roundPrice:roundPrice, roundRub:roundPrice, explain:explain, missingLabel:missingLabel };
});
