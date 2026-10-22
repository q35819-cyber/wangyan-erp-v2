#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');
const { createDatabaseConfig } = require('./config');

async function syncData() {
  const pool = new Pool(createDatabaseConfig({ migration: true }));
  const client = await pool.connect();
  const migrationRunId = crypto.randomUUID();
  const updatedByUser = '13';
  try {
    await client.query('BEGIN');

    const dummyHash = '0'.repeat(64);
    await client.query(
      `INSERT INTO migration_runs (run_id, status, source_manifest_sha256, backup_manifest_sha256, started_at, completed_at, metadata)
       VALUES ($1, 'cutover', $2, $3, now(), now(), $4::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [migrationRunId, dummyHash, dummyHash, JSON.stringify({ purpose: 'sync-tenant-documents-to-relational', tenant: '1' })]
    );

    const ordersResult = await client.query("SELECT payload FROM tenant_documents WHERE tenant_id = '1' AND document_key = 'erp_orders_data'");
    if (ordersResult.rowCount > 0) {
      const orders = ordersResult.rows[0].payload;
      if (Array.isArray(orders)) {
        await client.query("DELETE FROM business_orders WHERE tenant_id = '1'");
        for (let i = 0; i < orders.length; i++) {
          const order = orders[i];
          const postingNumber = typeof order.posting === 'string' ? order.posting : (order.posting_number || order.postingNumber || '');
          const orderKey = postingNumber || order.orderId || order.id || ('order-' + i);
          const shopExternalId = order.shop || order.clientId || '';
          const platformSource = order.platform_source || order.platformSource || 'ozon';
          const platformRecordId = postingNumber;
          const orderAmount = order.order_amount || order.orderAmount || order.totalPrice || null;
          const currency = order.currency || 'RUB';
          const occurredAt = order.orderTime || order.occurred_at || order.occurredAt || order.createdAt || order.date || null;
          await client.query(
            `INSERT INTO business_orders (tenant_id, record_key, position, posting_number, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id, updated_at, order_amount, currency, occurred_at, migration_run_id)
             VALUES ('1', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9, $10, $11, $12)
             ON CONFLICT (tenant_id, record_key) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position, updated_at = now()`,
            [orderKey, i, postingNumber, String(shopExternalId), platformSource, platformRecordId, JSON.stringify(order), updatedByUser, orderAmount, currency, occurredAt, migrationRunId]
          );
        }
        console.log('Synced ' + orders.length + ' orders');
      }
    }

    const productsResult = await client.query("SELECT payload FROM tenant_documents WHERE tenant_id = '1' AND document_key = 'erp_online_products'");
    if (productsResult.rowCount > 0) {
      const products = productsResult.rows[0].payload;
      if (Array.isArray(products)) {
        await client.query("DELETE FROM business_products WHERE tenant_id = '1'");
        for (let i = 0; i < products.length; i++) {
          const product = products[i];
          const productId = product.id || product.offerId || product.offer_id || ('product-' + i);
          const shopName = product.shop || '';
          const productKey = shopName ? (shopName + ':' + productId) : String(productId);
          const offerId = product.sku || product.offerId || product.offer_id || productId;
          const shopExternalId = shopName;
          const platformSource = product.platform_source || product.platformSource || 'ozon';
          const platformRecordId = product.platform_record_id || product.platformRecordId || String(productId);
          await client.query(
            `INSERT INTO business_products (tenant_id, record_key, position, offer_id, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id, updated_at, migration_run_id)
             VALUES ('1', $1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), $9)
             ON CONFLICT (tenant_id, record_key) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position, updated_at = now()`,
            [productKey, i, String(offerId), shopExternalId, platformSource, platformRecordId, JSON.stringify(product), updatedByUser, migrationRunId]
          );
        }
        console.log('Synced ' + products.length + ' products');
      }
    }

    const financialKeys = [
      { key: 'erp_accruals_data', shape: 'object' },
      { key: 'erp_acquiring_data', shape: 'object' }
    ];
    for (const { key, shape } of financialKeys) {
      const result = await client.query("SELECT payload FROM tenant_documents WHERE tenant_id = '1' AND document_key = $1", [key]);
      if (result.rowCount > 0 && result.rows[0].payload && typeof result.rows[0].payload === 'object' && !Array.isArray(result.rows[0].payload)) {
        const entries = Object.entries(result.rows[0].payload);
        await client.query("DELETE FROM financial_records WHERE tenant_id = '1' AND document_key = $1", [key]);
        for (let i = 0; i < entries.length; i++) {
          const [recordKey, value] = entries[i];
          await client.query(
            `INSERT INTO financial_records (tenant_id, document_key, record_key, position, platform_source, platform_record_id, payload, updated_by_user_id, updated_at, migration_run_id)
             VALUES ('1', $1, $2, $3, 'ozon', $4, $5::jsonb, $6, now(), $7)
             ON CONFLICT (tenant_id, document_key, record_key) DO UPDATE SET payload = EXCLUDED.payload, position = EXCLUDED.position, updated_at = now()`,
            [key, recordKey, i, recordKey, JSON.stringify(value), updatedByUser, migrationRunId]
          );
        }
        console.log('Synced ' + entries.length + ' financial records for ' + key);
        await client.query(
          `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id, updated_at)
           VALUES ('1', $1, 1, $2, $3, now())
           ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = 1, payload_shape = $2, updated_by_user_id = $3, updated_at = now()`,
          [key, shape, updatedByUser]
        );
      }
    }

    const feeResult = await client.query("SELECT payload FROM tenant_documents WHERE tenant_id = '1' AND document_key = 'erp_fee_manual'");
    if (feeResult.rowCount > 0) {
      await client.query(
        `INSERT INTO finance_settings (tenant_id, setting_key, value, updated_by_user_id, updated_at)
         VALUES ('1', 'erp_fee_manual', $1::jsonb, $2, now())
         ON CONFLICT (tenant_id, setting_key) DO UPDATE SET value = EXCLUDED.value, updated_by_user_id = $2, updated_at = now()`,
        [JSON.stringify(feeResult.rows[0].payload), updatedByUser]
      );
      console.log('Synced erp_fee_manual');
      await client.query(
        `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id, updated_at)
         VALUES ('1', 'erp_fee_manual', 1, 'scalar', $1, now())
         ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = 1, payload_shape = 'scalar', updated_by_user_id = $1, updated_at = now()`,
        [updatedByUser]
      );
    }

    await client.query(
      `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id, updated_at)
       VALUES ('1', 'erp_orders_data', 1, 'array', $1, now())
       ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = 1, payload_shape = 'array', updated_by_user_id = $1, updated_at = now()`,
      [updatedByUser]
    );
    await client.query(
      `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id, updated_at)
       VALUES ('1', 'erp_online_products', 1, 'array', $1, now())
       ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = 1, payload_shape = 'array', updated_by_user_id = $1, updated_at = now()`,
      [updatedByUser]
    );

    await client.query('COMMIT');
    console.log('Data sync complete!');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Sync failed: ' + e.message);
  } finally {
    client.release();
    pool.end();
  }
}

syncData();
