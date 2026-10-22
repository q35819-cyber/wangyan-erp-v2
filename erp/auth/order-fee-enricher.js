'use strict';

const mapper = require('../assets/order-sync-map');
const { withRetry } = require('./category-attribute-sync');
const { autoMapUnmappedFees } = require('./order-fee-auto-mapper');
const feeClassifier = require('../assets/order-fee-classification');

function splitAccruals(accruals, types) {
  const typeMap = new Map((Array.isArray(types) ? types : []).filter(Boolean).map(type => [String(type.id), type]));
  const result = { comm: 0, intl: 0, last: 0, return: 0, other: 0, acq: null, items: [], signDate: '', version: 2 };
  let sellerRub = 0;
  const seen = new Set();
  for (const accrual of Array.isArray(accruals) ? accruals : []) {
    const type = typeMap.get(String(accrual && accrual.type_id)) || {};
    const rawName = String(type.name || accrual && (accrual.name || accrual.type_name) || '');
    const rawDescription = String(type.description || accrual && accrual.description || '');
    const name = rawName + ' ' + rawDescription;
    const raw = Number(accrual && accrual.accrued && accrual.accrued.amount);
    if (!Number.isFinite(raw) || raw === 0) continue;
    const stable = accrual && (accrual.id || accrual.accrual_id || accrual.operation_id);
    if (stable != null) {
      const key = 'id:' + stable;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (raw < 0 && accrual.seller_price) {
      const sellerPrice = Number(accrual.seller_price.amount);
      if (sellerPrice > 0) sellerRub += sellerPrice * (Number(accrual.quantity) || 1);
    }
    const amount = -raw;
    let kind = 'other';
    if (String(accrual.type_id) === '66' || /RfbsGlobalAgentFee|Агентское вознаграждение Ozon|Acquiring|Эквайринг/i.test(name)) kind = 'acq';
    else if (String(accrual.type_id) === '9') kind = 'return';
    else if (/sale.?commission|вознаграждение за продажу|комиссия за продажу/i.test(name)) kind = 'comm';
    else if (/международн|international|global.?deliver|global.?agent|логистик|logistic/i.test(name)) kind = 'intl';
    else if (/last.?mile|последн|доставка до места выдачи|выдача товара|экспресс|express|доставка курьером|pickup.?courier/i.test(name)) kind = 'last';
    result[kind] = (result[kind] || 0) + amount;
    result.items.push({ type: accrual.type_id, name: rawName, desc: rawDescription, amount, signedAmount: raw, kind, source: 'ozon_v1_finance_accrual_postings' });
    if (kind === 'comm' && !result.signDate && accrual.accrual_date) result.signDate = String(accrual.accrual_date);
  }
  if (sellerRub > 0) result.sellerRub = Math.round(sellerRub * 100) / 100;
  ['comm','acq','intl','logistics','last','return','advertising','other'].forEach(key => { result[key] = Math.round(result[key] * 100) / 100; });
  return result;
}

function mergeAcquiring(feeMap, acquiring) {
  const keys = Object.keys(feeMap || {});
  for (const [posting, rawAmount] of Object.entries(acquiring || {})) {
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount)) continue;
    const key = feeMap[posting] ? posting : keys.find(candidate => candidate.replace(/-\d+$/, '') === posting);
    if (!key) continue;
    if (feeMap[key].acq != null) continue;
    feeMap[key].acq = amount;
    feeMap[key].items.push({ type: 66, name: 'RfbsGlobalAgentFee', desc: 'Агентское вознаграждение Ozon', amount, signedAmount: -amount, kind: 'acq', source: 'ozon_v1_finance_accrual_postings' });
  }
  return feeMap;
}

function completeCached(value) {
  return Boolean(value && value.version === 2 && Array.isArray(value.items) && Object.prototype.hasOwnProperty.call(value, 'signDate'));
}

function cancellationStatus(status) { return /^(cancelled|not_accepted)/.test(String(status || '')); }

function completeCachedForStatus(value, status) {
  if (!completeCached(value)) return false;
  // 取消/拒收费用可能晚于退仓状态入账。历史空缓存不能永久阻止后续真实财务重查。
  if (cancellationStatus(status) && value.items.length === 0) return false;
  return true;
}

function clearPendingCancellationFees(row) {
  if (!row || typeof row !== 'object') return;
  const finance = row.finance && typeof row.finance === 'object' ? row.finance : (row.finance = {});
  [
    'ozonFeeRub','ozonFee','intlLogisticsRub','intlLogistics','logisticsFeeRub','logisticsFee',
    'advertisingFeeRub','advertisingFee','lastMileRub','lastMile','otherFeeRub','otherFee',
    'returnHandlingFeeRub','returnHandlingFee'
  ].forEach(key => { finance[key] = null; });
  finance.feeItems = [];
  finance.accrualsComplete = false;
  delete finance.settlementSource;
  delete finance.settlementVersion;
}

