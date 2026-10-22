CREATE TABLE client_order_tenant_queue_state (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_claimed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX client_order_upload_batches_one_running_shop_idx
  ON client_order_upload_batches (tenant_id, shop_external_id)
  WHERE state = 'running';

CREATE INDEX client_order_upload_batches_tenant_ready_idx
  ON client_order_upload_batches (tenant_id, created_at, shop_external_id)
  WHERE state IN ('queued','retry','running');

INSERT INTO client_order_tenant_queue_state (tenant_id)
SELECT DISTINCT tenant_id FROM client_order_upload_batches
ON CONFLICT (tenant_id) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON client_order_tenant_queue_state TO wyerp_app;
