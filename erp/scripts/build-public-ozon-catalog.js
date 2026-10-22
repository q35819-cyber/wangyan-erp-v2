#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { buildPublicCategoryCatalog } = require('../auth/public-category-catalog');

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const position = args.indexOf(name); return position < 0 ? null : args[position + 1]; };
  const sourceFile = value('--source');
  const rootDir = value('--root');
  if (!sourceFile || !rootDir) throw new Error('用法：node scripts/build-public-ozon-catalog.js --source 已核验源文件 --root 隔离公共目录 [--activate]');
  const result = await buildPublicCategoryCatalog({
    sourceFile: path.resolve(sourceFile), rootDir: path.resolve(rootDir), activate: args.includes('--activate')
  });
  console.log(JSON.stringify({ version: result.version, categoryCount: result.categoryCount,
    shardCount: result.shardCount, sourceSha256: result.sourceSha256, activated: result.activated }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
