'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { createDatabaseConfig } = require('./config');

const ERP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(ERP_DIR, 'data'));
const P2_FREEZE_MARKER = path.join(DATA_DIR, '.p2-legacy-json-frozen.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const LEGACY_USERS_DIR = path.join(DATA_DIR, 'users');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const APPLY = process.argv.includes('--apply');

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const raw = fs.readFileSync(USERS_FILE, 'utf8').replace(/^\uFEFF/, '');
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error('legacy users.json must contain an array');
  return data;
}

function validateLegacyUser(user) {
  return user && typeof user.username === 'string' && user.username.trim().length >= 2 &&
    /^[a-f0-9]{32}$/i.test(String(user.salt || '')) && /^[a-f0-9]{128}$/i.test(String(user.hash || '')) &&
    path.basename(String(user.id || '')) === String(user.id || '');
}

function copyLegacyFiles(legacyUserId, tenantId) {
  const source = path.join(LEGACY_USERS_DIR, String(legacyUserId));
  if (!fs.existsSync(source)) return { copied: 0, skipped: 0 };
  const target = path.join(TENANTS_DIR, String(tenantId));
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  let skipped = 0;
  fs.readdirSync(source, { withFileTypes: true }).forEach(entry => {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') return;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (fs.existsSync(to)) { skipped += 1; return; }
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    copied += 1;
  });
  return { copied, skipped };
}

async function importUser(pool, legacyUser) {
  const username = legacyUser.username.trim();
  const existing = await pool.query(
    `SELECT u.id AS user_id, tm.tenant_id
     FROM users u LEFT JOIN tenant_members tm ON tm.user_id = u.id AND tm.status <> 'removed'
     WHERE lower(u.username) = lower($1) ORDER BY tm.created_at ASC LIMIT 1`,
    [username]
  );
  if (existing.rowCount && existing.rows[0].tenant_id) {
    return { created: false, tenantId: String(existing.rows[0].tenant_id), ...copyLegacyFiles(legacyUser.id, existing.rows[0].tenant_id) };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let userId;
    if (existing.rowCount) {
      userId = existing.rows[0].user_id;
    } else {
      const passwordHash = `scrypt-legacy-v1$${String(legacyUser.salt).toLowerCase()}$${String(legacyUser.hash).toLowerCase()}`;
      const createdUser = await client.query(
        `INSERT INTO users (username, password_hash, password_algorithm, created_at)
         VALUES ($1, $2, 'scrypt-legacy-v1', $3) RETURNING id`,
        [username, passwordHash, legacyUser.createdAt ? new Date(Number(legacyUser.createdAt)) : new Date()]
      );
      userId = createdUser.rows[0].id;
    }
    const legacyDigest = crypto.createHash('sha256').update(String(legacyUser.id)).digest('hex').slice(0, 16);
    const tenant = await client.query(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
      [`legacy-${legacyDigest}`, `${username}的企业`]
    );
    const tenantId = tenant.rows[0].id;
    await client.query(
      `INSERT INTO tenant_members
         (tenant_id, user_id, member_type, status, shop_scope_mode, display_name, created_by_user_id, joined_at)
       VALUES ($1, $2, 'owner', 'active', 'all', $3, $2, now())`,
      [tenantId, userId, username]
    );
    const role = await client.query(
      `INSERT INTO roles (tenant_id, code, name, is_system) VALUES ($1, 'owner', '所有者', true) RETURNING id`,
      [tenantId]
    );
    await client.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
       SELECT $1, $2, code FROM permissions`,
      [tenantId, role.rows[0].id]
    );
    await client.query(
      `INSERT INTO member_roles (tenant_id, user_id, role_id, granted_by_user_id) VALUES ($1, $2, $3, $2)`,
      [tenantId, userId, role.rows[0].id]
    );
    await client.query('COMMIT');
    return { created: true, tenantId: String(tenantId), ...copyLegacyFiles(legacyUser.id, tenantId) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (process.argv.includes('--apply') && fs.existsSync(P2_FREEZE_MARKER)) throw new Error('P2 legacy JSON freeze is active; legacy user file copying is disabled');
  const users = readUsers();
  const invalid = users.filter(user => !validateLegacyUser(user));
  if (invalid.length) throw new Error(`${invalid.length} legacy user record(s) failed validation`);
  if (!APPLY) {
    console.log(`legacy import dry-run: ${users.length} valid user(s); rerun with --apply to import without deleting source files`);
    return;
  }
  const pool = new Pool(createDatabaseConfig({ pool: true }));
  const summary = { createdUsers: 0, existingUsers: 0, copiedFiles: 0, skippedFiles: 0 };
  try {
    for (const user of users) {
      const result = await importUser(pool, user);
      if (result.created) summary.createdUsers += 1;
      else summary.existingUsers += 1;
      summary.copiedFiles += result.copied;
      summary.skippedFiles += result.skipped;
    }
  } finally {
    await pool.end();
  }
  console.log(`legacy import: PASS (${summary.createdUsers} created, ${summary.existingUsers} existing, ${summary.copiedFiles} files copied, ${summary.skippedFiles} files preserved)`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
