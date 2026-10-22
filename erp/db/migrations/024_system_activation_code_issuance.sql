ALTER TABLE activation_codes
  DROP CONSTRAINT activation_codes_tenant_id_fkey,
  DROP CONSTRAINT activation_codes_state_check,
  ADD CONSTRAINT activation_codes_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD CONSTRAINT activation_codes_state_check
    CHECK (state IN ('issued', 'used_temporary', 'payment_review', 'paid', 'granted', 'voided', 'expired', 'frozen', 'refunded', 'reversed')),
  ADD COLUMN issuance_type varchar(24) NOT NULL DEFAULT 'agent'
    CHECK (issuance_type IN ('agent', 'agent_delegated', 'platform_direct')),
  ADD COLUMN target_tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN fulfillment_type varchar(16)
    CHECK (fulfillment_type IN ('paid', 'gift')),
  ADD COLUMN platform_payment_id bigint REFERENCES payments(id) ON DELETE RESTRICT,
  ADD COLUMN administrative_reason varchar(500),
  ADD COLUMN restrictions_overridden boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT activation_codes_system_issuance_check CHECK (
    (issuance_type = 'agent'
      AND target_tenant_id IS NULL AND fulfillment_type IS NULL AND platform_payment_id IS NULL
      AND administrative_reason IS NULL AND restrictions_overridden = false)
    OR
    (issuance_type = 'agent_delegated'
      AND target_tenant_id IS NOT NULL AND fulfillment_type IS NULL AND platform_payment_id IS NULL
      AND administrative_reason IS NOT NULL)
    OR
    (issuance_type = 'platform_direct'
      AND target_tenant_id = tenant_id AND fulfillment_type IS NOT NULL
      AND administrative_reason IS NOT NULL AND restrictions_overridden = false
      AND ((fulfillment_type = 'paid' AND platform_payment_id IS NOT NULL)
        OR (fulfillment_type = 'gift' AND platform_payment_id IS NULL)))
  );

CREATE UNIQUE INDEX activation_codes_platform_payment_uq
  ON activation_codes (platform_payment_id)
  WHERE platform_payment_id IS NOT NULL;

CREATE INDEX activation_codes_target_tenant_idx
  ON activation_codes (target_tenant_id, requested_at DESC)
  WHERE target_tenant_id IS NOT NULL;
