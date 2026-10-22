'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const BANDS = [
  { id: 'upTo1500Rub', minExclusive: null, maxInclusive: 1500 },
  { id: 'from1500To5000Rub', minExclusive: 1500, maxInclusive: 5000 },
  { id: 'above5000Rub', minExclusive: 5000, maxInclusive: null }
];
const SUPPORTED_SCHEMES = ['RFBS', 'FBP', 'FBO', 'FBS'];

function text(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }
function normalize(value) { return text(value).toLocaleLowerCase('ru-RU').replace(/[\s,，、/\\-]+/g, ''); }
function pair(a, b) { return normalize(a) + '\u001f' + normalize(b); }
function finitePercent(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.').replace('%', '').trim());
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Number((parsed <= 1 ? parsed * 100 : parsed).toFixed(4));
}
function rateTriplet(row, startColumn = 11) {
  return {
    upTo1500Rub: finitePercent(row.getCell(startColumn).value),
    from1500To5000Rub: finitePercent(row.getCell(startColumn + 1).value),
    above5000Rub: finitePercent(row.getCell(startColumn + 2).value)
  };
}
function sameRates(a, b) { return BANDS.every(band => a[band.id] === b[band.id]); }
function sameAllSchemeRates(a, b) {
  return sameRates(a.ratesByScheme.RFBS, b.ratesByScheme.RFBS) && sameRates(a.ratesByScheme.FBP, b.ratesByScheme.FBP);
}
function indexPush(map, key, value) { if (key) map.set(key, (map.get(key) || []).concat(value)); }

function categoryLeaves(tree, localizedCategories = {}) {
  const output = [];
  for (const l1 of Array.isArray(tree) ? tree : []) for (const l2 of Array.isArray(l1.children) ? l1.children : []) {
    for (const l3 of Array.isArray(l2.children) ? l2.children : []) {
      const key = String(l2.id) + ':' + String(l3.id);
      const localized = localizedCategories[key];
      const cnPath = localized && Array.isArray(localized.path)
        ? localized.path.map(item => text(item && item.name)).filter(Boolean) : [];
      output.push({
        key, descriptionCategoryId: String(l2.id), typeId: String(l3.id),
        ruPath: [l1.ru || l1.name, l2.ru || l2.name, l3.ru || l3.name].map(text), cnPath
      });
    }
  }
  return output;
}

async function readSource(workbookPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const sheet = workbook.getWorksheet('Full ChinaHK');
  if (!sheet) throw Object.assign(new Error('佣金表里找不到该类目对应的费率列，请联系系统管理员更新佣金表后再试。'), { code: 'commission_sheet_missing' });
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 3 || !text(row.getCell(1).value)) return;
    rows.push({
      rowNumber,
      ruType: text(row.getCell(1).value), cnType: text(row.getCell(2).value),
      ruCategory: text(row.getCell(4).value), cnCategory: text(row.getCell(5).value),
      ruMarketplaceCategory: text(row.getCell(7).value), cnMarketplaceCategory: text(row.getCell(8).value),
      brand: text(row.getCell(10).value) || 'All', rates: rateTriplet(row, 11),
      ratesByScheme: { RFBS: rateTriplet(row, 11), FBP: rateTriplet(row, 14) }
    });
  });
  return { sheetName: sheet.name, rows };
}

function createIndexes(rows) {
  const baseRows = rows.filter(row => normalize(row.brand) === 'all');
  const indexes = { ruPair: new Map(), cnPair: new Map(), ruType: new Map(), cnType: new Map(), second: new Map(), allPair: new Map() };
  for (const row of baseRows) {
    indexPush(indexes.ruPair, pair(row.ruCategory, row.ruType), row);
    indexPush(indexes.cnPair, pair(row.cnCategory, row.cnType), row);
    indexPush(indexes.ruType, normalize(row.ruType), row);
    indexPush(indexes.cnType, normalize(row.cnType), row);
    indexPush(indexes.second, normalize(row.ruCategory), row);
  }
  for (const row of rows) indexPush(indexes.allPair, pair(row.ruCategory, row.ruType), row);
  return indexes;
}

