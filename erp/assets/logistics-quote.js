(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_LOGISTICS_QUOTE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  function round(value, digits) {
    var scale = Math.pow(10, digits == null ? 6 : digits);
    return Math.round(Number(value) * scale) / scale;
  }
  function roundUp(value, increment) {
    var inc = num(increment);
    if (!(inc > 0)) inc = 0.001;
    return round(Math.ceil((Number(value) - 1e-12) / inc) * inc, 6);
  }
  function packageInput(input) {
    input = input || {};
    var weightG = num(input.weightG), lengthMm = num(input.lengthMm), widthMm = num(input.widthMm), heightMm = num(input.heightMm);
    var missing = [];
    if (!(weightG > 0)) missing.push('weightG');
    if (!(lengthMm > 0)) missing.push('lengthMm');
    if (!(widthMm > 0)) missing.push('widthMm');
    if (!(heightMm > 0)) missing.push('heightMm');
    if (missing.length) return { error: 'missing_package_data', missing: missing };
    var dimsCm = [lengthMm, widthMm, heightMm].map(function (v) { return v / 10; });
    return {
      weightG: weightG,
      actualKg: weightG / 1000,
      lengthMm: lengthMm,
      widthMm: widthMm,
      heightMm: heightMm,
      dimensionsCm: dimsCm,
      maxSideCm: Math.max.apply(Math, dimsCm),
      sumCm: dimsCm.reduce(function (sum, value) { return sum + value; }, 0),
      volumeCm3: dimsCm.reduce(function (value, side) { return value * side; }, 1)
    };
  }
  function conditionalThreshold(billing) {
    var text = String(billing && billing.condition || '');
    var match = text.match(/三边(?:之)?和(?:超过|大于|>)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:cm|厘米)?/i);
    return match ? Number(match[1]) : 60;
  }
  function chargeableWeight(rule, pkg) {
    var billing = rule && rule.billing || {};
    var mode = String(billing.mode || 'actual');
    var divisor = num(billing.divisor);
    var volumeKg = divisor > 0 ? pkg.volumeCm3 / divisor : null;
    var baseKg = pkg.actualKg;
    var volumetricApplied = false;
    if (mode === 'volumetric') {
      if (!(volumeKg >= 0)) return { error: 'invalid_volume_divisor' };
      baseKg = Math.max(pkg.actualKg, volumeKg);
      volumetricApplied = volumeKg > pkg.actualKg;
    } else if (mode === 'conditional_volume') {
      if (!(volumeKg >= 0)) return { error: 'invalid_volume_divisor' };
      if (pkg.sumCm > conditionalThreshold(billing)) {
        baseKg = Math.max(pkg.actualKg, volumeKg);
        volumetricApplied = volumeKg > pkg.actualKg;
      }
    }
    var incrementKg = rule && rule.rate && num(rule.rate.incrementKg);
    var billedKg = roundUp(baseKg, incrementKg > 0 ? incrementKg : 0.001);
    return {
      actualKg: round(pkg.actualKg, 6),
      volumeKg: volumeKg == null ? null : round(volumeKg, 6),
      baseKg: round(baseKg, 6),
      billedKg: billedKg,
      incrementKg: incrementKg > 0 ? incrementKg : 0.001,
      mode: mode,
      volumetricApplied: volumetricApplied
    };
  }
  function within(value, range) {
    if (!range) return true;
    var min = num(range.min), max = num(range.max);
    if (Number.isFinite(min) && value + 1e-9 < min) return false;
    if (Number.isFinite(max) && value - 1e-9 > max) return false;
    return true;
  }
  function dimensionsAllowed(rule, pkg) {
    var limits = rule && rule.dimensions || {};
    var maxSide = num(limits.maxSideCm), maxSum = num(limits.maxSumCm);
    if (Number.isFinite(maxSide) && pkg.maxSideCm - 1e-9 > maxSide) return false;
    if (Number.isFinite(maxSum) && pkg.sumCm - 1e-9 > maxSum) return false;
    return true;
  }
  function preferenceMatches(preferences, item, rule) {
    if (!Array.isArray(preferences) || !preferences.length) return true;
    return preferences.some(function (pref) {
      return String(pref && pref.provider || '').toUpperCase() === String(item && item.provider || rule && rule.provider || '').toUpperCase()
        && String(pref && pref.scheme || '') === String(rule && rule.scheme || '')
        && String(pref && pref.market || '') === String(rule && rule.market || '')
        && String(pref && pref.group || '') === String(rule && rule.group || '')
        && String(pref && pref.transportMode || '') === String(rule && rule.transportMode || '');
    });
  }
  function quoteRule(item, rule, pkg, preferences, options) {
    options = options || {};
    if (!item || item.active === false || !rule) return null;
    var scheme = String(options.scheme || ''), market = String(options.market || '');
    if (scheme && String(rule.scheme || '') !== scheme) return null;
    if (market && String(rule.market || '') !== market) return null;
    if (!preferenceMatches(preferences, item, rule)) return null;
    if (!dimensionsAllowed(rule, pkg)) return null;
    var weight = chargeableWeight(rule, pkg);
    if (weight.error || !within(weight.billedKg, rule.weightKg)) return null;
    var perKg = rule.rate && num(rule.rate.perKg), fixed = rule.rate && num(rule.rate.fixed);
    if (!(perKg >= 0)) return null;
    if (!(fixed >= 0)) fixed = 0;
    var freightCny = round(fixed + weight.billedKg * perKg, 2);
    return {
      itemId: String(item.id || ''),
      provider: String(item.provider || rule.provider || ''),
      scheme: String(rule.scheme || ''),
      market: String(rule.market || ''),
      group: String(rule.group || ''),
      channel: String(rule.channel || ''),
      transport: String(rule.transport || ''),
      transportMode: String(rule.transportMode || ''),
      eta: String(rule.eta || ''),
      freightCny: freightCny,
      fixedCny: fixed,
      perKgCny: perKg,
      actualKg: weight.actualKg,
      volumeKg: weight.volumeKg,
      baseKg: weight.baseKg,
      billedKg: weight.billedKg,
      incrementKg: weight.incrementKg,
      billingMode: weight.mode,
      volumetricApplied: weight.volumetricApplied,
      ruleId: String(rule.id || ''),
      sourceRow: rule.sourceRow == null ? null : Number(rule.sourceRow)
    };
  }
  function quote(config, input) {
    config = config || {}; input = input || {};
    var pkg = packageInput(input);
    if (pkg.error) return { ok: false, error: pkg.error, missing: pkg.missing, candidates: [] };
    var scheme = String(input.scheme || config.defaultScheme || '');
    var market = String(input.market || '俄罗斯');
    var preferences = Array.isArray(config.preferences) ? config.preferences : [];
    var items = (Array.isArray(config.items) ? config.items : []).filter(function (item) { return item && item.active !== false; });
    var candidates = [];
    items.forEach(function (item) {
      (Array.isArray(item.rules) ? item.rules : []).forEach(function (rule) {
        var candidate = quoteRule(item, rule, pkg, preferences, { scheme: scheme, market: market });
        if (candidate) candidates.push(candidate);
      });
    });
    candidates.sort(function (a, b) {
      return a.freightCny - b.freightCny || a.billedKg - b.billedKg || a.provider.localeCompare(b.provider);
    });
    if (!candidates.length) return { ok: false, error: 'no_logistics_match', package: pkg, scheme: scheme, market: market, candidates: [] };
    return { ok: true, package: pkg, scheme: scheme, market: market, recommended: candidates[0], candidates: candidates };
  }
  function describe(candidate) {
    if (!candidate) return '';
    var parts = [candidate.provider, candidate.scheme, candidate.group, candidate.transportMode || candidate.transport, candidate.channel].filter(Boolean);
    return parts.join(' · ') + ' · 计费重 ' + Number(candidate.billedKg).toFixed(3).replace(/0+$/,'').replace(/\.$/,'') + 'kg · ¥' + Number(candidate.freightCny).toFixed(2);
  }
  return {
    packageInput: packageInput,
    conditionalThreshold: conditionalThreshold,
    chargeableWeight: chargeableWeight,
    quoteRule: quoteRule,
    quote: quote,
    describe: describe,
    roundUp: roundUp
  };
});
