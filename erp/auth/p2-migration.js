'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256File, pathInside } = require('./private-object-store');

const SCALE = 4;
const MONEY_FIELD = /(?:amount|price|cost|fee|commission|shipping|income|sale|purchase|rub|cny)$/i;
const TIME_FIELD = /(?:At|Time|Date|_at|_time|_date)$/;

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function decimalToUnits(value, scale = SCALE) {
  const text = String(value == null ? '' : value).trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error('invalid decimal amount');
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const padded = (fraction + '0'.repeat(scale + 1)).slice(0, scale + 1);
  let units = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded.slice(0, scale) || '0');
  if (Number(padded[scale] || '0') >= 5) units += 1n;
  return negative ? -units : units;
}

function unitsToDecimal(units, scale = SCALE) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  return (negative ? '-' : '') + (absolute / factor) + '.' + String(absolute % factor).padStart(scale, '0');
}

function legacyMoneyToUnits(value, scale = SCALE) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw === '--') return null;
  const normalized = raw.replace(/,/g, '').replace(/\s+/g, ' ');
  const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*(?:RUB|₽)?$/i)
    || normalized.match(/^[￥¥]\s*(-?\d+(?:\.\d+)?)$/)
    || normalized.match(/^(-?\d+(?:\.\d+)?)\s*(?:CNY|RMB)$/i);
  if (!match) throw new Error('invalid legacy monetary amount');
  return decimalToUnits(match[1], scale);
}

function normalizeUtc(value, assumedOffset = '') {
  if (value == null || value === '') return value;
  const text = String(value).trim();
  if (/^\d{10}(?:\d{3})?$/.test(text)) {
    const timestamp = Number(text) * (text.length === 10 ? 1000 : 1);
    if (!Number.isFinite(timestamp)) throw new Error('invalid timestamp');
    return new Date(timestamp).toISOString();
  }
  const explicit = /^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const naive = /^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text);
  if (!explicit && !dateOnly && !(naive && /^[+-]\d{2}:\d{2}$/.test(assumedOffset))) throw new Error('timestamp must include an offset or ERP_LEGACY_TIME_OFFSET must be declared');
  const timestamp = Date.parse(dateOnly ? text + 'T00:00:00Z' : text.replace(' ', 'T') + (naive ? assumedOffset : ''));
  if (!Number.isFinite(timestamp)) throw new Error('invalid timestamp');
  return new Date(timestamp).toISOString();
}

function normalizeRecord(value, keyName = '', assumedOffset = '') {
  if (Array.isArray(value)) return value.map(item => normalizeRecord(item, '', assumedOffset));
  if (!value || typeof value !== 'object') {
    if (value !== '' && value != null && MONEY_FIELD.test(keyName)) {
      const units = legacyMoneyToUnits(value);
      return units == null ? value : unitsToDecimal(units);
    }
    if (value !== '' && value != null && TIME_FIELD.test(keyName)) return normalizeUtc(value, assumedOffset);
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeRecord(child, key, assumedOffset)]));
}

function requiredText(value, name, maximum = 180) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maximum) throw new Error(`${name} is required for deterministic migration`);
  return text;
}

function shopExternalId(item) {
  return requiredText(item && (item.clientId || item.externalShopId || item.shopId), 'external shop id', 120);
}

function buildLegacyShopMap(rawShops) {
  if (!Array.isArray(rawShops)) throw new Error('shops source must be an array');
  const map = new Map();
  for (const shop of rawShops) {
    const externalShopId = requiredText(shop && (shop.clientId || shop.externalShopId || shop.shopId), 'external shop id', 120);
    const labels = [externalShopId, String(shop && shop.name || '').trim()].filter(Boolean);
    for (const label of labels) {
      const existing = map.get(label);
      if (existing && existing !== externalShopId) throw new Error('legacy shop label is ambiguous; explicit mapping is required');
      map.set(label, externalShopId);
    }
  }
  return map;
}

function resolveLegacyShopItem(item, shopMap) {
  if (item && (item.clientId || item.externalShopId || item.shopId)) return item;
  const label = String(item && item.shop || '').trim();
  const externalShopId = label && shopMap instanceof Map ? shopMap.get(label) : '';
  if (!externalShopId) throw new Error('external shop id is required for deterministic migration');
  return { ...(item && typeof item === 'object' && !Array.isArray(item) ? item : {}), clientId: externalShopId };
}

function buildLegacyOrderShopIndex(rawOrders, shopMap) {
  if (!Array.isArray(rawOrders)) throw new Error('orders source must be an array');
  const index = new Map();
  for (const item of rawOrders) {
    const resolved = resolveLegacyShopItem(item, shopMap);
    const identity = orderIdentity('', resolved);
    const existing = index.get(identity.posting);
    if (existing && existing !== identity.shop) throw new Error('order posting maps to multiple external shop ids; explicit mapping is required');
    index.set(identity.posting, identity.shop);
  }
  return index;
}

