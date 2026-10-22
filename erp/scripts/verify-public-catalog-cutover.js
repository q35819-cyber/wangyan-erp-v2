#!/usr/bin/env node
'use strict';

const { verifyPublicCatalogFiles } = require('../auth/public-category-release-check');
async function main() {
  const args = process.argv.slice(2);
  const option = name => { const at = args.indexOf(name); return at < 0 ? '' : args[at + 1] || ''; };
  const rootDir = option('--root');
  const sourceFile = option('--source');
  if (!rootDir || !sourceFile || args.some(flag => !['--root', '--source', rootDir, sourceFile].includes(flag))) {
    throw new Error('用法：node scripts/verify-public-catalog-cutover.js --root 公共目录 --source 已核验来源文件');
  }
  const report = await verifyPublicCatalogFiles({ rootDir, sourceFile });
  console.log(JSON.stringify(report, null, 2));
  console.error('仅完成静态文件预检：尚需全部租户差异对账、独立PG联测和Release授权；本工具不执行正式切换。');
}
main().catch(error => { console.error('公共类目静态预检失败：' + error.message); process.exitCode = 1; });