function unique(map, key) { const values = key ? map.get(key) || [] : []; return values.length === 1 ? values[0] : null; }
function matchLeaf(leaf, indexes) {
  const cn2 = leaf.cnPath[1] || '', cn3 = leaf.cnPath[2] || '';
  let row = unique(indexes.ruPair, pair(leaf.ruPath[1], leaf.ruPath[2]));
  if (row) return { row, method: 'exact_ru_category_and_type' };
  row = unique(indexes.cnPair, pair(cn2, cn3));
  if (row) return { row, method: 'exact_cn_category_and_type' };
  row = unique(indexes.ruType, normalize(leaf.ruPath[2]));
  if (row) return { row, method: 'unique_ru_type' };
  row = unique(indexes.cnType, normalize(cn3));
  if (row) return { row, method: 'unique_cn_type' };
  const second = indexes.second.get(normalize(leaf.ruPath[1])) || [];
  if (second.length && second.every(candidate => sameAllSchemeRates(candidate, second[0]))) {
    return { row: second[0], method: 'homogeneous_second_level' };
  }
  return null;
}

function brandExceptions(row, indexes) {
  return (indexes.allPair.get(pair(row.ruCategory, row.ruType)) || [])
    .filter(item => normalize(item.brand) !== 'all')
    .map(item => ({ brand: item.brand, rates: item.rates, ratesByScheme: item.ratesByScheme, sourceRow: item.rowNumber }));
}

async function buildBase(options) {
  const treeDocument = JSON.parse(await fs.promises.readFile(options.treePath, 'utf8'));
  const localizedDocument = JSON.parse(await fs.promises.readFile(options.localizedCatalogPath, 'utf8'));
  const source = await readSource(options.workbookPath);
  const indexes = createIndexes(source.rows);
  const categories = {}, unmatched = {};
  const methods = {};
  for (const leaf of categoryLeaves(treeDocument.tree, localizedDocument.categories || {})) {
    const match = matchLeaf(leaf, indexes);
    if (!match) { unmatched[leaf.key] = { ...leaf, reason: 'source_type_not_safely_matched' }; continue; }
    methods[match.method] = (methods[match.method] || 0) + 1;
    categories[leaf.key] = {
      ...leaf, schemes: SUPPORTED_SCHEMES, scheme: 'rFBS', rates: match.row.rates,
      ratesByScheme: { ...match.row.ratesByScheme, FBO: {}, FBS: {} },
      effectiveRates: { ...match.row.rates }, effectiveRatesByScheme: {
        RFBS: { ...match.row.ratesByScheme.RFBS }, FBP: { ...match.row.ratesByScheme.FBP }, FBO: {}, FBS: {}
      },
      match: match.method, sourceRow: match.row.rowNumber,
      sourcePath: [match.row.ruMarketplaceCategory, match.row.ruCategory, match.row.ruType],
      brandExceptions: brandExceptions(match.row, indexes), observations: []
    };
  }
  const hash = crypto.createHash('sha256').update(await fs.promises.readFile(options.workbookPath)).digest('hex').toUpperCase();
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    schemes: SUPPORTED_SCHEMES, scheme: 'rFBS', priceCurrency: 'RUB', bands: BANDS,
    source: { workbook: path.basename(options.workbookPath), sha256: hash, sheet: source.sheetName, rows: source.rows.length },
    priority: ['Ozon product commissions.percent for the exact product', 'observed category rate for the same RUB price band', 'China/HK official workbook base rate'],
    counts: {
      localCategories: Object.keys(categories).length + Object.keys(unmatched).length,
      mapped: Object.keys(categories).length + Object.keys(unmatched).length,
      withCommission: Object.keys(categories).length,
      commissionPending: Object.keys(unmatched).length,
      matched: Object.keys(categories).length, unmatched: Object.keys(unmatched).length, methods
    },
    categories, unmatched
  };
}

