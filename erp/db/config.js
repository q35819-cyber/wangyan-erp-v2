'use strict';

function sslConfig(mode) {
  if (!mode || mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  throw new Error('PGSSLMODE must be disable, require, verify-ca, or verify-full');
}

function envInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function createDatabaseConfig(options = {}) {
  const migration = Boolean(options.migration);
  const connectionString = migration
    ? (process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL)
    : process.env.DATABASE_URL;
  const mode = String(process.env.PGSSLMODE || (process.env.NODE_ENV === 'production' ? 'verify-full' : 'disable')).toLowerCase();

  if (process.env.NODE_ENV === 'production' && mode === 'disable') {
    throw new Error('Production PostgreSQL connections must enable TLS');
  }

  const config = {
    application_name: migration ? 'wyerp-migrator' : 'wyerp-app',
    ssl: sslConfig(mode),
    connectionTimeoutMillis: envInteger('PGCONNECT_TIMEOUT_MS', 5000, 250, 120000),
    statement_timeout: envInteger('PGSTATEMENT_TIMEOUT_MS', 30000, 1000, 600000)
  };
  if (options.pool) {
    config.max = envInteger('PGPOOL_MAX', 10, 1, 100);
    config.idleTimeoutMillis = envInteger('PGPOOL_IDLE_TIMEOUT_MS', 10000, 1000, 300000);
  }

  if (connectionString) {
    config.connectionString = connectionString;
    return config;
  }

  const database = process.env.PGDATABASE || (process.env.NODE_ENV === 'production' ? '' : 'wyerp_dev');
  const user = migration
    ? (process.env.PGMIGRATIONUSER || process.env.PGUSER || (process.env.NODE_ENV === 'production' ? '' : 'wyerp_migrator'))
    : (process.env.PGUSER || (process.env.NODE_ENV === 'production' ? '' : 'wyerp_app'));
  if (!database || !user) {
    throw new Error('Set DATABASE_URL, or set PGDATABASE and PGUSER before using PostgreSQL');
  }

  return {
    ...config,
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database,
    user,
    password: migration ? (process.env.PGMIGRATIONPASSWORD || process.env.PGPASSWORD) : process.env.PGPASSWORD
  };
}

module.exports = { createDatabaseConfig };
