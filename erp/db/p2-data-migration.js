#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { createDatabaseConfig } = require('./config');
const { PrivateObjectStore, sha256File, pathInside } = require('../auth/private-object-store');
const { parseArchiveKey, encryptFile, decryptFile } = require('../auth/encrypted-archive');
const {
  canonicalJson, sha256Text, decimalToUnits, unitsToDecimal, legacyMoneyToUnits, normalizeRecord,
  orderIdentity, productIdentity, financeIdentity, buildLegacyShopMap, resolveLegacyShopItem,
  buildLegacyOrderShopIndex, resolveLegacyFinanceItem, inventoryRoots
} = require('../auth/p2-migration');
const { normalizePlatformPayload, supplierHosts } = require('../auth/business-boundaries');
const { parseCredentialKey, encryptShopCredentials, decryptShopCredentials } = require('../auth/credential-crypto');

const ERP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(ERP_DIR, 'data'));
const LOGISTICS_DIR = path.resolve(process.env.ERP_LOGISTICS_TARIFF_DIR || path.join(ERP_DIR, '..', '本机数据', '物流原表'));
const WORK_DIR = path.resolve(process.env.ERP_MIGRATION_WORK_DIR || path.join(ERP_DIR, '..', '本机数据', 'migration-p2'));
const OBJECT_DIR = path.resolve(process.env.ERP_PRIVATE_OBJECT_DIR || path.join(ERP_DIR, '..', '本机数据', 'private-objects'));
const DEFAULT_CREDENTIAL_KEY_FILE = path.resolve(ERP_DIR, '..', '本机数据', '配置', 'credentials.key');
const ROOTS = [{ name: 'data', path: DATA_DIR }, { name: 'logistics', path: LOGISTICS_DIR }];
const FINANCE_KEYS = new Set(['erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1']);
const REBUILDABLE_RUNTIME_EXCLUSIONS = new Map([
  ['data/system/api-monitor.json', 'rebuildable_api_monitor_state']
]);

if (process.env.NODE_ENV === 'production') {
  if (pathInside(ERP_DIR, WORK_DIR) || pathInside(ERP_DIR, OBJECT_DIR)) throw new Error('production migration work and private object directories must be outside the application directory');
}
if (process.env.ERP_LEGACY_TIME_OFFSET && !/^[+-]\d{2}:\d{2}$/.test(process.env.ERP_LEGACY_TIME_OFFSET)) throw new Error('ERP_LEGACY_TIME_OFFSET must use +HH:MM or -HH:MM');

function arg(name) {
  const prefix = '--' + name + '=';
  const inline = process.argv.find(value => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function has(name) { return process.argv.includes('--' + name); }
function loadMigrationCredentialKey(environment = process.env) {
  const envValue = String(environment.ERP_CREDENTIALS_KEY || '').trim();
  if (envValue) return parseCredentialKey(envValue);
  const configuredFile = String(environment.ERP_CREDENTIALS_KEY_FILE || '').trim();
  if (String(environment.NODE_ENV || '') === 'production' && !configuredFile) {
    throw new Error('ERP credential key is required via ERP_CREDENTIALS_KEY or ERP_CREDENTIALS_KEY_FILE');
  }
  const file = path.resolve(configuredFile || DEFAULT_CREDENTIAL_KEY_FILE);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error('ERP credential key file is missing; configure ERP_CREDENTIALS_KEY or an existing ERP_CREDENTIALS_KEY_FILE');
  }
  const fileValue = fs.readFileSync(file, 'utf8').trim();
  if (!fileValue) throw new Error('ERP credential key file is empty');
  return parseCredentialKey(fileValue);
}
function parseTenantIdList(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const values = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!values.length || values.some(item => !/^[1-9]\d*$/.test(item))) throw new Error('tenant id list must contain positive integer ids');
  return [...new Set(values.map(item => String(BigInt(item))))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
function filterInventoryFiles(files, excludedTenantIds) {
  const excluded = new Set((excludedTenantIds || []).map(String));
  return (files || []).filter(entry => entry.tenantId == null || !excluded.has(String(entry.tenantId)));
}

function rebuildableRuntimeExclusion(entry) {
  if (!entry) return '';
  const key = `${String(entry.root || '').replace(/\\/g, '/')}/${String(entry.relativePath || '').replace(/\\/g, '/')}`;
  const reason = REBUILDABLE_RUNTIME_EXCLUSIONS.get(key) || '';
  if (reason && entry.sourceKind !== 'runtime_json') {
    throw new Error(`rebuildable runtime exclusion classification changed: ${key}`);
  }
  return reason;
}

function partitionInventoryFiles(files, excludedTenantIds) {
  const excludedTenants = new Set((excludedTenantIds || []).map(String));
  const included = [];
  const excludedTenantFiles = [];
  const excludedRuntimeFiles = [];
  for (const entry of files || []) {
    if (entry.tenantId != null && excludedTenants.has(String(entry.tenantId))) {
      excludedTenantFiles.push(entry);
      continue;
    }
    const reason = rebuildableRuntimeExclusion(entry);
    if (reason) {
      excludedRuntimeFiles.push({
        root: entry.root,
        relativePath: entry.relativePath,
        sourceKind: entry.sourceKind,
        reason,
        size: entry.size,
        modifiedAt: entry.modifiedAt,
        sha256: entry.sha256
      });
      continue;
    }
    included.push(entry);
  }
  return { files: included, excludedTenantFiles, excludedRuntimeFiles };
}
function now() { return new Date().toISOString(); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '')); }
function manifestHash(value) { const copy = { ...value }; delete copy.manifestSha256; return sha256Text(canonicalJson(copy)); }

function writeJsonExclusive(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function sourceFile(entry) {
  const root = ROOTS.find(item => item.name === entry.root);
  if (!root) throw new Error(`unknown inventory root: ${entry.root}`);
  const file = path.resolve(root.path, ...String(entry.relativePath).split('/'));
  if (!pathInside(root.path, file)) throw new Error('inventory source path escaped root');
  return file;
}

function documentInfo(entry) {
  if (entry.root !== 'data') return null;
  const match = entry.relativePath.match(/^tenants\/(\d+)\/([a-z0-9_-]+)\.json$/i);
  return match ? { tenantId: match[1], key: match[2] } : null;
}

function deterministicFileKey(entry) {
  const info = documentInfo(entry);
  if (info) return `${info.tenantId}/json/${info.key}`;
  if (entry.tenantId && objectKind(entry)) return `${entry.tenantId}/object/${entry.sourceKind}/${entry.sha256}`;
  return null;
}

function ensureManifest(value, label) {
  if (!value || value.manifestSha256 !== manifestHash(value)) throw new Error(`${label} manifest checksum is invalid`);
  return value;
}

async function verifySources(manifest) {
  for (const entry of manifest.files) {
    const file = sourceFile(entry);
    if (!fs.existsSync(file)) throw new Error(`source file disappeared after freeze: ${entry.root}/${entry.relativePath}`);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`source file became a symbolic link: ${entry.root}/${entry.relativePath}`);
    const stat = fs.statSync(file);
    if (stat.size !== entry.size || await sha256File(file) !== entry.sha256) throw new Error(`source file changed after freeze: ${entry.root}/${entry.relativePath}`);
  }
}

