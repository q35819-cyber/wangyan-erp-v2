CREATE TABLE migration_runs (
  run_id uuid PRIMARY KEY,
  status varchar(30) NOT NULL CHECK (status IN ('inventoried', 'backed_up', 'migrating', 'migrated', 'reconciled', 'accepted', 'cutover', 'failed')),
  source_manifest_sha256 char(64) NOT NULL,
  backup_manifest_sha256 char(64),
  reconciliation_sha256 char(64),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  accepted_at timestamptz,
  cutover_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE migration_file_inventory (
  run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  relative_path text NOT NULL,
  tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  source_kind varchar(40) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  deterministic_key text,
  modified_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, relative_path)
);

CREATE TABLE private_objects (
  object_id uuid PRIMARY KEY,
  migration_run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_kind varchar(40) NOT NULL CHECK (object_kind IN ('category_snapshot', 'logistics_file', 'bug_attachment')),
  object_key text NOT NULL UNIQUE,
  storage_backend varchar(30) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  media_type varchar(100) NOT NULL DEFAULT 'application/octet-stream',
  source_relative_path text NOT NULL,
  created_at timestamptz NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, object_kind, sha256, source_relative_path)
);

CREATE TABLE legacy_archives (
  archive_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  archive_path text NOT NULL UNIQUE,
  cipher varchar(40) NOT NULL CHECK (cipher = 'AES-256-GCM'),
  ciphertext_sha256 char(64) NOT NULL,
  source_manifest_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  read_only boolean NOT NULL DEFAULT true
);

CREATE TABLE migration_reconciliation (
  run_id uuid NOT NULL REFERENCES migration_runs(run_id) ON DELETE RESTRICT,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  source_counts jsonb NOT NULL,
  target_counts jsonb NOT NULL,
  source_order_amount numeric(30, 4) NOT NULL,
  target_order_amount numeric(30, 4) NOT NULL,
  source_cost_amount numeric(30, 4) NOT NULL,
  target_cost_amount numeric(30, 4) NOT NULL,
  debit_amount numeric(30, 4) NOT NULL,
  credit_amount numeric(30, 4) NOT NULL,
  attachment_count bigint NOT NULL,
  attachment_hash_mismatches bigint NOT NULL,
  balanced boolean NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tenant_id)
);

ALTER TABLE business_orders
  ADD COLUMN order_amount numeric(20, 4),
  ADD COLUMN currency char(3),
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN migration_run_id uuid REFERENCES migration_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE business_products
  ADD COLUMN migration_run_id uuid REFERENCES migration_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE product_costs
  ADD COLUMN migration_run_id uuid REFERENCES migration_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE financial_records
  ADD COLUMN amount numeric(20, 4),
  ADD COLUMN debit_amount numeric(20, 4),
  ADD COLUMN credit_amount numeric(20, 4),
  ADD COLUMN currency char(3),
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN migration_run_id uuid REFERENCES migration_runs(run_id) ON DELETE RESTRICT;

ALTER TABLE bug_attachments
  ADD COLUMN object_id uuid REFERENCES private_objects(object_id) ON DELETE RESTRICT,
  ADD COLUMN sha256 char(64),
  ADD COLUMN migration_run_id uuid REFERENCES migration_runs(run_id) ON DELETE RESTRICT;

CREATE INDEX migration_inventory_tenant_idx ON migration_file_inventory (run_id, tenant_id, source_kind);
CREATE INDEX private_objects_tenant_kind_idx ON private_objects (tenant_id, object_kind, migrated_at DESC);

GRANT SELECT, INSERT, UPDATE ON migration_runs, migration_file_inventory, private_objects, legacy_archives,
  migration_reconciliation TO wyerp_migrator;
GRANT SELECT ON private_objects TO wyerp_app;