function normalizeSchema(value) { return text(value).toUpperCase().replace(/[\s_-]+/g, ''); }
function rubPrice(product, cnyPerRub) {
  const value = Number(product.pricePromo != null && product.pricePromo !== '' ? product.pricePromo : product.priceSell);
  if (!Number.isFinite(value) || value <= 0) return null;
  const currency = text(product.priceCurrency).toUpperCase();
  if (currency === 'RUB') return value;
  const rate = Number(cnyPerRub) > 0 ? Number(cnyPerRub) : 1 / 12;
  if (currency === 'CNY' && Number.isFinite(rate) && rate > 0) return value / rate;
  return null;
}
function bandForRub(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value <= 1500) return 'upTo1500Rub';
  if (value <= 5000) return 'from1500To5000Rub';
  return 'above5000Rub';
}
function productObservation(product, cnyPerRub, now) {
  const scheme = normalizeSchema(product && product.commissionSchema);
  if (!scheme) return null;
  const commissionPercent = finitePercent(product && product.commissionPercent);
  const descriptionCategoryId = text(product && (product.descriptionCategoryId || product.description_category_id));
  const typeId = text(product && (product.typeId || product.type_id));
  if (commissionPercent == null || !/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) return null;
  const priceRub = rubPrice(product, cnyPerRub);
  const band = bandForRub(priceRub);
  if (!band) return null;
  return {
    key: descriptionCategoryId + ':' + typeId, descriptionCategoryId, typeId,
    scheme, commissionPercent, band, priceRub: Number(priceRub.toFixed(4)),
    observedAt: now, source: 'Ozon /v3/product/info/list commissions.percent'
  };
}
function effectivePercentForProduct(catalog, product, cnyPerRub) {
  const descriptionCategoryId = text(product && (product.descriptionCategoryId || product.description_category_id));
  const typeId = text(product && (product.typeId || product.type_id));
  const category = catalog && catalog.categories && catalog.categories[descriptionCategoryId + ':' + typeId];
  if (!category) return null;
  const priceRub = rubPrice(product, cnyPerRub);
  const band = bandForRub(priceRub);
  if (!band) return null;
  const brand = normalize(product && product.brand);
  const scheme = normalizeSchema(product && (product.commissionSchema || product.fulfillmentSchema || product.rfbs)) || 'RFBS';
  const exception = brand && (category.brandExceptions || []).find(item => normalize(item.brand) === brand);
  const exceptionRates = exception && exception.ratesByScheme && exception.ratesByScheme[scheme] || (scheme === 'RFBS' && exception && exception.rates);
  const schemeRates = category.effectiveRatesByScheme && category.effectiveRatesByScheme[scheme];
  const value = exceptionRates ? exceptionRates[band] : schemeRates ? schemeRates[band] : scheme === 'RFBS' && category.effectiveRates ? category.effectiveRates[band] : null;
  return finitePercent(value);
}

function categoryReferenceForProduct(catalog, product) {
  const categoryInfo = product && product.categoryInfo || {};
  const fullIds = Array.isArray(categoryInfo.fullCategoryId) ? categoryInfo.fullCategoryId : [];
  const category = categoryInfo.category && typeof categoryInfo.category === 'object' ? categoryInfo.category : {};
  const descriptionCategoryId = text(product && (product.descriptionCategoryId || product.description_category_id))
    || text(fullIds.length > 1 ? fullIds[fullIds.length - 2] : category.pid).split('_').pop();
  const typeId = text(product && (product.typeId || product.type_id))
    || text(fullIds.length ? fullIds[fullIds.length - 1] : (category.typeId || category.id)).split('_').pop();
  const item = catalog && catalog.categories && catalog.categories[descriptionCategoryId + ':' + typeId];
  if (!item) return null;
  const fulfillment = Array.isArray(product && product.fulfillment) ? product.fulfillment[0] : product && product.fulfillment;
  const scheme = normalizeSchema(product && (product.commissionSchema || product.fulfillmentSchema || fulfillment));
  const brand = normalize(product && (product.brandName || product.brand));
  const exception = brand && (item.brandExceptions || []).find(value => normalize(value.brand) === brand);
  const exceptionRates = exception && exception.ratesByScheme && exception.ratesByScheme[scheme]
    || (scheme === 'RFBS' && exception && exception.rates);
  const schemeRates = item.effectiveRatesByScheme && item.effectiveRatesByScheme[scheme];
  const sourceRates = exceptionRates || schemeRates || {};
  const rates = Object.fromEntries(BANDS.map(band => [band.id, finitePercent(sourceRates[band.id])]).filter(([, value]) => value != null));
  return {
    key: item.key,
    descriptionCategoryId,
    typeId,
    cnPath: Array.isArray(item.cnPath) ? item.cnPath.map(text).filter(Boolean) : [],
    ruPath: Array.isArray(item.ruPath) ? item.ruPath.map(text).filter(Boolean) : [],
    scheme: SUPPORTED_SCHEMES.includes(scheme) ? scheme : '',
    rates,
    bands: Array.isArray(catalog.bands) ? catalog.bands : BANDS,
    source: catalog.source || {},
    match: item.match || '',
    brandException: exception ? text(exception.brand) : ''
  };
}

