'use strict';

const FALLBACK_RUB_PER_CNY = 12;
const SOURCE_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const CURRENCY_PAIR = 'CNY_RUB';
const USER_FACING = Symbol('user-facing-rate-error');
let dailyCache = null;
let refreshPromise = null;

function shanghaiDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, query: `${parts.day}/${parts.month}/${parts.year}` };
}

function parseCnyRate(xml) {
  const rateDate = String(xml).match(/<ValCurs\b[^>]*\bDate="([^"]+)"/i);
  const blocks = String(xml).match(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/gi) || [];
  const block = blocks.find(value => /<CharCode>\s*CNY\s*<\/CharCode>/i.test(value));
  if (!block) throw Object.assign(new Error('俄罗斯央行当日汇率数据中没有人民币汇率，本次按 1 人民币 = 12 卢布计算。'), { code: 'cny_rate_missing', [USER_FACING]: true });
  const nominalMatch = block.match(/<Nominal>\s*([^<]+)\s*<\/Nominal>/i);
  const valueMatch = block.match(/<Value>\s*([^<]+)\s*<\/Value>/i);
  const nominal = Number(String(nominalMatch && nominalMatch[1] || '').replace(',', '.'));
  const value = Number(String(valueMatch && valueMatch[1] || '').replace(',', '.'));
  const rate = value / nominal;
  if (!(nominal > 0) || !Number.isFinite(rate) || rate <= 0 || rate >= 100) throw Object.assign(new Error('俄罗斯央行当日人民币汇率数值无效，本次按 1 人民币 = 12 卢布计算。'), { code: 'cny_rate_invalid', [USER_FACING]: true });
  return { rate: Math.round(rate * 10000) / 10000, effectiveDate: rateDate ? rateDate[1].split('.').reverse().join('-') : '' };
}

function persistedValue(row, requestedDate) {
  const value = Number(row && row.rate);
  if (!(value > 0) || !Number.isFinite(value)) return null;
  return {
    rate: value,
    requestedDate,
    effectiveDate: String(row.effectiveDate || row.rateDate || requestedDate).slice(0, 10),
    source: String(row.source || 'database'),
    fallback: false,
    persisted: true
  };
}

function fallbackValue(requestedDate, error, previous) {
  const reason = String(error && error.code || 'cny_rate_unavailable').slice(0, 80);
  const message = error && error[USER_FACING] === true ? error.message : '暂时无法连接俄罗斯央行汇率接口，本次按 1 人民币 = 12 卢布计算。';
  const saved = persistedValue(previous, requestedDate);
  if (saved) return { ...saved, source: 'database_previous', fallback: true, stale: true, reason, message };
  return { rate: FALLBACK_RUB_PER_CNY, requestedDate, effectiveDate: requestedDate, source: 'fallback', fallback: true, stale: false, reason, message };
}

async function loadPersistedToday(store, requestedDate) {
  if (!store || typeof store.getSystemExchangeRate !== 'function') return null;
  const row = await store.getSystemExchangeRate(CURRENCY_PAIR, requestedDate);
  return row && row.fetchStatus === 'success' ? persistedValue(row, requestedDate) : null;
}

