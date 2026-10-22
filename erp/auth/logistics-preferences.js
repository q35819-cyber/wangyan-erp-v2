'use strict';

const LOGISTICS_PREFERENCE_POLICY_VERSION = 4;

function reconcileLogisticsPreferences(activeItems, payload) {
  const combinations = new Map();
  for (const config of Array.isArray(activeItems) ? activeItems : []) {
    for (const rule of Array.isArray(config.rules) ? config.rules : []) {
      if (!rule.transportMode) continue;
      const key = [config.provider, rule.scheme, rule.market, rule.group].join('|');
      if (!combinations.has(key)) combinations.set(key, { provider: config.provider, scheme: rule.scheme, market: rule.market, group: rule.group, modes: [] });
      const combination = combinations.get(key);
      if (!combination.modes.includes(rule.transportMode)) combination.modes.push(rule.transportMode);
    }
  }
  const eligibleCombinations = new Map(Array.from(combinations.entries()).filter(([, item]) => item.modes.includes('陆运')));
  const availableSchemes = Array.from(new Set(Array.from(eligibleCombinations.values()).map(item => item.scheme)));
  const source = payload && !Array.isArray(payload) ? payload : { defaults: Array.isArray(payload) ? payload : [] };
  const migrated = Number(source.policyVersion) === LOGISTICS_PREFERENCE_POLICY_VERSION;
  const saved = new Map();
  if (migrated) {
    for (const item of Array.isArray(source.defaults) ? source.defaults : []) {
      const key = [item.provider, item.scheme, item.market, item.group].join('|');
      const combination = eligibleCombinations.get(key);
      if (combination && combination.modes.includes(item.transportMode)) saved.set(key, item.transportMode);
    }
  }
  const defaults = migrated
    ? Array.from(saved.entries()).map(([key, transportMode]) => {
      const item = eligibleCombinations.get(key);
      return { provider: item.provider, scheme: item.scheme, market: item.market, group: item.group, transportMode };
    })
    : Array.from(combinations.values()).filter(item => {
      if (item.provider !== 'CEL' || item.scheme !== 'rFBS') return false;
      return item.group === 'Extra Small' ? item.modes.includes('陆空') : item.modes.includes('陆运');
    }).map(item => ({
      provider: item.provider,
      scheme: 'rFBS',
      market: item.market,
      group: item.group,
      transportMode: item.group === 'Extra Small' ? '陆空' : '陆运'
    }));
  const requestedScheme = String(source.defaultScheme || '');
  const defaultScheme = availableSchemes.includes(requestedScheme) ? requestedScheme : availableSchemes.includes('rFBS') ? 'rFBS' : availableSchemes[0] || '';
  const value = { policyVersion: LOGISTICS_PREFERENCE_POLICY_VERSION, defaultScheme, defaults };
  const sourceDefaults = Array.isArray(source.defaults) ? source.defaults : [];
  const changed = !migrated || requestedScheme !== defaultScheme || sourceDefaults.length !== defaults.length || defaults.some(item => saved.get([item.provider, item.scheme, item.market, item.group].join('|')) !== item.transportMode);
  return { value, changed };
}

module.exports = { LOGISTICS_PREFERENCE_POLICY_VERSION, reconcileLogisticsPreferences };