function enrichProductsFromCatalog(catalog, products, cnyPerRub) {
  let supplemented = 0;
  const output = (Array.isArray(products) ? products : []).map(product => {
    const current = finitePercent(product && product.commissionPercent);
    if (current != null && normalizeSchema(product.commissionSchema) === 'RFBS') return product;
    const percent = effectivePercentForProduct(catalog, product, cnyPerRub);
    if (percent == null) return product;
    supplemented += 1;
    const scheme = normalizeSchema(product && (product.commissionSchema || product.fulfillmentSchema || product.rfbs)) || 'RFBS';
    return { ...product, commissionSchema: scheme === 'RFBS' ? 'rFBS' : scheme, commissionPercent: percent, commissionSource: 'system_category_catalog' };
  });
  return { products: output, supplemented };
}
function refreshObservedRates(category) {
  category.observedRatesByScheme = {};
  category.observationConflictsByScheme = {};
  const schemes = [...new Set((category.observations || []).map(item => item.scheme || 'RFBS').concat(Object.keys(category.ratesByScheme || {})))];
  category.effectiveRatesByScheme = {};
  for (const scheme of schemes) {
    const observed = category.observedRatesByScheme[scheme] = {};
    const conflicts = category.observationConflictsByScheme[scheme] = {};
    for (const band of BANDS) {
      const inBand = (category.observations || []).filter(item => (item.scheme || 'RFBS') === scheme && item.band === band.id);
      const settled = inBand.filter(item => item.settledOrder === true);
      const preferred = settled.length ? settled : inBand;
      const values = [...new Set(preferred.map(item => item.commissionPercent))];
      if (values.length === 1) observed[band.id] = values[0];
      else if (values.length > 1) conflicts[band.id] = values.sort((a, b) => a - b);
    }
    category.effectiveRatesByScheme[scheme] = { ...((category.ratesByScheme || {})[scheme] || {}) };
    for (const [band, value] of Object.entries(observed)) category.effectiveRatesByScheme[scheme][band] = value;
  }
  category.observedRates = category.observedRatesByScheme.RFBS || {};
  category.observationConflicts = category.observationConflictsByScheme.RFBS || {};
  category.effectiveRates = category.effectiveRatesByScheme.RFBS || { ...(category.rates || {}) };
}

function settledOrderObservation(order, products, cnyPerRub, now) {
  if (!order || text(order.status) !== '已签收' || !order.finance) return null;
  if (order.ret || order.retFrom || order.finance.resaleIncomeRub != null || order.finance.returnFeeRub != null) return null;
  const items = Array.isArray(order.items) ? order.items : [];
  const usable = items.filter(item => text(item && (item.sku != null ? item.sku : item.offerId)));
  const distinctSkus = [...new Set(usable.map(item => text(item.sku != null ? item.sku : item.offerId)))];
  if (distinctSkus.length !== 1) return null;
  const amountRub = Number(order.finance.orderAmountRub);
  const feeRub = Number(order.finance.ozonFeeRub);
  if (!Number.isFinite(amountRub) || amountRub <= 0 || !Number.isFinite(feeRub) || feeRub < 0) return null;
  const commissionPercent = finitePercent(feeRub / amountRub);
  if (commissionPercent == null) return null;
  const wantedSku = distinctSkus[0];
  const orderShop = text(order.clientId || order.externalShopId || order.shopId);
  let candidates = (Array.isArray(products) ? products : []).filter(product => text(product && (product.sku != null ? product.sku : product.id)) === wantedSku);
  if (orderShop) {
    const exactShop = candidates.filter(product => text(product.clientId || product.externalShopId || product.shopId) === orderShop);
    if (exactShop.length) candidates = exactShop;
  }
  if (candidates.length !== 1) return null;
  const product = candidates[0];
  const scheme = normalizeSchema(product.commissionSchema || product.fulfillmentSchema || product.rfbs) || 'RFBS';
  const descriptionCategoryId = text(product.descriptionCategoryId || product.description_category_id);
  const typeId = text(product.typeId || product.type_id);
  if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) return null;
  const unit = usable[0];
  const unitCny = Number(unit.price);
  const rate = Number(cnyPerRub) > 0 ? Number(cnyPerRub) : 1 / 12;
  const unitRub = Number.isFinite(unitCny) && unitCny > 0 && Number.isFinite(rate) && rate > 0 ? unitCny / rate : null;
  return {
    key: descriptionCategoryId + ':' + typeId, descriptionCategoryId, typeId,
    scheme, commissionPercent, band: bandForRub(unitRub), priceRub: unitRub == null ? null : Number(unitRub.toFixed(4)),
    observedAt: now, settledOrder: true, source: 'Ozon settled order finance.ozonFeeRub / finance.orderAmountRub'
  };
}

