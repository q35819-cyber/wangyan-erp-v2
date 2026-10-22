#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createDatabaseConfig } = require('./config');
const { parseCredentialKey, encryptShopCredentials, hasPlaintextShopCredentials } = require('../auth/credential-crypto');

function loadKey() {
  if (process.env.ERP_CREDENTIALS_KEY) return parseCredentialKey(process.env.ERP_CREDENTIALS_KEY);
  if (process.env.NODE_ENV === 'production') throw new Error('ERP_CREDENTIALS_KEY is required in production');
  const file = path.resolve(process.env.ERP_CREDENTIALS_KEY_FILE || path.join(__dirname, '..', '..', '本机数据', '配置', 'credentials.key'));
  if (!fs.existsSync(file)) throw new Error(`Development credential key does not exist: ${file}. Start the application once first.`);
  return parseCredentialKey(fs.readFileSync(file, 'utf8'));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const key = loadKey();
  const pool = new Pool(createDatabaseConfig({ migration: true }));
  let scanned = 0;
  let plaintext = 0;
  let updated = 0;
  try {
    const result = await pool.query(
      `SELECT tenant_id, payload, version FROM tenant_documents
       WHERE document_key = 'erp_shops_data' ORDER BY tenant_id`
    );
    scanned = result.rowCount;
    for (const row of result.rows) {
      if (!hasPlaintextShopCredentials(row.payload)) continue;
      plaintext += 1;
      if (!apply) continue;
      const encrypted = encryptShopCredentials(row.payload, key, row.tenant_id);
      const saved = await pool.query(
        `UPDATE tenant_documents
         SET payload = $3::jsonb, version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND document_key = 'erp_shops_data' AND version = $2`,
        [row.tenant_id, row.version, JSON.stringify(encrypted)]
      );
      if (saved.rowCount !== 1) throw new Error(`Concurrent update detected for tenant ${row.tenant_id}; no data was overwritten`);
      updated += 1;
    }
  } finally {
    await pool.end();
  }
  console.log(`shop credential encryption: scanned=${scanned}, plaintext=${plaintext}, updated=${updated}, mode=${apply ? 'apply' : 'dry-run'}`);
}

main().catch(error => {
  console.error('shop credential encryption failed:', error.message);
  process.exitCode = 1;
});
