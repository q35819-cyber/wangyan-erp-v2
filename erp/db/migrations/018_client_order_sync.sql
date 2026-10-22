CREATE TABLE client_sync_devices (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  installation_id uuid NOT NULL,
  shop_external_id varchar(120) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'authorized'
    CHECK (status IN ('authorized','unauthorized','revoked')),
  seller_verified_at timestamptz,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  authorization_expires_at timestamptz NOT NULL,
  order_contract_version varchar(40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, installation_id, shop_external_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX client_sync_devices_ready_idx
  ON client_sync_devices (tenant_id, shop_external_id, authorization_expires_at DESC)
  WHERE status = 'authorized' AND order_contract_version IS NOT NULL;

CREATE TABLE client_order_sync_runs (
  run_id uuid PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shop_external_id varchar(120) NOT NULL,
  mode varchar(30) NOT NULL CHECK (mode IN ('manual_all','manual_selected','auto_daily','auto_new','auto_tracked')),
  requested_postings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requested_postings) = 'array'),
  range_start timestamptz,
  range_end timestamptz NOT NULL,
  state varchar(30) NOT NULL DEFAULT 'waiting_client' CHECK (state IN (
    'waiting_client','leased','manifested','backup_ready','uploading','applying',
    'completed','failed','cancelled','authorization_expired'
  )),
  device_installation_id uuid,
  lease_expires_at timestamptz,
  upload_ticket_hash bytea,
  schema_version varchar(40) NOT NULL DEFAULT 'client-orders-v1',
  backup_generation_id bigint,
  server_revision bigint,
  failure_code varchar(100),
  failure_detail varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (tenant_id, device_installation_id, shop_external_id)
    REFERENCES client_sync_devices(tenant_id, installation_id, shop_external_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX client_order_sync_runs_active_shop_idx
  ON client_order_sync_runs (tenant_id, shop_external_id)
  WHERE state IN ('waiting_client','leased','manifested','backup_ready','uploading','applying');
CREATE INDEX client_order_sync_runs_claim_idx
  ON client_order_sync_runs (state, created_at, tenant_id);

CREATE TABLE client_order_sync_manifests (
  run_id uuid PRIMARY KEY REFERENCES client_order_sync_runs(run_id) ON DELETE CASCADE,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shop_external_id varchar(120) NOT NULL,
  order_count integer NOT NULL CHECK (order_count >= 0),
  batch_count integer NOT NULL CHECK (batch_count >= 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  first_order_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_generations (
  generation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status varchar(20) NOT NULL CHECK (status IN ('running','complete','failed')),
  backup_name varchar(240),
  dump_sha256 char(64),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  failure_code varchar(100),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL AND dump_sha256 IS NOT NULL))
);

ALTER TABLE client_order_sync_runs
  ADD CONSTRAINT client_order_sync_runs_backup_fk
  FOREIGN KEY (backup_generation_id) REFERENCES backup_generations(generation_id) ON DELETE RESTRICT;

CREATE TABLE client_order_upload_batches (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES client_order_sync_runs(run_id) ON DELETE CASCADE,
  shop_external_id varchar(120) NOT NULL,
  backup_generation_id bigint NOT NULL REFERENCES backup_generations(generation_id) ON DELETE RESTRICT,
  batch_id varchar(120) NOT NULL,
  sequence_no integer NOT NULL CHECK (sequence_no >= 0),
  body_sha256 char(64) NOT NULL CHECK (body_sha256 ~ '^[a-f0-9]{64}$'),
  order_count integer NOT NULL CHECK (order_count BETWEEN 1 AND 100),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 2 AND 1048576),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'array'),
  state varchar(20) NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','complete','retry','failed')),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  lease_owner varchar(120),
  lease_expires_at timestamptz,
  last_error varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, shop_external_id, backup_generation_id, batch_id),
  UNIQUE (run_id, sequence_no)
);

CREATE INDEX client_order_upload_batches_claim_idx
  ON client_order_upload_batches (state, created_at, tenant_id)
  WHERE state IN ('queued','retry','running');

GRANT SELECT, INSERT, UPDATE, DELETE ON client_sync_devices, client_order_sync_runs,
  client_order_sync_manifests, client_order_upload_batches TO wyerp_app;
GRANT SELECT, INSERT, UPDATE ON backup_generations TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE backup_generations_generation_id_seq TO wyerp_app;
