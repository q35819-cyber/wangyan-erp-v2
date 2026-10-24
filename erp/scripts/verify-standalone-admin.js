#!/usr/bin/env node
'use strict';
// Read-only guard after *new*, isolated Windows desktop initialization.
// No password is printed or saved; never updates existing accounts.
const {Client} = require('pg');
const {createDatabaseConfig} = require('../db/config');
const {verifyPassword} = require('../auth/password');
async function main() {
  if (process.env.WYERP_STANDALONE_MODE !== '1' ||
      process.env.PGHOST !== '127.0.0.1' ||
      process.env.PGDATABASE !== 'wyerp_community_local' ||
      process.env.DATABASE_URL || process.env.DATABASE_MIGRATION_URL) {
    throw new Error('拒绝在非独立单机本地空库环境执行管理员初始校验');
  }
  const client = new Client(createDatabaseConfig());
  await client.connect();
  try {
    const {rows} = await client.query(
      "SELECT username,password_hash,status,is_system_admin FROM users WHERE username = 'admin'"
    );
    const adminCount = await client.query('SELECT count(*)::integer AS n FROM users WHERE is_system_admin = true');
    if (rows.length !== 1 || adminCount.rows[0].n !== 1 ||
        rows[0].status !== 'active' || rows[0].is_system_admin !== true ||
        !(await verifyPassword('123456', rows[0].password_hash))) {
      throw new Error('首次admin账户或初始密码验收失败');
    }
    console.log('PASS 隔离数据库中的唯一admin账号及初始密码验证通过（不输出哈希或凭据）');
  } finally { await client.end(); }
}
main().catch(e => {
  console.error('FAIL 本机管理员初始化校验：' + String(e.message || e).slice(0,200));
  process.exitCode = 1;
});