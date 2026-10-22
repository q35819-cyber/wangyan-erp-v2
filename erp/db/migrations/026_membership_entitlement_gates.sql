CREATE TABLE membership_daily_sku_usage (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  business_date date NOT NULL,
  offer_id varchar(180) NOT NULL,
  queue_id varchar(80) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'confirmed')),
  actor_user_id bigint NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (tenant_id, business_date, offer_id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  CHECK ((state = 'reserved' AND confirmed_at IS NULL) OR (state = 'confirmed' AND confirmed_at IS NOT NULL))
);

CREATE INDEX membership_daily_sku_usage_queue_idx
  ON membership_daily_sku_usage (tenant_id, queue_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON membership_daily_sku_usage TO wyerp_app;