function applySettledOrderObservations(catalog, orders, products, options = {}) {
  const observations = (Array.isArray(orders) ? orders : [])
    .map(order => settledOrderObservation(order, products, options.cnyPerRub, options.now || new Date().toISOString()))
    .filter(Boolean)
    .map(observation => ({
      descriptionCategoryId: observation.descriptionCategoryId, typeId: observation.typeId,
      commissionSchema: observation.scheme, commissionPercent: observation.commissionPercent,
      pricePromo: observation.priceRub, priceCurrency: 'RUB', _settledObservation: observation
    }));
  const result = applyProductObservations(catalog, observations, options);
  for (const observation of observations) {
    const settled = observation._settledObservation;
    const category = catalog.categories[settled.key];
    if (!category) continue;
    const current = (category.observations || []).find(item => item.source === 'Ozon /v3/product/info/list commissions.percent' && item.band === settled.band && item.commissionPercent === settled.commissionPercent);
    if (current) Object.assign(current, settled);
    refreshObservedRates(category);
  }
  catalog.lastSettledOrderUpdate = { at: options.now || new Date().toISOString(), acceptedObservations: observations.length };
  return result;
}
function applyProductObservations(catalog, products, options = {}) {
  const now = options.now || new Date().toISOString();
  let accepted = 0, addedCategories = 0, inconsistent = 0, updatedProductRates = 0;
  const observations = [];
  for (const product of Array.isArray(products) ? products : []) {
    const rates = product && product.commissionRates && typeof product.commissionRates === 'object' ? product.commissionRates : {};
    for (const [scheme, percent] of Object.entries(rates)) {
      const observation = productObservation({ ...product, commissionSchema: scheme, commissionPercent: percent }, options.cnyPerRub, now);
      if (observation) observations.push(observation);
    }
    const current = productObservation(product, options.cnyPerRub, now);
    if (current && !observations.some(item => item.key === current.key && item.scheme === current.scheme && item.priceRub === current.priceRub && item.commissionPercent === current.commissionPercent)) observations.push(current);
  }
  for (const observation of observations) {
    let category = catalog.categories[observation.key];
    if (!category) {
      const pending = catalog.unmatched[observation.key] || {};
      category = catalog.categories[observation.key] = {
        ...pending, key: observation.key, descriptionCategoryId: observation.descriptionCategoryId, typeId: observation.typeId,
        schemes: SUPPORTED_SCHEMES, scheme: 'rFBS', rates: {}, ratesByScheme: { RFBS: {}, FBP: {}, FBO: {}, FBS: {} },
        effectiveRates: {}, effectiveRatesByScheme: { RFBS: {}, FBP: {}, FBO: {}, FBS: {} }, match: 'ozon_product_observation', brandExceptions: [], observations: []
      };
      delete catalog.unmatched[observation.key];
      addedCategories += 1;
    }
    const expectedRates = category.effectiveRatesByScheme && category.effectiveRatesByScheme[observation.scheme];
    const expected = observation.band && expectedRates ? expectedRates[observation.band] : null;
    if (expected != null && expected !== observation.commissionPercent) inconsistent += 1;
    if (expected !== observation.commissionPercent) updatedProductRates += 1;
    const identity = [observation.source, observation.scheme, observation.band || 'unknown', observation.commissionPercent].join('\u001f');
    category.observations = (category.observations || []).filter(item => [item.source, item.scheme || 'RFBS', item.band || 'unknown', item.commissionPercent].join('\u001f') !== identity);
    category.observations.unshift(observation);
    category.observations = category.observations.slice(0, 30);
    refreshObservedRates(category);
    accepted += 1;
  }
  catalog.updatedAt = now;
  catalog.counts.matched = Object.keys(catalog.categories).length;
  catalog.counts.unmatched = Object.keys(catalog.unmatched).length;
  catalog.counts.mapped = catalog.counts.localCategories;
  catalog.counts.withCommission = catalog.counts.matched;
  catalog.counts.commissionPending = catalog.counts.unmatched;
  catalog.lastAutomaticUpdate = { at: now, acceptedObservations: accepted, addedCategories, inconsistent, updatedProductRates };
  return { acceptedObservations: accepted, addedCategories, inconsistent, updatedProductRates, matched: catalog.counts.matched, unmatched: catalog.counts.unmatched };
}

