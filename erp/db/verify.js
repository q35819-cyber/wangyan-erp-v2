#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { createDatabaseConfig } = require('./config');

const REQUIRED_TABLES = [
  'tenants',
  'users',
  'tenant_members',
  'sessions',
  'roles',
  'permissions',
  'role_permissions',
  'member_roles',
  'shops',
  'member_shop_scopes',
  'audit_events',
  'tenant_documents',
  'sync_tasks',
  'background_jobs',
  'user_security_profiles',
  'user_security_events',
  'business_data_versions',
  'business_orders',
  'business_products',
  'product_costs',
  'financial_records',
  'finance_settings',
  'bug_reports',
  'bug_attachments',
  'migration_runs',
  'migration_file_inventory',
  'private_objects',
  'legacy_archives',
  'migration_reconciliation',
  'membership_plan_versions',
  'membership_periods',
  'membership_events',
  'membership_trial_claims',
  'membership_daily_sku_usage',
  'agents',
  'agent_qualification_events',
  'activation_codes',
  'activation_code_events',
  'membership_private_objects',
  'payment_evidence',
  'agent_financial_events',
  'agent_credit_events',
  'agent_monthly_stats',
  'agent_appeals',
  'membership_campaigns',
  'membership_campaign_awards',
  'user_notifications'
];

async function main() {
  const client = new Client(createDatabaseConfig({ migration: true }));
  await client.connect();
  try {
    const tableResult = await client.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [REQUIRED_TABLES]
    );
    const found = new Set(tableResult.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !found.has(name));
    if (missing.length) throw new Error(`missing tables: ${missing.join(', ')}`);

    const permissionResult = await client.query('SELECT count(*)::integer AS count FROM permissions');
    if (permissionResult.rows[0].count < 10) throw new Error('permission seed is incomplete');

    const isolationResult = await client.query(`
      SELECT count(*)::integer AS count
        FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN (
           'tenant_members'::regclass,
           'member_roles'::regclass,
           'member_shop_scopes'::regclass,
           'tenant_documents'::regclass,
           'sync_tasks'::regclass
         )
    `);
    if (isolationResult.rows[0].count < 10) throw new Error('tenant isolation foreign keys are incomplete');

    const membershipIsolation = await client.query(`
      SELECT count(*)::integer AS count
        FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN (
           'membership_periods'::regclass,
           'membership_events'::regclass,
           'agents'::regclass,
           'activation_codes'::regclass,
           'payment_evidence'::regclass,
           'agent_financial_events'::regclass,
           'membership_campaign_awards'::regclass,
           'user_notifications'::regclass
         )
    `);
    if (membershipIsolation.rows[0].count < 16) throw new Error('membership tenant isolation foreign keys are incomplete');

    const campaignPrivileges = await client.query(`SELECT has_table_privilege('wyerp_app','membership_campaigns','SELECT,INSERT,UPDATE') AS table_ok, has_sequence_privilege('wyerp_app','membership_campaigns_id_seq','USAGE,SELECT') AS sequence_ok`);
    if (!campaignPrivileges.rows[0].table_ok || !campaignPrivileges.rows[0].sequence_ok) throw new Error('membership campaign administrator privileges are incomplete');

    const migratorPrivilege = await client.query(`
      SELECT current_user AS migration_user,
             (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS database_owner,
             has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
             has_schema_privilege(current_user,'public','CREATE') AS schema_create
    `);
    const migrator = migratorPrivilege.rows[0];
    if (!migrator.schema_usage || !migrator.schema_create) throw new Error('migration account lacks public schema USAGE/CREATE');
    if (migrator.database_owner !== migrator.migration_user) throw new Error(`migration account must own database: owner=${migrator.database_owner}, migrator=${migrator.migration_user}`);

    const ownershipResult = await client.query(`
      SELECT
        (SELECT count(*)::integer
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public'
            AND c.relkind IN ('r','p','S','v','m','f')
            AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')) AS relations_not_owned,
        (SELECT count(*)::integer
           FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public'
            AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user)
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')) AS functions_not_owned
    `);
    if (ownershipResult.rows[0].relations_not_owned || ownershipResult.rows[0].functions_not_owned) throw new Error(`public business object ownership drift: relations=${ownershipResult.rows[0].relations_not_owned}, functions=${ownershipResult.rows[0].functions_not_owned}`);

    const appClient = new Client(createDatabaseConfig());
    await appClient.connect();
    try {
      const appPrivilege = await appClient.query(`SELECT current_user AS app_user, has_schema_privilege(current_user,'public','CREATE') AS schema_create`);
      if (appPrivilege.rows[0].schema_create) throw new Error(`runtime account must not have public CREATE: ${appPrivilege.rows[0].app_user}`);
    } finally {
      await appClient.end();
    }

    console.log(`database schema: PASS (${REQUIRED_TABLES.length} tables, ${permissionResult.rows[0].count} permissions)`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`database verification failed: ${error.message}`);
  process.exitCode = 1;
});
