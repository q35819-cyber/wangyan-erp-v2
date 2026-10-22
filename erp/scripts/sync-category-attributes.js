#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PostgresAuthStore } = require('../auth/postgres-store');
const { parseCredentialKey, decryptShopCredentials } = require('../auth/credential-crypto');
const { syncCategoryAttributes } = require('../auth/category-attribute-sync');

const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(__dirname, '..', 'data'));
const USERNAME = (process.argv.find(arg => arg.startsWith('--username=')) || '').slice('--username='.length);
const FORCE = process.argv.includes('--force');

function credentialKey() {
  if (process.env.ERP_CREDENTIALS_KEY) return parseCredentialKey(process.env.ERP_CREDENTIALS_KEY);
  const file = path.resolve(process.env.ERP_CREDENTIALS_KEY_FILE || path.join(__dirname, '..', '..', '本机数据', '配置', 'credentials.key'));
  if (!fs.existsSync(file)) throw new Error('找不到店铺密钥解密文件');
  return parseCredentialKey(fs.readFileSync(file, 'utf8'));
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function requester(shop) {
  return async function request(endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch('https://api-seller.ozon.ru' + endpoint, {
        method: 'POST', headers: { 'Client-Id': String(shop.clientId), 'Api-Key': String(shop.apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}), signal: controller.signal
      });
      const raw = await response.text();
      let payload;
      try { payload = raw ? JSON.parse(raw) : null; }
      catch (error) { const invalid = new Error('invalid response'); invalid.retryable = response.status >= 500; throw invalid; }
      if (!response.ok) {
        const upstream = new Error(String(payload && payload.message || `OZON HTTP ${response.status}`).slice(0, 500));
        upstream.status = response.status; upstream.retryable = response.status === 429 || response.status >= 500;
        const retryAfter = Number(response.headers.get('retry-after')); if (retryAfter > 0) upstream.retryAfterMs = retryAfter * 1000;
        throw upstream;
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') { const timeout = new Error('OZON request timeout'); timeout.retryable = true; throw timeout; }
      if (error.retryable == null) error.retryable = true;
      throw error;
    } finally { clearTimeout(timer); }
  };
}

async function selectAccount(store) {
  const params = [];
  let where = `tm.member_type = 'owner' AND tm.status = 'active'`;
  if (USERNAME) { params.push(USERNAME); where += ` AND lower(u.username) = lower($1)`; }
  const result = await store.pool.query(
    `SELECT u.id::text AS user_id, u.username, tm.tenant_id::text AS tenant_id, tm.display_name
     FROM users u JOIN tenant_members tm ON tm.user_id = u.id
     JOIN tenant_documents td ON td.tenant_id = tm.tenant_id AND td.document_key = 'erp_shops_data'
     WHERE ${where} ORDER BY tm.created_at LIMIT 1`, params
  );
  if (!result.rowCount) throw new Error(USERNAME ? `没有找到主账号 ${USERNAME} 或该账号没有店铺数据` : '没有找到带店铺数据的主账号');
  const row = result.rows[0];
  return { userId: row.user_id, tenantId: row.tenant_id, username: row.username, displayName: row.display_name || row.username, memberType: 'owner', isSystemAdmin: false, permissions: ['*'], shopScopeMode: 'all' };
}

async function main() {
  if (fs.existsSync(path.join(DATA_DIR, '.p2-legacy-json-frozen.json'))) throw new Error('P2 migration source is frozen; category snapshot sync is disabled');
  const store = new PostgresAuthStore();
  const taskId = `sync-category-attributes-cli-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  try {
    const account = await selectAccount(store);
    const shopDocument = await store.getDocument(account, 'erp_shops_data');
    const shops = shopDocument ? decryptShopCredentials(shopDocument.payload, credentialKey(), account.tenantId) : [];
    const shop = (Array.isArray(shops) ? shops : []).find(item => item && item.clientId && item.apiKey);
    if (!shop) throw new Error('主账号没有可用的 OZON 店铺接口密钥');
    const existing = await store.getDocument(account, 'erp_category_attributes');
    const recentTasks = await store.listSyncTasks(account, { type: 'sync', limit: 200 });
    for (const stale of recentTasks.items.filter(item => item.status === 'running' && item.name === '三级类目属性全量同步')) {
      await store.upsertSyncTask(account, {
        id: stale.id, type: 'sync', status: 'failed', value: stale.value, name: stale.name,
        label: '任务已中断，后续同步将从已保存位置续传', reason: '上一次进程已结束，未完成数据不会丢失', startedAt: stale.startedAt
      });
    }
    let lastPercent = -1;
    await store.upsertSyncTask(account, { id: taskId, type: 'sync', status: 'running', value: 1, name: '三级类目属性全量同步', label: '正在读取类目树', startedAt });
    const result = await syncCategoryAttributes({
      existing: existing && existing.payload, force: FORCE,
      delayMs: Number(process.env.ERP_CATEGORY_ATTRIBUTE_DELAY_MS || 650), batchSize: Number(process.env.ERP_CATEGORY_ATTRIBUTE_BATCH_SIZE || 100),
      concurrency: Number(process.env.ERP_CATEGORY_ATTRIBUTE_CONCURRENCY || 6),
      request: requester(shop),
      persist: async (library, treeDocument) => {
        await store.putLargeDocument(account, 'erp_category_attributes', library);
        await store.putDocument(account, 'erp_category_tree', treeDocument);
        atomicJson(path.join(DATA_DIR, 'category-attributes', `tenant-${account.tenantId}.json`), library);
      },
      progress: async (library, category, stage) => {
        const percent = Math.max(1, Math.min(99, Math.floor(library.processedCategories / Math.max(1, library.totalCategories) * 100)));
        if (percent === lastPercent) return;
        lastPercent = percent;
        const pathText = category.path.map(item => item.name).join(' > ');
        process.stdout.write(`${percent}% ${library.processedCategories}/${library.totalCategories} ${stage} ${pathText}\n`);
        await store.upsertSyncTask(account, { id: taskId, type: 'sync', status: 'running', value: percent, name: '三级类目属性全量同步', label: `${stage} · ${pathText}`, startedAt });
      }
    });
    const failed = result.summary.failedCategories;
    await store.upsertSyncTask(account, { id: taskId, type: 'sync', status: failed ? 'failed' : 'done', value: 100, name: '三级类目属性全量同步', label: failed ? `完成采集，失败 ${failed} 个类目` : '全部三级类目属性获取完成', reason: failed ? `仍有 ${failed} 个三级类目未获取，中文原因已保存` : '', startedAt });
    await store.recordAudit(account, 'category.attributes.sync', 'tenant_document', 'erp_category_attributes', failed ? 'failed' : 'success', result.summary);
    console.log('CATEGORY_ATTRIBUTE_SUMMARY=' + JSON.stringify(result.summary));
    console.log('CATEGORY_ATTRIBUTE_FAILURES=' + JSON.stringify(result.library.failures));
    if (failed) process.exitCode = 2;
  } finally { await store.close(); }
}

main().catch(error => { console.error('类目属性同步失败：' + error.message); process.exitCode = 1; });