async function inventory() {
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const freezeFile = path.join(DATA_DIR, '.p2-legacy-json-frozen.json');
  if (!fs.existsSync(freezeFile)) throw new Error('legacy JSON is not frozen; run freeze --apply first');
  const allFiles = await inventoryRoots(ROOTS);
  const excludedTenantIds = parseTenantIdList(arg('exclude-tenants'));
  if (excludedTenantIds.length) {
    const sourceTenantIds = new Set(allFiles.map(item => item.tenantId == null ? '' : String(item.tenantId)).filter(Boolean));
    const missing = excludedTenantIds.filter(tenantId => !sourceTenantIds.has(tenantId));
    if (missing.length) throw new Error(`excluded tenant id is not present in inventory source: ${missing.join(',')}`);
  }
  const selection = partitionInventoryFiles(allFiles, excludedTenantIds);
  const files = selection.files;
  const runId = crypto.randomUUID();
  const manifest = {
    version: 1,
    runId,
    createdAt: now(),
    freezeMarkerSha256: await sha256File(freezeFile),
    roots: ROOTS,
    excludedTenantIds,
    excludedRuntimeFiles: selection.excludedRuntimeFiles,
    files
  };
  manifest.summary = {
    files: files.length,
    bytes: files.reduce((sum, item) => sum + item.size, 0),
    excludedFiles: allFiles.length - files.length,
    excludedTenantFiles: selection.excludedTenantFiles.length,
    excludedRuntimeFiles: selection.excludedRuntimeFiles.length
  };
  manifest.manifestSha256 = manifestHash(manifest);
  const output = path.join(WORK_DIR, `inventory-${runId}.json`);
  writeJsonExclusive(output, manifest);
  console.log(output);
}

async function freeze() {
  if (!has('apply')) throw new Error('freeze changes legacy file attributes; rerun with --apply after stopping all legacy writers');
  fs.mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const freezeFile = path.join(DATA_DIR, '.p2-legacy-json-frozen.json');
  if (fs.existsSync(freezeFile)) throw new Error('legacy JSON is already frozen');
  const files = (await inventoryRoots(ROOTS)).filter(item => item.root === 'data' && item.sourceKind === 'legacy_json');
  const frozenFiles = files.map(item => ({ relativePath: item.relativePath, sha256: item.sha256, size: item.size, previousMode: fs.statSync(sourceFile(item)).mode & 0o777 }));
  try {
    for (const entry of files) fs.chmodSync(sourceFile(entry), 0o400);
    const marker = {
      version: 1, frozenAt: now(), mode: 'read-only', lazyImport: false, deleteBeforeAcceptance: false,
      files: frozenFiles
    };
    marker.manifestSha256 = manifestHash(marker);
    writeJsonExclusive(freezeFile, marker);
    fs.chmodSync(freezeFile, 0o400);
  } catch (error) {
    for (let index = 0; index < files.length; index += 1) {
      try { fs.chmodSync(sourceFile(files[index]), frozenFiles[index].previousMode); } catch (_) { /* best-effort attribute rollback */ }
    }
    throw error;
  }
  console.log(freezeFile);
}

async function backup() {
  const inventoryFile = arg('inventory');
  const databaseBackup = path.resolve(arg('database-backup') || '');
  if (!inventoryFile || !arg('database-backup')) throw new Error('--inventory and --database-backup are required');
  const manifest = ensureManifest(readJson(inventoryFile), 'inventory');
  await verifySources(manifest);
  if (!fs.existsSync(databaseBackup) || path.extname(databaseBackup).toLowerCase() !== '.dump') throw new Error('database backup must be an existing PostgreSQL custom .dump');
  if (fs.lstatSync(databaseBackup).isSymbolicLink()) throw new Error('database backup symbolic links are forbidden');
  const databaseManifestFile = databaseBackup + '.json';
  const databaseHashFile = databaseBackup + '.sha256';
  if (!fs.existsSync(databaseManifestFile) || !fs.existsSync(databaseHashFile)) throw new Error('database backup manifest and SHA-256 sidecar are required');
  const databaseManifest = readJson(databaseManifestFile);
  if (databaseManifest.verifiedBy !== 'pg_restore --list') throw new Error('database backup was not structurally verified');
  const expectedDatabaseHash = String(fs.readFileSync(databaseHashFile, 'ascii')).trim().split(/\s+/)[0];
  const actualDatabaseHash = await sha256File(databaseBackup);
  if (expectedDatabaseHash !== actualDatabaseHash || databaseManifest.sha256 !== actualDatabaseHash) throw new Error('database backup checksum mismatch');
  const key = parseArchiveKey(process.env.ERP_MIGRATION_ARCHIVE_KEY);
  const retentionDays = Number(arg('retention-days') || 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('retention days must be between 1 and 3650');
  const archiveDir = path.join(WORK_DIR, `archive-${manifest.runId}`);
  fs.mkdirSync(archiveDir, { recursive: false, mode: 0o700 });
  const encrypted = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const encryptedName = String(index + 1).padStart(8, '0') + '.enc';
    const result = await encryptFile(sourceFile(entry), path.join(archiveDir, encryptedName), key);
    encrypted.push({ root: entry.root, relativePath: entry.relativePath, sourceSha256: entry.sha256, sourceBytes: entry.size, encryptedName, ...result });
  }
  const databaseEncryptedName = String(encrypted.length + 1).padStart(8, '0') + '.enc';
  const databaseEncrypted = await encryptFile(databaseBackup, path.join(archiveDir, databaseEncryptedName), key);
  encrypted.push({ root: 'database', relativePath: path.basename(databaseBackup), sourceSha256: actualDatabaseHash, sourceBytes: fs.statSync(databaseBackup).size, encryptedName: databaseEncryptedName, ...databaseEncrypted });
  const backupManifest = {
    version: 1, archiveId: crypto.randomUUID(), runId: manifest.runId, cipher: 'AES-256-GCM', createdAt: now(),
    expiresAt: new Date(Date.now() + retentionDays * 86400000).toISOString(), sourceManifestSha256: manifest.manifestSha256,
    readOnly: true, databaseFormat: 'postgresql-custom', databaseVerifiedBy: 'pg_restore --list', files: encrypted
  };
  backupManifest.ciphertextSetSha256 = sha256Text(canonicalJson(encrypted.map(item => ({ encryptedName: item.encryptedName, ciphertextSha256: item.ciphertextSha256 }))));
  backupManifest.manifestSha256 = manifestHash(backupManifest);
  const output = path.join(archiveDir, 'backup-manifest.json');
  writeJsonExclusive(output, backupManifest);
  for (const item of encrypted) fs.chmodSync(path.join(archiveDir, item.encryptedName), 0o400);
  fs.chmodSync(output, 0o400);
  console.log(output);
}

async function restore() {
  if (!has('apply')) throw new Error('restore is write-capable; rerun with --apply and an empty output directory');
  const backupFile = arg('backup');
  const outputDir = path.resolve(arg('output') || '');
  if (!backupFile || !arg('output')) throw new Error('--backup and --output are required');
  const backupManifest = ensureManifest(readJson(backupFile), 'backup');
  if (fs.existsSync(outputDir) && fs.readdirSync(outputDir).length) throw new Error('restore output directory must be empty');
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const key = parseArchiveKey(process.env.ERP_MIGRATION_ARCHIVE_KEY);
  for (const item of backupManifest.files) {
    const encrypted = path.resolve(path.dirname(backupFile), item.encryptedName);
    if (await sha256File(encrypted) !== item.ciphertextSha256) throw new Error(`ciphertext hash mismatch: ${item.encryptedName}`);
    const target = path.resolve(outputDir, item.root, ...item.relativePath.split('/'));
    if (!pathInside(outputDir, target)) throw new Error('restore path escaped output directory');
    await decryptFile(encrypted, target, key);
    if (await sha256File(target) !== item.sourceSha256) throw new Error(`restored hash mismatch: ${item.relativePath}`);
  }
  console.log(outputDir);
}

function firstAmount(payload, paths) {
  for (const item of paths) {
    let value = payload;
    for (const part of item.split('.')) value = value && value[part];
    if (value !== undefined && value !== null && value !== '' && value !== '--') {
      const units = legacyMoneyToUnits(value);
      if (units != null) return unitsToDecimal(units);
    }
  }
  return null;
}

function financeAmount(payload) {
  if (typeof payload === 'number' || typeof payload === 'string') {
    const units = legacyMoneyToUnits(payload);
    return units == null ? null : unitsToDecimal(units);
  }
  return firstAmount(payload, ['amount', 'accrued.amount', 'seller_price.amount', 'total']);
}

