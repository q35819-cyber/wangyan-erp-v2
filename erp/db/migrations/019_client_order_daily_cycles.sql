CREATE TABLE client_order_daily_cycles (
  cycle_id uuid PRIMARY KEY,
  cycle_day date NOT NULL UNIQUE,
  status varchar(30) NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting','ready','backup_incomplete','backed_up','failed')),
  cutoff_at timestamptz NOT NULL,
  participant_count integer NOT NULL DEFAULT 0 CHECK (participant_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

ALTER TABLE client_order_sync_runs
  ADD COLUMN daily_cycle_id uuid REFERENCES client_order_daily_cycles(cycle_id) ON DELETE RESTRICT;

ALTER TABLE client_order_sync_runs DROP CONSTRAINT client_order_sync_runs_state_check;
ALTER TABLE client_order_sync_runs ADD CONSTRAINT client_order_sync_runs_state_check CHECK (state IN (
  'waiting_client','leased','manifested','backup_ready','uploading','applying',
  'completed','failed','cancelled','authorization_expired','lease_expired'
));

CREATE TABLE client_order_daily_participants (
  cycle_id uuid NOT NULL REFERENCES client_order_daily_cycles(cycle_id) ON DELETE CASCADE,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  shop_external_id varchar(120) NOT NULL,
  run_id uuid UNIQUE REFERENCES client_order_sync_runs(run_id) ON DELETE SET NULL,
  state varchar(30) NOT NULL DEFAULT 'waiting_client'
    CHECK (state IN ('waiting_client','leased','snapshot_ready','failed','lease_expired')),
  failure_code varchar(100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cycle_id, tenant_id, shop_external_id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX client_order_daily_participants_state_idx
  ON client_order_daily_participants (cycle_id, state, updated_at);

ALTER TABLE backup_generations
  ADD COLUMN daily_cycle_id uuid REFERENCES client_order_daily_cycles(cycle_id) ON DELETE RESTRICT,
  ADD COLUMN incomplete_sync_count integer NOT NULL DEFAULT 0 CHECK (incomplete_sync_count >= 0);

GRANT SELECT, INSERT, UPDATE ON client_order_daily_cycles, client_order_daily_participants TO wyerp_app;
