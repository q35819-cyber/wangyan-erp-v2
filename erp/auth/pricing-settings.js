'use strict';

const MARKETS = ['俄罗斯', '中国香港'];
const LOGISTICS_SCHEMES = ['', 'FBO', 'FBS', 'FBP', 'rFBS'];
const ROUNDING_RULES = ['rub_integer_up', 'rub_10_up', 'none'];
const DEFAULTS = Object.freeze({
  targetMarginPct: 30,
  defaultCommissionPct: 15,
  damageLossPct: 6,
  advertisingPct: 2,
  market: '俄罗斯',
  logisticsScheme: '',
  roundingRule: 'rub_integer_up'
});

function nullablePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function normalizeStoredPricingSettings(payload) {
  payload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const margin = nullablePercent(payload.targetMarginPct);
  const commission = nullablePercent(payload.defaultCommissionPct);
  const damageLoss = nullablePercent(payload.damageLossPct);
  const advertising = nullablePercent(payload.advertisingPct);
  return {
    targetMarginPct: Number.isFinite(margin) && margin >= 0 && margin < 100 ? margin : DEFAULTS.targetMarginPct,
    defaultCommissionPct: Number.isFinite(commission) && commission >= 0 && commission < 100 ? commission : DEFAULTS.defaultCommissionPct,
    damageLossPct: Number.isFinite(damageLoss) && damageLoss >= 0 && damageLoss < 100 ? damageLoss : DEFAULTS.damageLossPct,
    advertisingPct: Number.isFinite(advertising) && advertising >= 0 && advertising < 100 ? advertising : DEFAULTS.advertisingPct,
    market: MARKETS.includes(String(payload.market || '')) ? String(payload.market) : DEFAULTS.market,
    logisticsScheme: LOGISTICS_SCHEMES.includes(String(payload.logisticsScheme || '')) ? String(payload.logisticsScheme || '') : DEFAULTS.logisticsScheme,
    roundingRule: ROUNDING_RULES.includes(String(payload.roundingRule || '')) ? String(payload.roundingRule) : DEFAULTS.roundingRule
  };
}

function validationError(message, field) {
  const error = new Error(message);
  error.publicCode = 'pricing_settings_invalid';
  error.status = 400;
  error.field = field || '';
  return error;
}

function validatePricingSettingsInput(input) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const marginRaw = nullablePercent(input.targetMarginPct);
  const commissionRaw = nullablePercent(input.defaultCommissionPct);
  const damageLossRaw = nullablePercent(input.damageLossPct);
  const advertisingRaw = nullablePercent(input.advertisingPct);
  const margin = marginRaw === null ? DEFAULTS.targetMarginPct : marginRaw;
  const commission = commissionRaw === null ? DEFAULTS.defaultCommissionPct : commissionRaw;
  const damageLoss = damageLossRaw === null ? DEFAULTS.damageLossPct : damageLossRaw;
  const advertising = advertisingRaw === null ? DEFAULTS.advertisingPct : advertisingRaw;
  if (!(Number.isFinite(margin) && margin >= 0 && margin < 100)) throw validationError('目标利润率必须填写 0 到 100 之间的数值。', 'targetMarginPct');
  if (!(Number.isFinite(commission) && commission >= 0 && commission < 100)) throw validationError('默认平台佣金率必须填写 0 到 100 之间的数值。', 'defaultCommissionPct');
  if (!(Number.isFinite(damageLoss) && damageLoss >= 0 && damageLoss < 100)) throw validationError('货损率必须填写 0 到 100 之间的数值。', 'damageLossPct');
  if (!(Number.isFinite(advertising) && advertising >= 0 && advertising < 100)) throw validationError('广告费率必须填写 0 到 100 之间的数值。', 'advertisingPct');
  if (margin + commission + damageLoss + advertising >= 100) throw validationError('目标利润率、平台佣金率、货损率与广告费率之和必须小于 100%。', 'targetMarginPct');
  const market = String(input.market || DEFAULTS.market);
  if (!MARKETS.includes(market)) throw validationError('目的地区当前只支持俄罗斯或中国香港。', 'market');
  const logisticsScheme = String(input.logisticsScheme || '');
  if (!LOGISTICS_SCHEMES.includes(logisticsScheme)) throw validationError('物流方案不正确，请重新选择。', 'logisticsScheme');
  const roundingRule = String(input.roundingRule || DEFAULTS.roundingRule);
  if (!ROUNDING_RULES.includes(roundingRule)) throw validationError('售价取整规则不正确，请重新选择。', 'roundingRule');
  return { targetMarginPct: margin, defaultCommissionPct: commission, damageLossPct: damageLoss, advertisingPct: advertising, market, logisticsScheme, roundingRule };
}

module.exports = {
  DEFAULTS,
  MARKETS,
  LOGISTICS_SCHEMES,
  ROUNDING_RULES,
  normalizeStoredPricingSettings,
  validatePricingSettingsInput
};