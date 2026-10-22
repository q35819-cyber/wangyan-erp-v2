'use strict';

const fs = require('fs');
const path = require('path');
const { buildBase, writeAtomic } = require('../auth/ozon-commission-catalog');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const tenantId = String(process.argv[2] || '1');
  const source = path.join(root, '本机数据', 'Ozon', '佣金', 'Ozon中国卖家类目佣金表-2025-12-01.xlsx');
  const output = path.join(root, 'erp', 'data', 'commission-rates', 'ozon-china-commissions.json');
  const catalog = await buildBase({
    workbookPath: source,
    treePath: path.join(root, 'erp', 'data', 'tenants', tenantId, 'erp_category_tree.json'),
    localizedCatalogPath: path.join(root, 'erp', 'data', 'category-attributes', 'tenant-' + tenantId + '.json')
  });
  await writeAtomic(output, catalog);
  process.stdout.write(JSON.stringify({ output, counts: catalog.counts }) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