async function fetchAndPersist(options, requested) {
  const store = options.store || null;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await fetchImpl(`${SOURCE_URL}?date_req=${encodeURIComponent(requested.query)}`, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1', 'User-Agent': 'WangYan-ERP/1.0' },
      signal: controller.signal
    });
    if (!response.ok) throw Object.assign(new Error('俄罗斯央行汇率接口未返回可用数据，本次保留最近一次有效汇率继续计算。'), { code: 'cbr_http_failed', status: response.status });
    const parsed = parseCnyRate(await response.text());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.effectiveDate) || parsed.effectiveDate > requested.iso) {
      throw Object.assign(new Error('俄罗斯央行返回的人民币兑卢布汇率生效日期异常，本次保留最近一次有效汇率继续计算。'), { code: 'cny_rate_effective_date_invalid' });
    }
    if (store && typeof store.saveSystemExchangeRateSuccess === 'function') {
      await store.saveSystemExchangeRateSuccess(CURRENCY_PAIR, requested.iso, parsed.rate, 'bank_of_russia', parsed.effectiveDate);
    }
    const value = { rate: parsed.rate, requestedDate: requested.iso, effectiveDate: parsed.effectiveDate, source: 'bank_of_russia', fallback: false };
    if (store) value.persisted = true;
    return value;
  } catch (error) {
    if (store && typeof store.saveSystemExchangeRateFailure === 'function') {
      await store.saveSystemExchangeRateFailure(CURRENCY_PAIR, requested.iso, String(error && (error.code || error.message) || 'cny_rate_unavailable').slice(0, 500)).catch(() => {});
    }
    const previous = store && typeof store.getLatestSuccessfulExchangeRate === 'function'
      ? await store.getLatestSuccessfulExchangeRate(CURRENCY_PAIR).catch(() => null)
      : null;
    return fallbackValue(requested.iso, error, previous);
  } finally {
    clearTimeout(timer);
  }
}

async function historicalCnyRubRate(options = {}) {
  const requested = shanghaiDate(options.now);
  const store = options.store || null;
  const stored = await loadPersistedToday(store, requested.iso);
  if (stored) return { ...stored, historical: true };
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 8000);
  try {
    const response = await fetchImpl(`${SOURCE_URL}?date_req=${encodeURIComponent(requested.query)}`, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1', 'User-Agent': 'WangYan-ERP/1.0' },
      signal: controller.signal
    });
    if (!response.ok) throw Object.assign(new Error('俄罗斯央行历史汇率接口未返回可用数据。'), { code: 'cbr_history_http_failed', status: response.status });
    const parsed = parseCnyRate(await response.text());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.effectiveDate) || parsed.effectiveDate > requested.iso) {
      throw Object.assign(new Error('俄罗斯央行历史汇率生效日期异常。'), { code: 'cny_history_effective_date_invalid' });
    }
    if (store && typeof store.saveSystemExchangeRateSuccess === 'function') {
      await store.saveSystemExchangeRateSuccess(CURRENCY_PAIR, requested.iso, parsed.rate, 'bank_of_russia', parsed.effectiveDate);
    }
    return { rate: parsed.rate, requestedDate: requested.iso, effectiveDate: parsed.effectiveDate, source: 'bank_of_russia', fallback: false, historical: true, persisted: Boolean(store) };
  } catch (error) {
    if (store && typeof store.saveSystemExchangeRateFailure === 'function') {
      await store.saveSystemExchangeRateFailure(CURRENCY_PAIR, requested.iso, String(error && (error.code || error.message) || 'cny_history_rate_unavailable').slice(0, 500)).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function currentCnyRubRate(options = {}) {
  const requested = shanghaiDate(options.now);
  const cacheable = !options.now && !options.fetchImpl;
  if (cacheable && dailyCache && dailyCache.requestedDate === requested.iso && dailyCache.expiresAt > Date.now()) return { ...dailyCache.value };

  const storedToday = await loadPersistedToday(options.store, requested.iso);
  if (storedToday) {
    if (cacheable) dailyCache = { requestedDate: requested.iso, expiresAt: Number.MAX_SAFE_INTEGER, value: storedToday };
    return { ...storedToday };
  }

  const run = async () => {
    const rechecked = await loadPersistedToday(options.store, requested.iso);
    if (rechecked) return rechecked;
    return fetchAndPersist(options, requested);
  };
  let value;
  if (cacheable) {
    if (!refreshPromise) refreshPromise = run().finally(() => { refreshPromise = null; });
    value = await refreshPromise;
  } else value = await run();

  if (cacheable) {
    const durableToday = value && value.fallback === false;
    dailyCache = { requestedDate: requested.iso, expiresAt: durableToday ? Number.MAX_SAFE_INTEGER : Date.now() + 5 * 60 * 1000, value };
  }
  return { ...value };
}

module.exports = { FALLBACK_RUB_PER_CNY, SOURCE_URL, CURRENCY_PAIR, shanghaiDate, parseCnyRate, historicalCnyRubRate, currentCnyRubRate };
