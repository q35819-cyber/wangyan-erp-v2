-- Final-candidate hardening: a migration run may adopt an exact pre-existing
-- row without claiming that the run originally created that row.
CREATE TABLE migration_record_ownership (
  run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  entity_kind varchar(40) NOT NULL CHECK (entity_kind IN (
    'shop_document', 'order', 'product', 'product_cost', 'financial_record',
    'bug_report', 'bug_attachment', 'private_object'
  )),
  record_key text NOT NULL,
  ownership varchar(30) NOT NULL CHECK (ownership IN ('inserted', 'matched_existing')),
  payload_sha256 char(64) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tenant_id, entity_kind, record_key)
);

CREATE INDEX migration_record_ownership_tenant_idx
  ON migration_record_ownership (run_id, tenant_id, entity_kind, ownership);

CREATE TABLE tenant_data_cutovers (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  cutover_at timestamptz NOT NULL
);

-- Objects created after cutover are live application objects rather than
-- migration-owned objects. Their provenance remains explicit and auditable.
ALTER TABLE private_objects ALTER COLUMN migration_run_id DROP NOT NULL;
ALTER TABLE private_objects ADD COLUMN object_origin varchar(20) NOT NULL DEFAULT 'migration'
  CHECK (object_origin IN ('migration', 'live'));
ALTER TABLE private_objects ADD CONSTRAINT private_objects_origin_check CHECK (
  (object_origin = 'migration' AND migration_run_id IS NOT NULL) OR
  (object_origin = 'live' AND migration_run_id IS NULL)
);

GRANT SELECT, INSERT, UPDATE ON migration_record_ownership TO wyerp_migrator;
GRANT SELECT, INSERT, UPDATE ON tenant_data_cutovers TO wyerp_migrator;
GRANT SELECT, INSERT ON private_objects TO wyerp_app;
GRANT SELECT ON tenant_data_cutovers TO wyerp_app;
