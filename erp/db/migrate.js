#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { createDatabaseConfig } = require('./config');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_NAME = 'wyerp:schema-migrations';

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3,}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

function checksum(contents) {
  return crypto.createHash('sha256').update(contents.replace(/\r\n/g, '\n')).digest('hex');
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function migrationTableExists(client) {
  const result = await client.query("SELECT to_regclass('public.schema_migrations') AS table_name");
  return Boolean(result.rows[0] && result.rows[0].table_name);
}

async function loadApplied(client) {
  const result = await client.query('SELECT version, checksum_sha256, applied_at FROM schema_migrations ORDER BY version');
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const checkOnly = process.argv.includes('--check');
  const inspectOnly = statusOnly || checkOnly;
  const client = new Client(createDatabaseConfig({ migration: true }));
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
    if (!inspectOnly) await ensureMigrationTable(client);
    const tableExists = inspectOnly ? await migrationTableExists(client) : true;
    const applied = tableExists ? await loadApplied(client) : new Map();
    const files = migrationFiles();
    const fileSet = new Set(files);
    const historicalDatabaseOnly = [...applied.keys()].filter((version) => !fileSet.has(version));
    let pending = 0;

    if (statusOnly) {
      for (const version of historicalDatabaseOnly) console.log(`historical ${version} (database only)`);
    }

    for (const version of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, version), 'utf8');
      const hash = checksum(sql);
      const previous = applied.get(version);

      if (previous) {
        if (previous.checksum_sha256 !== hash) {
          throw new Error(`Applied migration was modified: ${version}`);
        }
        if (!checkOnly) console.log(`applied  ${version}`);
        continue;
      }

      pending += 1;
      if (inspectOnly) {
        console.log(`pending  ${version}`);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)',
          [version, hash]
        );
        await client.query('COMMIT');
        console.log(`migrated ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    if (inspectOnly) {
      console.log(`summary: ${files.length - pending} file-backed applied, ${pending} pending; ${applied.size} recorded in database; ${historicalDatabaseOnly.length} historical database-only`);
      if (checkOnly && pending > 0) process.exitCode = 2;
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]); } catch (_) { /* connection may already be unavailable */ }
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`database migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { checksum };
