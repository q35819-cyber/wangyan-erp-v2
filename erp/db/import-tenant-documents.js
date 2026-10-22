#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createDatabaseConfig } = require('./config');
const { PostgresAuthStore } = require('../auth/postgres-store');
const { RELATIONAL_BUSINESS_KEYS, normalizePlatformPayload, supplierHosts } = require('../auth/business-boundaries');

const ERP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(ERP_DIR, 'data'));
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const P2_FREEZE_MARKER = path.join(DATA_DIR, '.p2-legacy-json-frozen.json');
const APPLY = process.argv.includes('--apply');
const ALLOWED_KEYS = new Set([
  'erp_shops_data', 'erp_orders_data', 'erp_accrual_types', 'erp_accruals_data',
  'erp_acquiring_data', 'erp_rate', 'erp_fee_manual', 'erp_amount_fix_v1',
  'erp_online_products', 'erp_online_product_manual', 'erp_collected_products', 'erp_favorite_products', 'erp_online_categories',
  'erp_category_tree', 'erp_dev_manual_backup', 'erp_message_templates', 'erp_message_blacklist', 'erp_ai_analysis_rules',
  'erp_message_sendlog', 'erp_promotion_rules', 'erp_watermark_templates',
  'erp_shop_groups', 'erp_bug_reports'
]);

function candidates() {
  if (!fs.existsSync(TENANTS_DIR)) return [];
  const output = [];
  for (const entry of fs.readdirSync(TENANTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const directory = path.join(TENANTS_DIR, entry.name);
    for (const file of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile() || path.extname(file.name).toLowerCase() !== '.json') continue;
      const key = path.basename(file.name, '.json');
      if (!ALLOWED_KEYS.has(key)) continue;
      const raw = fs.readFileSync(path.join(directory, file.name), 'utf8').replace(/^\uFEFF/, '');
      output.push({ tenantId: entry.name, key, payload: JSON.parse(raw) });
    }
  }
  return output;
}

async function main() {
  const items = candidates();
  if (!APPLY) {
    console.log(`tenant document import dry-run: ${items.length} valid document(s); rerun with --apply to import missing rows without overwriting PostgreSQL`);
    return;
  }
  if (fs.existsSync(P2_FREEZE_MARKER)) throw new Error('P2 legacy JSON freeze is active; use db:migrate:p2 instead of the old importer');
  const pool = new Pool(createDatabaseConfig({ pool: true }));
  const store = new PostgresAuthStore({ pool });
  const allowedSupplierHosts = supplierHosts(process.env.ERP_SUPPLIER_HOST_ALLOWLIST);
  let imported = 0, skipped = 0, missingTenant = 0;
  try {
    for (const item of items) {
      const owner = await pool.query(
        `SELECT user_id FROM tenant_members WHERE tenant_id = $1 AND member_type = 'owner' AND status = 'active' LIMIT 1`,
        [item.tenantId]
      );
      if (!owner.rowCount) { missingTenant += 1; continue; }
      const account = {
        tenantId: String(item.tenantId), userId: String(owner.rows[0].user_id),
        username: 'recovery-import', memberType: 'owner', isSystemAdmin: false,
        shopScopeMode: 'all', permissions: ['*']
      };
      if (RELATIONAL_BUSINESS_KEYS.has(item.key)) {
        const existing = await store.getDocument(account, item.key);
        if (existing) { skipped += 1; continue; }
        const payload = normalizePlatformPayload(item.key, item.payload, allowedSupplierHosts);
        await store.putDocument(account, item.key, payload, 0);
        imported += 1;
        continue;
      }
      const result = await pool.query(
        `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
         VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (tenant_id, document_key) DO NOTHING`,
        [item.tenantId, item.key, JSON.stringify(item.payload), owner.rows[0].user_id]
      );
      if (result.rowCount) imported += 1;
      else skipped += 1;
    }
  } finally { await pool.end(); }
  console.log(`tenant document import: PASS (${imported} imported, ${skipped} existing, ${missingTenant} missing tenant)`);
}

main().catch(error => {
  console.error(`tenant document import failed: ${error.message}`);
  process.exitCode = 1;
});