function resolveMigrationFinanceIdentity(tenantId, documentKey, entryKey, item, orderShopIndex, objectShape) {
  const key = String(entryKey == null ? '' : entryKey).trim();
  try {
    const source = resolveLegacyFinanceItem(key, item, orderShopIndex);
    const identity = financeIdentity(tenantId, documentKey, key, source);
    return { ...identity, recordKey: objectShape ? key : identity.recordKey, unallocated: false };
  } catch (error) {
    const scalar = typeof item === 'number' || typeof item === 'string';
    if (documentKey !== 'erp_acquiring_data' || objectShape !== true || !scalar || !(orderShopIndex instanceof Map)) throw error;
    let units;
    try { units = legacyMoneyToUnits(item); } catch (amountError) { throw error; }
    if (units == null) throw error;
    const matches = [...orderShopIndex.keys()].filter(candidate => candidate === key || candidate.startsWith(key + '-'));
    if (matches.length !== 0) throw error;
    return {
      shop: null,
      posting: null,
      transactionId: key,
      recordKey: key,
      unallocated: true,
      deterministicKey: String(tenantId) + '/' + documentKey + '/unallocated/' + encodeURIComponent(key)
    };
  }
}

function firstTime(payload, fields) {
  for (const field of fields) if (payload && payload[field]) return payload[field];
  return null;
}

function normalizeLegacyRecord(value) { return normalizeRecord(value, '', process.env.ERP_LEGACY_TIME_OFFSET || ''); }

function metricFor(metrics, tenantId) {
  if (!metrics.has(tenantId)) metrics.set(tenantId, { orders: 0, products: 0, financial: 0, unallocatedFinancial: 0, attachments: 0, objects: 0, orderUnits: 0n, costUnits: 0n, debitUnits: 0n, creditUnits: 0n });
  return metrics.get(tenantId);
}

async function assertShop(client, tenantId, externalShopId) {
  const result = await client.query(`SELECT 1 FROM shops WHERE tenant_id = $1 AND external_shop_id = $2`, [tenantId, externalShopId]);
  if (!result.rowCount) throw new Error(`exact shop key not found: tenant=${tenantId}, externalShopId=${externalShopId}`);
}

function validateShopRecords(raw) {
  if (!Array.isArray(raw)) throw new Error('shops source must be an array');
  const seen = new Set();
  return raw.map(item => ({
    externalShopId: String(item && (item.clientId || item.externalShopId) || '').trim(),
    name: String(item && item.name || '').trim()
  })).map(item => {
    if (!item.externalShopId || item.externalShopId.length > 120 || !item.name || item.name.length > 160) throw new Error('shop external id and name are required for deterministic migration');
    if (seen.has(item.externalShopId)) throw new Error(`duplicate shop external id in deterministic migration: ${item.externalShopId}`);
    seen.add(item.externalShopId);
    return item;
  });
}

function targetIsNewerThanSource(sourceModifiedAt, targetUpdatedAt) {
  const source = Date.parse(String(sourceModifiedAt || ''));
  const target = Date.parse(String(targetUpdatedAt || ''));
  if (!Number.isFinite(source) || !Number.isFinite(target)) throw new Error('shop source/target timestamps are required for newer-target adoption');
  return target > source;
}

function sameShopIdentitySet(sourceRaw, targetRaw) {
  const source = validateShopRecords(sourceRaw).map(item => item.externalShopId).sort();
  const target = validateShopRecords(targetRaw).map(item => item.externalShopId).sort();
  return canonicalJson(source) === canonicalJson(target);
}

function sourceShopIdentitySubsetOfTarget(sourceRaw, targetRaw) {
  const source = validateShopRecords(sourceRaw).map(item => item.externalShopId);
  const target = new Set(validateShopRecords(targetRaw).map(item => item.externalShopId));
  return source.every(externalShopId => target.has(externalShopId));
}

function buildSourceContexts(manifest) {
  const contexts = new Map();
  const contextFor = tenantId => {
    const key = String(tenantId);
    if (!contexts.has(key)) contexts.set(key, { shopMap: new Map(), orderShopIndex: null, orderIndexError: null });
    return contexts.get(key);
  };
  for (const entry of manifest.files) {
    const info = documentInfo(entry);
    if (!info || info.key !== 'erp_shops_data') continue;
    const raw = readJson(sourceFile(entry));
    validateShopRecords(raw);
    contextFor(info.tenantId).shopMap = buildLegacyShopMap(raw);
  }
  for (const entry of manifest.files) {
    const info = documentInfo(entry);
    if (!info || info.key !== 'erp_orders_data') continue;
    const context = contextFor(info.tenantId);
    try { context.orderShopIndex = buildLegacyOrderShopIndex(readJson(sourceFile(entry)), context.shopMap); }
    catch (error) { context.orderIndexError = error; }
  }
  return contexts;
}

async function migrateShopsDocument(client, runId, ownerId, info, raw, sourceModifiedAt) {
  const shops = validateShopRecords(raw);
  const credentialKey = loadMigrationCredentialKey();
  for (const shop of shops) {
    const existing = await client.query(`SELECT id,name,updated_at FROM shops WHERE tenant_id=$1 AND external_shop_id=$2`, [info.tenantId, shop.externalShopId]);
    if (!existing.rowCount) {
      await client.query(`INSERT INTO shops (tenant_id,name,external_shop_id) VALUES ($1,$2,$3)`, [info.tenantId, shop.name, shop.externalShopId]);
    } else {
      if (existing.rowCount !== 1) throw new Error(`exact shop key conflict: tenant=${info.tenantId}, externalShopId=${shop.externalShopId}`);
      if (existing.rows[0].name !== shop.name && !targetIsNewerThanSource(sourceModifiedAt, existing.rows[0].updated_at)) {
        throw new Error(`exact shop key conflict: tenant=${info.tenantId}, externalShopId=${shop.externalShopId}`);
      }
    }
  }
  const encrypted = encryptShopCredentials(raw, credentialKey, info.tenantId);
  const inserted = await client.query(
    `INSERT INTO tenant_documents (tenant_id,document_key,payload,updated_by_user_id)
     VALUES ($1,'erp_shops_data',$2::jsonb,$3) ON CONFLICT (tenant_id,document_key) DO NOTHING RETURNING 1`,
    [info.tenantId, JSON.stringify(encrypted), ownerId]
  );
  let ownership = 'inserted';
  let ownershipValue = raw;
  if (!inserted.rowCount) {
    const existing = await client.query(`SELECT payload,updated_at FROM tenant_documents WHERE tenant_id=$1 AND document_key='erp_shops_data'`, [info.tenantId]);
    const decrypted = existing.rowCount ? decryptShopCredentials(existing.rows[0].payload, credentialKey, info.tenantId) : null;
    if (canonicalJson(decrypted) !== canonicalJson(raw)) {
      if (!existing.rowCount || !targetIsNewerThanSource(sourceModifiedAt, existing.rows[0].updated_at) || !sourceShopIdentitySubsetOfTarget(raw, decrypted)) {
        throw new Error(`deterministic key conflict in tenant_documents: tenant=${info.tenantId}, key=erp_shops_data`);
      }
      ownershipValue = decrypted;
    }
    ownership = 'matched_existing';
  }
  await recordOwnership(client, runId, info.tenantId, 'shop_document', 'erp_shops_data', ownership, ownershipValue);
}

async function recordOwnership(client, runId, tenantId, entityKind, recordKey, ownership, value) {
  await client.query(
    `INSERT INTO migration_record_ownership
       (run_id,tenant_id,entity_kind,record_key,ownership,payload_sha256)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (run_id,tenant_id,entity_kind,record_key) DO UPDATE SET
       ownership=EXCLUDED.ownership, payload_sha256=EXCLUDED.payload_sha256`,
    [runId, tenantId, entityKind, recordKey, ownership, sha256Text(canonicalJson(value))]
  );
}