async function writeAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporary, file);
}

function createManager(options) {
  const queues = new Map();
  const systemFile = options.catalogFile || path.join(options.catalogDir, 'ozon-china-commissions.json');
  const fileForSystem = () => systemFile;
  async function initialCatalog(tenantId) {
    const treePath = options.treePathForTenant && options.treePathForTenant(tenantId);
    const localizedCatalogPath = options.localizedCatalogPathForTenant && options.localizedCatalogPathForTenant(tenantId);
    if (options.workbookPath && treePath && localizedCatalogPath && fs.existsSync(options.workbookPath) && fs.existsSync(treePath) && fs.existsSync(localizedCatalogPath)) {
      return buildBase({ workbookPath: options.workbookPath, treePath, localizedCatalogPath });
    }
    const now = new Date().toISOString();
    return {
      schemaVersion: 1, generatedAt: now, updatedAt: now, schemes: SUPPORTED_SCHEMES, scheme: 'rFBS', priceCurrency: 'RUB', bands: BANDS,
      source: { workbook: options.workbookPath ? path.basename(options.workbookPath) : '', status: 'base_source_unavailable' },
      priority: ['Ozon product commissions.percent for the exact product'],
      counts: { localCategories: 0, mapped: 0, withCommission: 0, commissionPending: 0, matched: 0, unmatched: 0, methods: {} }, categories: {}, unmatched: {}
    };
  }
  async function updateFromProducts(input) {
    const tenantId = String(input.tenantId);
    const previous = queues.get('system') || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = fileForSystem();
      let catalog;
      try { catalog = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        catalog = await initialCatalog(tenantId);
      }
      const result = applyProductObservations(catalog, input.products, { cnyPerRub: input.cnyPerRub });
      await writeAtomic(file, catalog);
      return { updated: true, ...result };
    });
    queues.set('system', current);
    try { return await current; } finally { if (queues.get('system') === current) queues.delete('system'); }
  }
  async function updateFromSettledOrders(input) {
    const tenantId = String(input.tenantId);
    const previous = queues.get('system') || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const file = fileForSystem();
      let catalog;
      try { catalog = JSON.parse(await fs.promises.readFile(file, 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        catalog = await initialCatalog(tenantId);
      }
      const result = applySettledOrderObservations(catalog, input.orders, input.products, { cnyPerRub: input.cnyPerRub });
      await writeAtomic(file, catalog);
      return { updated: true, ...result };
    });
    queues.set('system', current);
    try { return await current; } finally { if (queues.get('system') === current) queues.delete('system'); }
  }
  async function enrichProducts(input) {
    let catalog;
    try { catalog = JSON.parse(await fs.promises.readFile(systemFile, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { products: Array.isArray(input.products) ? input.products : [], supplemented: 0 };
      throw error;
    }
    return enrichProductsFromCatalog(catalog, input.products, input.cnyPerRub);
  }
  let readCache = null;
  let readLoading = null;
  async function readSystemCatalog() {
    const stat = await fs.promises.stat(systemFile);
    if (readCache && readCache.mtimeMs === stat.mtimeMs) return readCache.catalog;
    if (readLoading) return readLoading;
    readLoading = fs.promises.readFile(systemFile, 'utf8').then(raw => {
      const catalog = JSON.parse(raw);
      readCache = { mtimeMs: stat.mtimeMs, catalog };
      return catalog;
    }).finally(() => { readLoading = null; });
    return readLoading;
  }
  async function getCategoryReference(input = {}) {
    try { return categoryReferenceForProduct(await readSystemCatalog(), input.product || input); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return { fileForSystem, enrichProducts, getCategoryReference, updateFromProducts, updateFromSettledOrders };
}

module.exports = { BANDS, SUPPORTED_SCHEMES, normalize, finitePercent, categoryLeaves, readSource, createIndexes, matchLeaf, buildBase, rubPrice, bandForRub, productObservation, effectivePercentForProduct, categoryReferenceForProduct, enrichProductsFromCatalog, settledOrderObservation, applyProductObservations, applySettledOrderObservations, writeAtomic, createManager };