function createOrderFeeEnricher(options = {}) {
  const request = options.request;
  if (typeof request !== 'function') throw Object.assign(new Error('订单费用补算器未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'order_fee_enricher_invalid' });
  let types = Array.isArray(options.types) && options.types.length ? options.types : null;
  const cache = options.cache && typeof options.cache === 'object' ? { ...options.cache } : {};
  let currentFeeMap = {};
  let acquiring = options.acquiring && typeof options.acquiring === 'object' ? options.acquiring : {};
  const loadAcquiring = typeof options.loadAcquiring === 'function' ? options.loadAcquiring : null;
  const loadVerifiedSellerAccruals = typeof options.loadVerifiedSellerAccruals === 'function' ? options.loadVerifiedSellerAccruals : null;
  const persist = typeof options.persist === 'function' ? options.persist : async () => {};
  const realizationBonus = options.realizationBonus && typeof options.realizationBonus === 'object' ? { ...options.realizationBonus } : {};
  const autoMapEnabled = options.autoMapEnabled === true;
  const account = options.account || null;
  const pool = options.pool || null;
  const writeAudit = options.writeAudit || (async () => {});
  const batchSize = options.batchSize || 10;
  async function call(endpoint, body) { return withRetry(request, endpoint, body, { attempts: 3 }); }
  async function ensureTypes() {
    if (types) return types;
    const data = await call('/v1/finance/accrual/types', {});
    types = Array.isArray(data && data.accrual_types) ? data.accrual_types : [];
    if (!types.length) throw Object.assign(new Error('未能取得Ozon费用类型字典，请稍后重试订单费用补算。'), { code: 'order_fee_types_unavailable' });
    await persist({ types, cache, acquiring, realizationBonus });
    return types;
  }
  function postingMonthKey(posting) {
    var dateStr = (posting.analytics_data && posting.analytics_data.delivery_date_end) || posting.in_process_at || posting.created_at;
    if (!dateStr) return null;
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  async function fetchRealizationBonus(months) {
    for (const key of months) {
      if (realizationBonus[key]) continue;
      const parts = key.split('-');
      const year = Number(parts[0]);
      const month = Number(parts[1]);
      try {
        const data = await call('/v1/finance/realization/posting', { month: month, year: year });
        const rows = Array.isArray(data && data.rows) ? data.rows : (Array.isArray(data && data.result) ? data.result : []);
        const map = {};
        for (const row of rows) {
          const postingNumber = row && row.order && row.order.posting_number ? String(row.order.posting_number) : '';
          if (!postingNumber) continue;
          const dc = row.delivery_commission || {};
          const bonus = Number(dc.bonus || 0);
          if (bonus > 0) map[postingNumber] = Math.round(bonus * 100) / 100;
        }
        realizationBonus[key] = map;
        await persist({ types, cache, acquiring, realizationBonus });
      } catch (error) {
        console.error('[order-fee-enricher] realization/posting ' + key + ' 获取失败:', error.message);
      }
    }
  }
  function buildBonusMap() {
    const map = {};
    for (const key of Object.keys(realizationBonus)) {
      const monthData = realizationBonus[key];
      if (monthData && typeof monthData === 'object') {
        for (const posting of Object.keys(monthData)) {
          map[posting] = monthData[posting];
        }
      }
    }
    return map;
  }
  async function enrich(rows, postings, shop) {
    if (!Array.isArray(rows) || !Array.isArray(postings) || rows.length !== postings.length) throw Object.assign(new Error('订单费用补算的订单与货件记录数量不一致，请重新同步订单后再试。'), { code: 'order_fee_batch_invalid' });
    const finalPostings = postings.filter(posting => posting && posting.posting_number && (posting.status === 'delivered' || /^(cancelled|not_accepted)/.test(String(posting.status || ''))));
    const finalized = finalPostings.map(posting => String(posting.posting_number));
    const delivered = finalized;
    const statusByPosting = new Map(finalPostings.map(posting => [String(posting.posting_number), String(posting.status || '')]));
    if (!finalized.length) return rows;
    await ensureTypes();
    if (loadAcquiring) {
      try {
        const loaded = await loadAcquiring(delivered);
        acquiring = {};
        const loadedCache = loaded && loaded.cache && typeof loaded.cache === 'object' ? loaded.cache : {};
        const loadedOperations = loaded && loaded.operations && typeof loaded.operations === 'object' ? loaded.operations : {};
        for (const number of delivered) {
          const records = loadedOperations[number];
          if (!Array.isArray(records) || !records.some(record => {
            const type = record && record.finance_type || {};
            return String(record && record.type_id) === '66' || /acquir|эквайр|RfbsGlobalAgentFee|Агентское вознаграждение Ozon/i.test(String(type.name || '') + ' ' + String(type.description || ''));
          })) continue;
          if (Object.prototype.hasOwnProperty.call(loadedCache, number)) acquiring[number] = loadedCache[number];
        }
      } catch (error) {
        acquiring = {};
        console.error('[order-fee-enricher] 收单费读取失败:', error.message);
      }
    }
    const missingCancellations = new Set();
    const needed = finalized.filter(number => !completeCachedForStatus(cache[number], statusByPosting.get(number)));
    const newlyFetched = new Set();
    for (let offset = 0; offset < needed.length; offset += 100) {
      const batch = needed.slice(offset, offset + 100);
      const data = await call('/v1/finance/accrual/postings', { posting_numbers: batch });
      const returned = new Map((Array.isArray(data && data.posting_accruals) ? data.posting_accruals : []).filter(item => item && item.posting_number && Array.isArray(item.accruals)).map(item => [String(item.posting_number), item.accruals]));
      batch.forEach(number => {
        if (returned.has(number)) { cache[number] = splitAccruals(returned.get(number), types); newlyFetched.add(number); }
        else if (cancellationStatus(statusByPosting.get(number))) {
          delete cache[number];
          missingCancellations.add(number);
        }
      });
      await persist({ types, cache, acquiring, realizationBonus, shopClientId: shop && shop.clientId || '' });
    }
    const feeMap = {};
    delivered.forEach(number => {
      const stored = cache[number];
      feeMap[number] = completeCached(stored) ? { ...stored, acq: newlyFetched.has(number) ? stored.acq : null,
        items: newlyFetched.has(number) ? stored.items.slice() : stored.items.filter(item => item && item.kind !== 'acq') } : null;
    });
    mergeAcquiring(feeMap, acquiring);
    if (loadVerifiedSellerAccruals) {
      let fallback = null;
      try { fallback = await loadVerifiedSellerAccruals(delivered.filter(number => feeMap[number] && feeMap[number].acq == null)); }
      catch (error) { console.error('[order-fee-enricher] Seller 收单费补充读取失败:', error.message); }
      for (const number of delivered) {
        const fee = feeMap[number], evidence = fallback && fallback[number];
        if (!fee || fee.acq != null || !evidence || String(evidence.posting_number || '') !== number || evidence.source !== 'ozon_accruals_details' || !Array.isArray(evidence.feeItems)) continue;
        const seen = new Set();
        const items = evidence.feeItems.filter(item => {
          if (!item || String(item.type || '').toLowerCase() !== 'agency_fee_ozon' || item.source !== 'ozon_accruals_details' || !Number.isFinite(Number(item.signedAmount))) return false;
          const id = item.id || item.accrual_id || item.operation_id;
          if (id == null) return true;
          if (seen.has(String(id))) return false;
          seen.add(String(id));
          return true;
        });
        if (!items.length) continue;
        fee.acq = Math.round(items.reduce((sum, item) => sum - Number(item.signedAmount), 0) * 100) / 100;
        fee.acqSource = 'ozon_accruals_details';
        fee.items.push(...items.map(item => ({ ...item, kind: 'acq', amount: -Number(item.signedAmount) })));
      }
    }
    currentFeeMap = feeMap;
    const neededMonths = [];
    const seenMonths = new Set();
    postings.forEach(posting => {
      if (!posting || posting.status !== 'delivered') return;
      const key = postingMonthKey(posting);
      if (key && !seenMonths.has(key)) { seenMonths.add(key); if (!realizationBonus[key]) neededMonths.push(key); }
    });
    if (neededMonths.length) await fetchRealizationBonus(neededMonths);
    const bonusMap = buildBonusMap();
    const mapOptions = Object.assign({}, options.mapOptions || {}, { realizationBonus: bonusMap });
    rows.forEach((row, index) => {
      const number = String(postings[index] && postings[index].posting_number || '');
      if (missingCancellations.has(number)) clearPendingCancellationFees(row);
      mapper.applyPosting(row, postings[index], feeMap, mapOptions);
    });

    // 自动检测并翻译未映射的费用
    if (autoMapEnabled && account && pool) {
      try {
        const allFeeItems = [];
        finalized.forEach(number => {
          const fee = cache[number];
          if (fee && Array.isArray(fee.items)) {
            allFeeItems.push(...fee.items);
          }
        });
        
        if (allFeeItems.length) {
          const autoMapResult = await autoMapUnmappedFees(allFeeItems, account, {
            pool,
            writeAudit,
            batchSize
          });
          
          if (autoMapResult.detected > 0) {
            console.log(`[order-fee-enricher] 自动映射结果: 检测到 ${autoMapResult.detected} 个未映射费用, 成功翻译 ${autoMapResult.translated} 个, 持久化 ${autoMapResult.persisted} 个`);
          }
        }
      } catch (error) {
        console.error('[order-fee-enricher] 自动映射失败:', error.message);
        // 不阻断主流程，仅记录错误
      }
    }

    return rows;
  }
  enrich.state = () => {
    const verifiedFeeMap = {};
    for (const [number, stored] of Object.entries(cache)) verifiedFeeMap[number] = completeCached(stored) ? { ...stored, acq: null, items: stored.items.filter(item => item && item.kind !== 'acq') } : null;
    return { types: Array.isArray(types) ? types.slice() : [], cache: { ...cache }, verifiedFeeMap: { ...verifiedFeeMap, ...currentFeeMap }, acquiring: { ...acquiring }, realizationBonus: { ...realizationBonus } };
  };
  return enrich;
}

module.exports = { splitAccruals, mergeAcquiring, completeCached, completeCachedForStatus, clearPendingCancellationFees, createOrderFeeEnricher };
