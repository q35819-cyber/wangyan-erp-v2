#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { PostgresAuthStore } = require('../auth/postgres-store');
const { normalizeLibrary, summarizeLibrary } = require('../auth/category-attribute-library');

const username = (process.argv.find(arg => arg.startsWith('--username=')) || '').slice('--username='.length);

async function main() {
  const store = new PostgresAuthStore();
  try {
    const params = [];
    let userFilter = '';
    if (username) { params.push(username); userFilter = 'AND lower(u.username) = lower($1)'; }
    const selected = await store.pool.query(
      `SELECT u.id::text AS user_id, u.username, tm.tenant_id::text AS tenant_id, tm.display_name
       FROM users u JOIN tenant_members tm ON tm.user_id = u.id
       JOIN tenant_documents td ON td.tenant_id = tm.tenant_id AND td.document_key = 'erp_category_attributes'
       WHERE tm.member_type = 'owner' AND tm.status = 'active' ${userFilter}
       ORDER BY td.updated_at DESC LIMIT 1`, params
    );
    if (!selected.rowCount) throw new Error('没有找到可验证的三级类目属性库');
    const row = selected.rows[0];
    const account = { userId: row.user_id, username: row.username, tenantId: row.tenant_id, displayName: row.display_name || row.username, memberType: 'owner', permissions: ['*'] };
    const document = await store.getDocument(account, 'erp_category_attributes');
    const library = normalizeLibrary(document && document.payload);
    const summary = summarizeLibrary(library);
    const emptyCategories = Object.values(library.categories).filter(item => !Array.isArray(item.required) || !Array.isArray(item.optional) || item.required.length + item.optional.length === 0).length;
    const dataDir = path.resolve(process.env.ERP_DATA_DIR || path.join(__dirname, '..', 'data'));
    const snapshot = path.join(dataDir, 'category-attributes', `tenant-${account.tenantId}.json`);
    const snapshotBytes = fs.existsSync(snapshot) ? fs.statSync(snapshot).size : 0;
    const tasks = await store.listSyncTasks(account, { type: 'sync', limit: 200 });
    const staleRunningTasks = tasks.items.filter(item => item.status === 'running' && item.name === '三级类目属性全量同步').length;
    const result = { ...summary, emptyCategories, snapshotExists: snapshotBytes > 0, snapshotBytes, documentVersion: document && document.version, staleRunningTasks };
    console.log('CATEGORY_ATTRIBUTE_VERIFY=' + JSON.stringify(result));
    if (summary.status !== 'done' || summary.processedCategories !== summary.totalCategories || summary.successfulCategories !== summary.totalCategories || summary.failedCategories || emptyCategories || !snapshotBytes || staleRunningTasks) process.exitCode = 2;
  } finally { await store.close(); }
}

main().catch(error => { console.error('类目属性库验证失败：' + error.message); process.exitCode = 1; });