function resolveLegacyFinanceItem(entryKey, item, orderShopIndex) {
  if (!(orderShopIndex instanceof Map)) throw new Error('finance record requires a deterministic order-to-shop mapping');
  const key = requiredText(entryKey, 'external transaction id', 240);
  const explicitPosting = String(item && (item.posting || item.posting_number) || '').trim();
  let posting = explicitPosting;
  if (!posting) {
    if (orderShopIndex.has(key)) posting = key;
    else {
      const matches = [...orderShopIndex.keys()].filter(candidate => candidate.startsWith(key + '-'));
      if (matches.length !== 1) throw new Error(`finance record has no unique order mapping: ${key}`);
      posting = matches[0];
    }
  }
  const mappedShop = orderShopIndex.get(posting);
  if (!mappedShop) throw new Error(`finance record order is not present in the frozen order source: ${key}`);
  const base = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
  if (base.clientId || base.externalShopId || base.shopId) {
    const explicitShop = shopExternalId(base);
    if (explicitShop !== mappedShop) throw new Error(`finance record shop conflicts with frozen order mapping: ${key}`);
    return { ...base, posting };
  }
  return { ...base, clientId: mappedShop, posting };
}

function orderIdentity(tenantId, item) {
  const shop = shopExternalId(item);
  const posting = requiredText(item && (item.posting || item.posting_number), 'external order number');
  return { shop, posting, recordKey: 'ord_' + sha256Text(canonicalJson([String(tenantId), shop, posting])), deterministicKey: `${tenantId}/order/${encodeURIComponent(shop)}/${encodeURIComponent(posting)}` };
}

function productIdentity(tenantId, item) {
  const shop = shopExternalId(item);
  const productId = requiredText(item && (item.id || item.productId || item.sku || item.offer_id), 'external product id');
  return { shop, productId, recordKey: 'prd_' + sha256Text(canonicalJson([String(tenantId), shop, productId])), deterministicKey: `${tenantId}/product/${encodeURIComponent(shop)}/${encodeURIComponent(productId)}` };
}

function financeIdentity(tenantId, documentKey, entryKey, item) {
  const shop = shopExternalId(item);
  const posting = requiredText(item && (item.posting || item.posting_number), 'external order number');
  const transactionId = requiredText(item && (item.id || item.operation_id || item.transaction_id) || entryKey, 'external transaction id', 240);
  return { shop, posting, transactionId, recordKey: 'fin_' + sha256Text(canonicalJson([String(tenantId), documentKey, shop, posting, transactionId])), deterministicKey: `${tenantId}/${documentKey}/${encodeURIComponent(shop)}/${encodeURIComponent(posting)}/${encodeURIComponent(transactionId)}` };
}

function walkFiles(root) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];
  const output = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const candidate = path.resolve(directory, entry.name);
      if (!pathInside(resolvedRoot, candidate)) throw new Error('inventory path escaped root');
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are forbidden in migration inventory: ${candidate}`);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) output.push(candidate);
    }
  };
  visit(resolvedRoot);
  return output;
}

function classifyFile(rootName, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (rootName === 'logistics') return 'logistics_file';
  if (/^bug-attachments\/\d+\/BUG-[A-Z0-9-]+\//.test(normalized)) return 'bug_attachment';
  if (/^category-attributes\/tenant-\d+\.json$/.test(normalized)) return 'category_snapshot';
  if (/\.json$/i.test(normalized) && (/^tenants\/\d+\//.test(normalized) || /(?:^|\/)erp_[a-z0-9_-]+\.json$/i.test(normalized))) return 'legacy_json';
  if (/\.json$/i.test(normalized)) return 'runtime_json';
  return 'legacy_file';
}

function tenantIdFromPath(rootName, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const patterns = rootName === 'logistics'
    ? [/^(\d+)\//]
    : [/^tenants\/(\d+)\//, /^bug-attachments\/(\d+)\//, /^category-attributes\/tenant-(\d+)\.json$/];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function inventoryRoots(roots) {
  const entries = [];
  for (const root of roots) {
    for (const file of walkFiles(root.path)) {
      const relative = path.relative(root.path, file).replace(/\\/g, '/');
      const stat = fs.statSync(file);
      entries.push({
        root: root.name, relativePath: relative, sourceKind: classifyFile(root.name, relative),
        tenantId: tenantIdFromPath(root.name, relative), size: stat.size,
        modifiedAt: stat.mtime.toISOString(), sha256: await sha256File(file)
      });
    }
  }
  entries.sort((a, b) => `${a.root}/${a.relativePath}`.localeCompare(`${b.root}/${b.relativePath}`, 'en'));
  return entries;
}

module.exports = {
  SCALE, canonicalJson, sha256Text, decimalToUnits, unitsToDecimal, legacyMoneyToUnits, normalizeUtc, normalizeRecord,
  orderIdentity, productIdentity, financeIdentity, buildLegacyShopMap, resolveLegacyShopItem,
  buildLegacyOrderShopIndex, resolveLegacyFinanceItem, walkFiles, classifyFile, tenantIdFromPath, inventoryRoots
};
