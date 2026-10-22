-- B-04: keep fair client-order batch claiming bounded as tenant count grows.
-- Avoid a correlated EXISTS scan of upload batches for every tenant on every claim.
ALTER TABLE client_order_tenant_queue_state
  ADD COLUMN ready_batch_count integer NOT NULL DEFAULT 0 CHECK (ready_batch_count >= 0);

UPDATE client_order_tenant_queue_state queue
SET ready_batch_count = source.ready_batch_count
FROM (
  SELECT tenant_id, count(*)::integer AS ready_batch_count
  FROM client_order_upload_batches
  WHERE state IN ('queued','retry','running') AND attempts < 3
  GROUP BY tenant_id
) source
WHERE source.tenant_id = queue.tenant_id;

CREATE INDEX client_order_tenant_queue_fair_claim_idx
  ON client_order_tenant_queue_state (last_claimed_at NULLS FIRST, tenant_id)
  WHERE ready_batch_count > 0;

-- Once a tenant is selected, preserve the exact in-tenant batch order used by the worker.
CREATE INDEX client_order_upload_batches_tenant_sequence_idx
  ON client_order_upload_batches (tenant_id, created_at, sequence_no, shop_external_id)
  WHERE state IN ('queued','retry','running') AND attempts < 3;