async function insertOrVerify(client, runId, entityKind, recordKey, insertSql, insertParams, table, tenantId, keyColumns, payload) {
  const result = await client.query(insertSql, insertParams);
  let ownership = 'inserted';
  if (!result.rowCount) {
    const where = Object.keys(keyColumns).map((key, index) => `${key} = $${index + 2}`).join(' AND ');
    const existing = await client.query(`SELECT payload FROM ${table} WHERE tenant_id = $1 AND ${where}`, [tenantId, ...Object.values(keyColumns)]);
    if (!existing.rowCount || canonicalJson(existing.rows[0].payload) !== canonicalJson(payload)) throw new Error(`deterministic key conflict in ${table}`);
    ownership = 'matched_existing';
  }
  await recordOwnership(client, runId, tenantId, entityKind, recordKey, ownership, payload);
  return ownership;
}

async function migrateJsonDocument(client, runId, ownerId, info, raw, allowedHosts, metrics, sourceContext) {
  const tenantId = info.tenantId;
  const metric = metricFor(metrics, tenantId);
  if (info.key === 'erp_orders_data') {
    if (!Array.isArray(raw)) throw new Error('orders source must be an array');
    for (let position = 0; position < raw.length; position += 1) {
      const identity = orderIdentity(tenantId, resolveLegacyShopItem(raw[position], sourceContext && sourceContext.shopMap)); await assertShop(client, tenantId, identity.shop);
      const payload = normalizePlatformPayload(info.key, [normalizeLegacyRecord(raw[position])], allowedHosts)[0];
      const amount = firstAmount(payload, ['finance.orderAmountRub', 'finance.orderAmount', 'orderAmountRub', 'total']);
      await insertOrVerify(client, runId, 'order', identity.recordKey,
        `INSERT INTO business_orders (tenant_id, record_key, position, posting_number, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id, order_amount, currency, occurred_at, migration_run_id)
         VALUES ($1,$2,$3,$4,$5,'ozon',$4,$6::jsonb,$7,$8,'RUB',$9,$10) ON CONFLICT (tenant_id, record_key) DO NOTHING RETURNING 1`,
        [tenantId, identity.recordKey, position, identity.posting, identity.shop, JSON.stringify(payload), ownerId, amount, firstTime(payload, ['orderTime', 'createdAt']), runId],
        'business_orders', tenantId, { record_key: identity.recordKey }, payload);
      metric.orders += 1; if (amount) metric.orderUnits += decimalToUnits(amount);
    }
  } else if (info.key === 'erp_online_products') {
    if (!Array.isArray(raw)) throw new Error('products source must be an array');
    for (let position = 0; position < raw.length; position += 1) {
      const identity = productIdentity(tenantId, resolveLegacyShopItem(raw[position], sourceContext && sourceContext.shopMap)); await assertShop(client, tenantId, identity.shop);
      const payload = normalizePlatformPayload(info.key, [normalizeLegacyRecord(raw[position])], allowedHosts)[0];
      await insertOrVerify(client, runId, 'product', identity.recordKey,
        `INSERT INTO business_products (tenant_id,record_key,position,offer_id,shop_external_id,platform_source,platform_record_id,payload,updated_by_user_id,migration_run_id)
         VALUES ($1,$2,$3,$4,$5,'ozon',$4,$6::jsonb,$7,$8) ON CONFLICT (tenant_id,record_key) DO NOTHING RETURNING 1`,
        [tenantId, identity.recordKey, position, identity.productId, identity.shop, JSON.stringify(payload), ownerId, runId],
        'business_products', tenantId, { record_key: identity.recordKey }, payload);
      const purchase = firstAmount(payload, ['purchasePrice']);
      const source = firstAmount(payload, ['srcPrice']);
      const shipping = firstAmount(payload, ['domesticShipping']);
      const costInserted = await client.query(
        `INSERT INTO product_costs (tenant_id,product_record_key,purchase_amount,source_amount,domestic_shipping_amount,supplier_url,supplier_note,updated_by_user_id,migration_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,product_record_key) DO NOTHING RETURNING 1`,
        [tenantId, identity.recordKey, purchase, source, shipping, payload.srcUrl || null, payload.srcNote || null, ownerId, runId]);
      let costOwnership = 'inserted';
      if (!costInserted.rowCount) {
        const existingCost = await client.query(
          `SELECT purchase_amount,source_amount,domestic_shipping_amount,supplier_url,supplier_note
           FROM product_costs WHERE tenant_id=$1 AND product_record_key=$2`,
          [tenantId, identity.recordKey]
        );
        const sameAmount = (actual, expected) => (actual == null && expected == null) ||
          (actual != null && expected != null && decimalToUnits(actual) === decimalToUnits(expected));
        const row = existingCost.rows[0];
        if (!row || !sameAmount(row.purchase_amount, purchase) || !sameAmount(row.source_amount, source) ||
            !sameAmount(row.domestic_shipping_amount, shipping) || String(row.supplier_url || '') !== String(payload.srcUrl || '') ||
            String(row.supplier_note || '') !== String(payload.srcNote || '')) {
          throw new Error('deterministic key conflict in product_costs');
        }
        costOwnership = 'matched_existing';
      }
      await recordOwnership(client, runId, tenantId, 'product_cost', identity.recordKey, costOwnership, {
        purchase, source, shipping, supplierUrl: payload.srcUrl || null, supplierNote: payload.srcNote || null
      });
      metric.products += 1; if (purchase) metric.costUnits += decimalToUnits(purchase);
    }
  } else if (FINANCE_KEYS.has(info.key)) {
    const entries = Array.isArray(raw) ? raw.map((value, index) => [String(index), value]) : Object.entries(raw || {});
    for (let position = 0; position < entries.length; position += 1) {
      const [entryKey, original] = entries[position];
      if (sourceContext && sourceContext.orderIndexError) throw sourceContext.orderIndexError;
      const identity = resolveMigrationFinanceIdentity(
        tenantId,
        info.key,
        Array.isArray(raw) ? String(position) : entryKey,
        original,
        sourceContext && sourceContext.orderShopIndex,
        !Array.isArray(raw)
      );
      if (!identity.unallocated) await assertShop(client, tenantId, identity.shop);
      const payload = normalizePlatformPayload(info.key, { [identity.transactionId]: normalizeLegacyRecord(original) }, allowedHosts)[identity.transactionId];
      const amount = financeAmount(payload);
      const units = amount ? decimalToUnits(amount) : 0n;
      const debit = units < 0n ? unitsToDecimal(-units) : '0.0000';
      const credit = units > 0n ? unitsToDecimal(units) : '0.0000';
      await insertOrVerify(client, runId, 'financial_record', info.key + '::' + identity.recordKey,
        `INSERT INTO financial_records (tenant_id,document_key,record_key,position,order_record_key,platform_source,platform_record_id,payload,updated_by_user_id,amount,debit_amount,credit_amount,currency,occurred_at,migration_run_id)
         VALUES ($1,$2,$3,$4,$5,'ozon',$6,$7::jsonb,$8,$9,$10,$11,'RUB',$12,$13) ON CONFLICT (tenant_id,document_key,record_key) DO NOTHING RETURNING 1`,
        [tenantId, info.key, identity.recordKey, position, identity.posting || null, identity.transactionId, JSON.stringify(payload), ownerId, amount, debit, credit, firstTime(payload, ['occurredAt', 'operation_date', 'accrual_date', 'createdAt']), runId],
        'financial_records', tenantId, { document_key: info.key, record_key: identity.recordKey }, payload);
      metric.financial += 1;
      if (identity.unallocated) metric.unallocatedFinancial += 1;
      metric.debitUnits += decimalToUnits(debit);
      metric.creditUnits += decimalToUnits(credit);
    }
  } else if (info.key === 'erp_bug_reports') {
    if (!Array.isArray(raw)) throw new Error('bug reports source must be an array');
    for (const report of raw) {
      const reportId = String(report && report.id || '');
      if (!/^BUG-[A-Z0-9-]{6,80}$/.test(reportId)) throw new Error('bug report deterministic id is invalid');
      let reportCreatorId = ownerId;
      if (String(report.createdBy || '').trim()) {
        const creator = await client.query(
          `SELECT u.id FROM users u JOIN tenant_members tm ON tm.user_id=u.id
           WHERE tm.tenant_id=$1 AND tm.status='active' AND lower(u.username)=lower($2)`,
          [tenantId, String(report.createdBy).trim()]
        );
        if (creator.rowCount !== 1) throw new Error(`bug report creator is not an exact tenant member: ${reportId}`);
        reportCreatorId = creator.rows[0].id;
      }
      const payload = { ...normalizeLegacyRecord(report) }; delete payload.id; delete payload.createdBy; delete payload.attachments; delete payload.createdAt;
      const reportTitle = String(report.title || '未命名反馈').slice(0, 120);
      const reportSeverity = ['high','medium','low'].includes(report.severity) ? report.severity : 'medium';
      const reportCreatedAt = report.createdAt ? normalizeLegacyRecord({ createdAt: report.createdAt }).createdAt : now();
      const reportInserted = await client.query(
        `INSERT INTO bug_reports (tenant_id,report_id,created_by_user_id,title,severity,payload,created_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (tenant_id,report_id) DO NOTHING RETURNING 1`,
        [tenantId, reportId, reportCreatorId, reportTitle, reportSeverity, JSON.stringify(payload), reportCreatedAt]);
      let reportOwnership = 'inserted';
      if (!reportInserted.rowCount) {
        const existingReport = await client.query(
          `SELECT created_by_user_id::text,title,severity,payload,created_at FROM bug_reports WHERE tenant_id=$1 AND report_id=$2`,
          [tenantId, reportId]
        );
        const row = existingReport.rows[0];
        if (!row || String(row.created_by_user_id) !== String(reportCreatorId) || row.title !== reportTitle || row.severity !== reportSeverity ||
            canonicalJson(row.payload) !== canonicalJson(payload) || new Date(row.created_at).toISOString() !== new Date(reportCreatedAt).toISOString()) {
          throw new Error('deterministic key conflict in bug_reports');
        }
        reportOwnership = 'matched_existing';
      }
      await recordOwnership(client, runId, tenantId, 'bug_report', reportId, reportOwnership, {
        createdByUserId: String(reportCreatorId), title: reportTitle, severity: reportSeverity, payload, createdAt: new Date(reportCreatedAt).toISOString()
      });
      for (const attachment of Array.isArray(report.attachments) ? report.attachments : []) {
        const attachmentId = String(attachment && attachment.id || '');
        const storedName = path.basename(String(attachment && attachment.url || ''));
        if (!/^[a-f0-9-]{36}$/i.test(attachmentId) || !/^[a-f0-9-]{36}\.(?:jpg|png|gif|webp|mp4|webm|mov)$/i.test(storedName)) {
          throw new Error(`bug attachment key is invalid: ${reportId}`);
        }
        const attachmentValue = {
          reportId, attachmentId, createdByUserId: String(reportCreatorId),
          originalName: String(attachment.name || '附件').slice(0, 160), storedName,
          mediaType: String(attachment.type || 'application/octet-stream').slice(0, 80), sizeBytes: Math.max(1, Number(attachment.size) || 1)
        };
        const attachmentInserted = await client.query(
          `INSERT INTO bug_attachments (tenant_id,report_id,attachment_id,created_by_user_id,original_name,stored_name,media_type,size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,attachment_id) DO NOTHING RETURNING 1`,
          [tenantId, reportId, attachmentId, reportCreatorId, attachmentValue.originalName, storedName,
            attachmentValue.mediaType, attachmentValue.sizeBytes]);
        let attachmentOwnership = 'inserted';
        if (!attachmentInserted.rowCount) {
          const existingAttachment = await client.query(
            `SELECT report_id,created_by_user_id::text,original_name,stored_name,media_type,size_bytes
             FROM bug_attachments WHERE tenant_id=$1 AND attachment_id=$2`,
            [tenantId, attachmentId]
          );
          const row = existingAttachment.rows[0];
          if (!row || row.report_id !== reportId || String(row.created_by_user_id) !== String(reportCreatorId) ||
              row.original_name !== attachmentValue.originalName || row.stored_name !== storedName || row.media_type !== attachmentValue.mediaType ||
              Number(row.size_bytes) !== attachmentValue.sizeBytes) throw new Error('deterministic key conflict in bug_attachments');
          attachmentOwnership = 'matched_existing';
        }
        await recordOwnership(client, runId, tenantId, 'bug_attachment', reportId + '::' + attachmentId, attachmentOwnership, attachmentValue);
      }
    }
  }
  if (info.key === 'erp_orders_data' || info.key === 'erp_online_products' || FINANCE_KEYS.has(info.key) || info.key === 'erp_bug_reports') {
    const shape = Array.isArray(raw) ? 'array' : (raw && typeof raw === 'object' ? 'object' : 'scalar');
    await client.query(
      `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
       VALUES ($1,$2,1,$3,$4) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
      [tenantId, info.key, shape, ownerId]
    );
  }
}

function objectKind(entry) { return ['category_snapshot', 'logistics_file', 'bug_attachment'].includes(entry.sourceKind) ? entry.sourceKind : ''; }

function migrationObjectKey(entry) {
  const kind = objectKind(entry);
  if (!kind) return '';
  const tenantId = String(entry && entry.tenantId || '');
  const sha256 = String(entry && entry.sha256 || '').toLowerCase();
  if (!/^\d+$/.test(tenantId)) throw new Error('private object tenant id is required');
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('private object SHA-256 is invalid');
  const extension = path.extname(String(entry && entry.relativePath || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  return `${tenantId}/${kind}/${sha256.slice(0, 2)}/${sha256}${extension}`;
}

async function migrate() {
  const inventoryFile = arg('inventory'); const backupFile = arg('backup');
  if (!inventoryFile || !backupFile) throw new Error('--inventory and --backup are required');
  const manifest = ensureManifest(readJson(inventoryFile), 'inventory');
  const backupManifest = ensureManifest(readJson(backupFile), 'backup');
  if (backupManifest.runId !== manifest.runId || backupManifest.sourceManifestSha256 !== manifest.manifestSha256) throw new Error('backup does not match inventory');
  await verifySources(manifest);
  const allowedHosts = supplierHosts(process.env.ERP_SUPPLIER_HOST_ALLOWLIST);
  const metrics = new Map();
  const sourceContexts = buildSourceContexts(manifest);
  const unallocatedPreflight = [];
  for (const entry of manifest.files) {
    const info = documentInfo(entry);
    if (info && (info.key === 'erp_orders_data' || info.key === 'erp_online_products' || FINANCE_KEYS.has(info.key) || info.key === 'erp_bug_reports')) {
      const raw = readJson(sourceFile(entry));
      const sourceContext = sourceContexts.get(String(info.tenantId));
      if (info.key === 'erp_orders_data') raw.forEach(item => orderIdentity(info.tenantId, resolveLegacyShopItem(item, sourceContext && sourceContext.shopMap)));
      else if (info.key === 'erp_online_products') raw.forEach(item => productIdentity(info.tenantId, resolveLegacyShopItem(item, sourceContext && sourceContext.shopMap)));
      else if (FINANCE_KEYS.has(info.key)) {
        if (sourceContext && sourceContext.orderIndexError) throw sourceContext.orderIndexError;
        const objectShape = !Array.isArray(raw);
        (Array.isArray(raw) ? raw.map((value, index) => [String(index), value]) : Object.entries(raw || {})).forEach(([key, item]) => {
          const identity = resolveMigrationFinanceIdentity(info.tenantId, info.key, key, item, sourceContext && sourceContext.orderShopIndex, objectShape);
          if (identity.unallocated) unallocatedPreflight.push({ tenantId: String(info.tenantId), documentKey: info.key, recordKey: identity.recordKey });
        });
      }
    }
    if (info && info.key === 'erp_shops_data') validateShopRecords(readJson(sourceFile(entry)));
    if (objectKind(entry) && !entry.tenantId) throw new Error(`object lacks deterministic tenant key: ${entry.relativePath}`);
    if (entry.sourceKind === 'legacy_json' && !entry.tenantId && /^(?:erp_orders_data|erp_online_products|erp_accruals_data|erp_acquiring_data|erp_amount_fix_v1|erp_bug_reports)\.json$/i.test(entry.relativePath)) {
      throw new Error(`root legacy JSON has no deterministic tenant key: ${entry.relativePath}`);
    }
  }
  if (!has('apply')) {
    console.log(`P2 migration dry-run: ${manifest.files.length} frozen file(s) validated; encrypted backup verified; no database or object writes performed`);
    if (unallocatedPreflight.length) {
      console.log(`P2 migration dry-run: ${unallocatedPreflight.length} legacy acquiring record(s) will be preserved without order attribution: ${unallocatedPreflight.map(item => `${item.tenantId}/${item.recordKey}`).join(', ')}`);
    }
    return;
  }
  const client = new Client(createDatabaseConfig({ migration: true }));
  const objectStore = new PrivateObjectStore(OBJECT_DIR);
  await client.connect();
  try {
    await client.query('BEGIN');
    const createdRun = await client.query(
      `INSERT INTO migration_runs (run_id,status,source_manifest_sha256,backup_manifest_sha256,started_at,metadata)
       VALUES ($1,'migrating',$2,$3,$4,$5::jsonb) ON CONFLICT (run_id) DO NOTHING RETURNING run_id`,
      [manifest.runId, manifest.manifestSha256, backupManifest.manifestSha256, manifest.createdAt, JSON.stringify({ inventoryFile: path.basename(inventoryFile), backupArchiveId: backupManifest.archiveId })]);
    if (!createdRun.rowCount) throw new Error('migration run already exists; create a new frozen inventory for a retry');
    await client.query(
      `INSERT INTO legacy_archives (archive_id,run_id,archive_path,cipher,ciphertext_sha256,source_manifest_sha256,created_at,expires_at,read_only)
       VALUES ($1,$2,$3,'AES-256-GCM',$4,$5,$6,$7,true) ON CONFLICT (archive_id) DO NOTHING`,
      [backupManifest.archiveId, manifest.runId, path.resolve(path.dirname(backupFile)), backupManifest.ciphertextSetSha256, manifest.manifestSha256, backupManifest.createdAt, backupManifest.expiresAt]);
    for (const entry of manifest.files) {
      await client.query(
        `INSERT INTO migration_file_inventory (run_id,relative_path,tenant_id,source_kind,size_bytes,sha256,deterministic_key,modified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (run_id,relative_path) DO NOTHING`,
        [manifest.runId, `${entry.root}/${entry.relativePath}`, entry.tenantId, entry.sourceKind, entry.size, entry.sha256, deterministicFileKey(entry), entry.modifiedAt]);
    }
    const tenantIds = [...new Set(manifest.files.map(item => item.tenantId).filter(Boolean))];
    const owners = new Map();
    for (const tenantId of tenantIds) {
      const owner = await client.query(`SELECT user_id FROM tenant_members WHERE tenant_id=$1 AND member_type='owner' AND status='active' ORDER BY created_at LIMIT 1`, [tenantId]);
      if (!owner.rowCount) throw new Error(`tenant ${tenantId} has no active owner`);
      owners.set(tenantId, owner.rows[0].user_id);
    }
    for (const entry of manifest.files) {
      const info = documentInfo(entry);
      if (info && info.key === 'erp_shops_data') await migrateShopsDocument(client, manifest.runId, owners.get(info.tenantId), info, readJson(sourceFile(entry)), entry.modifiedAt);
    }
    for (const entry of manifest.files) {
      const info = documentInfo(entry);
      if (info) await migrateJsonDocument(client, manifest.runId, owners.get(info.tenantId), info, readJson(sourceFile(entry)), allowedHosts, metrics, sourceContexts.get(String(info.tenantId)));
    }
    // Object rows may sort before their JSON metadata paths. Complete every
    // relational/document row first, then bind content-addressed objects.
    for (const entry of manifest.files) {
      const kind = objectKind(entry);
      if (kind) {
        const stored = await objectStore.putFile({ tenantId: entry.tenantId, kind, sourceFile: sourceFile(entry), sha256: entry.sha256 });
        const expectedObjectKey = migrationObjectKey(entry);
        if (stored.objectKey !== expectedObjectKey) throw new Error(`deterministic object key mismatch: ${entry.relativePath}`);
        const objectId = crypto.randomUUID();
        const insertedObject = await client.query(
          `INSERT INTO private_objects (object_id,migration_run_id,tenant_id,object_kind,object_key,storage_backend,size_bytes,sha256,source_relative_path,created_at,object_origin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'migration')
           ON CONFLICT (object_key) DO NOTHING
           RETURNING object_id,tenant_id,object_kind,object_key,storage_backend,size_bytes,sha256,source_relative_path`,
          [objectId, manifest.runId, entry.tenantId, kind, stored.objectKey, stored.backend, stored.size, stored.sha256, `${entry.root}/${entry.relativePath}`, entry.modifiedAt]);
        let savedObject = insertedObject.rows[0] || null;
        let ownership = 'inserted';
        if (!savedObject) {
          const existingObject = await client.query(
            `SELECT object_id,tenant_id,object_kind,object_key,storage_backend,size_bytes,sha256,source_relative_path
             FROM private_objects WHERE object_key=$1`,
            [stored.objectKey]
          );
          if (!existingObject.rowCount) throw new Error(`private object conflict row disappeared: ${entry.relativePath}`);
          savedObject = existingObject.rows[0];
          ownership = 'matched_existing';
        }
        if (String(savedObject.tenant_id) !== String(entry.tenantId) || savedObject.object_kind !== kind || savedObject.object_key !== stored.objectKey ||
            savedObject.storage_backend !== stored.backend || Number(savedObject.size_bytes) !== stored.size || savedObject.sha256 !== stored.sha256) {
          throw new Error(`deterministic key conflict in private_objects: ${entry.relativePath}`);
        }
        const persistedObjectId = savedObject.object_id;
        const objectValue = { kind, objectKey: stored.objectKey, size: stored.size, sha256: stored.sha256, source: `${entry.root}/${entry.relativePath}` };
        await recordOwnership(client, manifest.runId, entry.tenantId, 'private_object', `${kind}::${entry.root}/${entry.relativePath}`,
          ownership, objectValue);
        metricFor(metrics, entry.tenantId).objects += 1;
        if (kind === 'bug_attachment') {
          const match = entry.relativePath.match(/^bug-attachments\/(\d+)\/(BUG-[A-Z0-9-]{6,80})\/([^/]+)$/);
          if (!match || match[1] !== String(entry.tenantId)) throw new Error('bug attachment path is not deterministic');
          const updated = await client.query(
            `UPDATE bug_attachments SET object_id=COALESCE(object_id,$4),sha256=$5,migration_run_id=$6
             WHERE tenant_id=$1 AND report_id=$2 AND stored_name=$3`,
            [entry.tenantId, match[2], match[3], persistedObjectId, entry.sha256, manifest.runId]);
          if (!updated.rowCount) throw new Error(`bug attachment metadata not found: ${entry.relativePath}`);
          metricFor(metrics, entry.tenantId).attachments += 1;
        }
      }
    }
    const reconciliationRows = [];
    for (const [tenantId, source] of metrics) {
      const target = await client.query(
        `SELECT
          (SELECT count(*) FROM migration_record_ownership WHERE run_id=$2 AND tenant_id=$1 AND entity_kind='order')::bigint AS orders,
          (SELECT count(*) FROM migration_record_ownership WHERE run_id=$2 AND tenant_id=$1 AND entity_kind='product')::bigint AS products,
          (SELECT count(*) FROM migration_record_ownership WHERE run_id=$2 AND tenant_id=$1 AND entity_kind='financial_record')::bigint AS financial,
          (SELECT count(*) FROM migration_record_ownership WHERE run_id=$2 AND tenant_id=$1 AND entity_kind='bug_attachment')::bigint AS attachments,
          (SELECT count(*) FROM migration_record_ownership WHERE run_id=$2 AND tenant_id=$1 AND entity_kind='private_object')::bigint AS objects,
          COALESCE((SELECT sum(bo.order_amount) FROM business_orders bo JOIN migration_record_ownership own
            ON own.run_id=$2 AND own.tenant_id=bo.tenant_id AND own.entity_kind='order' AND own.record_key=bo.record_key
            WHERE bo.tenant_id=$1),0) AS order_amount,
          COALESCE((SELECT sum(pc.purchase_amount) FROM product_costs pc JOIN migration_record_ownership own
            ON own.run_id=$2 AND own.tenant_id=pc.tenant_id AND own.entity_kind='product_cost' AND own.record_key=pc.product_record_key
            WHERE pc.tenant_id=$1),0) AS cost_amount,
          COALESCE((SELECT sum(fr.debit_amount) FROM financial_records fr JOIN migration_record_ownership own
            ON own.run_id=$2 AND own.tenant_id=fr.tenant_id AND own.entity_kind='financial_record'
              AND own.record_key=fr.document_key || '::' || fr.record_key WHERE fr.tenant_id=$1),0) AS debit_amount,
          COALESCE((SELECT sum(fr.credit_amount) FROM financial_records fr JOIN migration_record_ownership own
            ON own.run_id=$2 AND own.tenant_id=fr.tenant_id AND own.entity_kind='financial_record'
              AND own.record_key=fr.document_key || '::' || fr.record_key WHERE fr.tenant_id=$1),0) AS credit_amount,
          (SELECT count(*) FROM bug_attachments ba
             JOIN private_objects po ON po.object_id=ba.object_id
             JOIN migration_record_ownership own ON own.run_id=$2 AND own.tenant_id=ba.tenant_id
               AND own.entity_kind='bug_attachment' AND own.record_key=ba.report_id || '::' || ba.attachment_id::text
           WHERE ba.tenant_id=$1 AND ba.sha256<>po.sha256)::bigint AS hash_mismatches,
          (SELECT COALESCE(jsonb_object_agg(ownership,total),'{}'::jsonb) FROM (
             SELECT ownership,count(*)::integer AS total FROM migration_record_ownership
             WHERE run_id=$2 AND tenant_id=$1 GROUP BY ownership
           ) ownership_counts) AS ownership_counts`,
        [tenantId, manifest.runId]);
      const row = target.rows[0];
      const targetCounts = { orders: Number(row.orders), products: Number(row.products), financial: Number(row.financial), attachments: Number(row.attachments), objects: Number(row.objects) };
      const sourceCounts = { orders: source.orders, products: source.products, financial: source.financial, attachments: source.attachments, objects: source.objects };
      const targetOrderUnits = decimalToUnits(row.order_amount);
      const targetCostUnits = decimalToUnits(row.cost_amount);
      const targetDebitUnits = decimalToUnits(row.debit_amount);
      const targetCreditUnits = decimalToUnits(row.credit_amount);
      const balanced = canonicalJson(sourceCounts) === canonicalJson(targetCounts) && source.orderUnits === targetOrderUnits &&
        source.costUnits === targetCostUnits && source.debitUnits === targetDebitUnits && source.creditUnits === targetCreditUnits &&
        (source.creditUnits - source.debitUnits) === (targetCreditUnits - targetDebitUnits) && Number(row.hash_mismatches) === 0;
      const details = {
        ownership: row.ownership_counts || {},
        sourceLedgerNet: unitsToDecimal(source.creditUnits - source.debitUnits),
        targetLedgerNet: unitsToDecimal(targetCreditUnits - targetDebitUnits),
        unallocatedFinancialRecords: source.unallocatedFinancial || 0,
        rule: 'source-target equality; source data is not required to be a zero-sum double-entry ledger'
      };
      await client.query(
        `INSERT INTO migration_reconciliation (run_id,tenant_id,source_counts,target_counts,source_order_amount,target_order_amount,source_cost_amount,target_cost_amount,debit_amount,credit_amount,attachment_count,attachment_hash_mismatches,balanced,details)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
        [manifest.runId, tenantId, JSON.stringify(sourceCounts), JSON.stringify(targetCounts), unitsToDecimal(source.orderUnits), row.order_amount,
          unitsToDecimal(source.costUnits), row.cost_amount, row.debit_amount, row.credit_amount, source.attachments, row.hash_mismatches, balanced, JSON.stringify(details)]);
      reconciliationRows.push({
        tenantId, sourceCounts, targetCounts,
        sourceOrderAmount: unitsToDecimal(source.orderUnits), targetOrderAmount: unitsToDecimal(targetOrderUnits),
        sourceCostAmount: unitsToDecimal(source.costUnits), targetCostAmount: unitsToDecimal(targetCostUnits),
        sourceDebitAmount: unitsToDecimal(source.debitUnits), targetDebitAmount: unitsToDecimal(targetDebitUnits),
        sourceCreditAmount: unitsToDecimal(source.creditUnits), targetCreditAmount: unitsToDecimal(targetCreditUnits),
        ledgerNet: details.targetLedgerNet, ownership: details.ownership, unallocatedFinancialRecords: details.unallocatedFinancialRecords,
        attachmentHashMismatches: Number(row.hash_mismatches), balanced
      });
    }
    const reconciliation = { version: 1, runId: manifest.runId, createdAt: now(), tenants: reconciliationRows.sort((a, b) => String(a.tenantId).localeCompare(String(b.tenantId), 'en')) };
    reconciliation.acceptable = reconciliation.tenants.length > 0 && reconciliation.tenants.every(item => item.balanced);
    reconciliation.manifestSha256 = manifestHash(reconciliation);
    await client.query(`UPDATE migration_runs SET status='reconciled',completed_at=now(),reconciliation_sha256=$2 WHERE run_id=$1`, [manifest.runId, reconciliation.manifestSha256]);
    await client.query('COMMIT');
    const reportFile = path.join(WORK_DIR, `reconciliation-${manifest.runId}.json`);
    writeJsonExclusive(reportFile, reconciliation);
    console.log(reportFile);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
  console.log(`P2 migration reconciled: ${manifest.runId}; no legacy data deleted`);
}

async function acceptOrCutover(command) {
  if (!has('apply')) throw new Error(`${command} is state-changing; rerun with --apply`);
  const runId = arg('run-id');
  if (!/^[a-f0-9-]{36}$/i.test(runId)) throw new Error('--run-id UUID is required');
  const client = new Client(createDatabaseConfig({ migration: true })); await client.connect();
  try {
    if (command === 'accept') {
      const expected = arg('report-sha256');
      if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('--report-sha256 is required for explicit acceptance');
      const result = await client.query(
        `UPDATE migration_runs SET status='accepted',accepted_at=now()
         WHERE run_id=$1 AND status='reconciled' AND reconciliation_sha256=$2
           AND EXISTS (SELECT 1 FROM migration_reconciliation WHERE run_id=$1)
           AND NOT EXISTS (SELECT 1 FROM migration_reconciliation WHERE run_id=$1 AND balanced=false) RETURNING run_id`,
        [runId, expected.toLowerCase()]);
      if (!result.rowCount) throw new Error('migration is not fully reconciled and balanced');
    } else {
      await client.query('BEGIN');
      try {
        const result = await client.query(`UPDATE migration_runs SET status='cutover',cutover_at=now() WHERE run_id=$1 AND status='accepted' RETURNING run_id,cutover_at`, [runId]);
        if (!result.rowCount) throw new Error('migration must be explicitly accepted before cutover');
        await client.query(
          `INSERT INTO tenant_data_cutovers (tenant_id,run_id,cutover_at)
           SELECT DISTINCT tenant_id,run_id,$2::timestamptz FROM migration_file_inventory WHERE run_id=$1::uuid AND tenant_id IS NOT NULL
           ON CONFLICT (tenant_id) DO UPDATE SET run_id=EXCLUDED.run_id,cutover_at=EXCLUDED.cutover_at`,
          [runId, result.rows[0].cutover_at]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally { await client.end(); }
  console.log(`${command}: ${runId}`);
}

async function retire() {
  if (!has('apply')) throw new Error('retire moves only manifest-listed plaintext into a reversible quarantine; rerun with --apply');
  const inventoryFile = arg('inventory'); const backupFile = arg('backup'); const runId = arg('run-id');
  if (!inventoryFile || !backupFile || !runId || arg('confirm-retire') !== runId) {
    throw new Error('--inventory, --backup, --run-id and matching --confirm-retire are required');
  }
  const manifest = ensureManifest(readJson(inventoryFile), 'inventory');
  const backupManifest = ensureManifest(readJson(backupFile), 'backup');
  if (manifest.runId !== runId || backupManifest.runId !== runId || backupManifest.sourceManifestSha256 !== manifest.manifestSha256) throw new Error('retirement manifests do not match run');
  for (const item of backupManifest.files) {
    const encrypted = path.resolve(path.dirname(backupFile), item.encryptedName);
    if (!pathInside(path.dirname(backupFile), encrypted) || await sha256File(encrypted) !== item.ciphertextSha256) throw new Error(`encrypted rollback copy is invalid: ${item.encryptedName}`);
  }
  await verifySources(manifest);
  const client = new Client(createDatabaseConfig({ migration: true })); await client.connect();
  try {
    const accepted = await client.query(`SELECT 1 FROM migration_runs WHERE run_id=$1 AND status='cutover'`, [runId]);
    if (!accepted.rowCount) throw new Error('plaintext retirement requires completed cutover');
    const candidates = manifest.files.filter(item => ['legacy_json', 'category_snapshot', 'logistics_file', 'bug_attachment'].includes(item.sourceKind));
    for (const entry of candidates) {
      const info = documentInfo(entry);
      if (info) {
        const relational = info.key === 'erp_orders_data' || info.key === 'erp_online_products' || FINANCE_KEYS.has(info.key) || info.key === 'erp_bug_reports';
        const target = relational
          ? await client.query(`SELECT 1 FROM business_data_versions WHERE tenant_id=$1 AND document_key=$2`, [info.tenantId, info.key])
          : await client.query(`SELECT 1 FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2`, [info.tenantId, info.key]);
        if (!target.rowCount) throw new Error(`plaintext retirement target is missing: ${entry.relativePath}`);
      }
      if (objectKind(entry)) {
        const target = await client.query(
          `SELECT 1 FROM private_objects WHERE tenant_id=$1 AND object_kind=$2 AND object_key=$3 AND sha256=$4 AND size_bytes=$5`,
          [entry.tenantId, entry.sourceKind, migrationObjectKey(entry), entry.sha256, entry.size]
        );
        if (!target.rowCount) throw new Error(`private object target is missing: ${entry.relativePath}`);
      }
    }
    const quarantineRoot = path.resolve(WORK_DIR, 'retired', runId);
    if (!pathInside(WORK_DIR, quarantineRoot)) throw new Error('retirement quarantine escaped work directory');
    const moved = [];
    try {
      for (const entry of candidates) {
        const source = sourceFile(entry);
        const target = path.resolve(quarantineRoot, entry.root, ...entry.relativePath.split('/'));
        if (!pathInside(quarantineRoot, target)) throw new Error('retirement target escaped quarantine');
        if (fs.existsSync(target)) throw new Error(`retirement quarantine target already exists: ${entry.relativePath}`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
        if (!fs.existsSync(target) || await sha256File(target) !== entry.sha256) throw new Error(`retirement quarantine verification failed: ${entry.relativePath}`);
        moved.push({ entry, source, target });
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        if (fs.existsSync(item.target) && !fs.existsSync(item.source)) {
          fs.mkdirSync(path.dirname(item.source), { recursive: true });
          fs.renameSync(item.target, item.source);
        }
      }
      throw error;
    }
    const receipt = {
      version: 2, runId, retiredAt: now(), reversible: true, purged: false,
      sourceManifestSha256: manifest.manifestSha256,
      quarantineRoot,
      files: moved.map(item => ({ root: item.entry.root, relativePath: item.entry.relativePath, sha256: item.entry.sha256,
        quarantineRelativePath: path.relative(quarantineRoot, item.target).replace(/\\/g, '/') }))
    };
    receipt.manifestSha256 = manifestHash(receipt);
    const receiptFile = path.join(WORK_DIR, `retirement-${runId}.json`);
    writeJsonExclusive(receiptFile, receipt);
    await client.query(`UPDATE migration_runs SET metadata=metadata || $2::jsonb WHERE run_id=$1`, [runId, JSON.stringify({ retirementReceiptSha256: receipt.manifestSha256, retiredAt: receipt.retiredAt })]);
    console.log(receiptFile);
  } finally { await client.end(); }
}

async function restoreRetired() {
  if (!has('apply')) throw new Error('restore-retired changes files; rerun with --apply');
  const receiptFile = arg('receipt');
  if (!receiptFile) throw new Error('--receipt is required');
  const receipt = ensureManifest(readJson(receiptFile), 'retirement receipt');
  if (receipt.version !== 2 || receipt.reversible !== true || !Array.isArray(receipt.files)) throw new Error('retirement receipt is not reversible');
  const quarantineRoot = path.resolve(receipt.quarantineRoot || '');
  if (!pathInside(WORK_DIR, quarantineRoot)) throw new Error('retirement quarantine is outside work directory');
  const restored = [];
  try {
    for (const item of receipt.files) {
      const source = path.resolve(quarantineRoot, ...String(item.quarantineRelativePath || '').split('/'));
      const root = ROOTS.find(candidate => candidate.name === item.root);
      if (!root || !pathInside(quarantineRoot, source)) throw new Error('invalid retirement receipt path');
      const target = path.resolve(root.path, ...String(item.relativePath || '').split('/'));
      if (!pathInside(root.path, target) || fs.existsSync(target)) throw new Error(`restore target is not empty: ${item.relativePath}`);
      if (!fs.existsSync(source) || await sha256File(source) !== item.sha256) throw new Error(`quarantined file hash mismatch: ${item.relativePath}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      restored.push({ source, target });
    }
  } catch (error) {
    for (const item of restored.reverse()) {
      if (fs.existsSync(item.target) && !fs.existsSync(item.source)) {
        fs.mkdirSync(path.dirname(item.source), { recursive: true });
        fs.renameSync(item.target, item.source);
      }
    }
    throw error;
  }
  console.log(`restored ${restored.length} quarantined file(s)`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'freeze') return freeze();
  if (command === 'inventory') return inventory();
  if (command === 'backup') return backup();
  if (command === 'restore') return restore();
  if (command === 'migrate') return migrate();
  if (command === 'accept' || command === 'cutover') return acceptOrCutover(command);
  if (command === 'retire') return retire();
  if (command === 'restore-retired') return restoreRetired();
  throw new Error('usage: p2-data-migration <freeze|inventory|backup|restore|migrate|accept|cutover|retire|restore-retired>');
}

if (require.main === module) main().catch(error => { console.error(`P2 migration failed: ${error.message}`); process.exitCode = 1; });

module.exports = {
  documentInfo, firstAmount, financeAmount, resolveMigrationFinanceIdentity,
  sourceFile, ensureManifest, parseTenantIdList, filterInventoryFiles, rebuildableRuntimeExclusion, partitionInventoryFiles,
  validateShopRecords, targetIsNewerThanSource, sameShopIdentitySet, sourceShopIdentitySubsetOfTarget, loadMigrationCredentialKey,
  migrationObjectKey
};
