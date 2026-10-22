CREATE TABLE billing_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  public_launch_enabled boolean NOT NULL DEFAULT false,
  charging_enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_settings (singleton, public_launch_enabled, charging_enabled)
VALUES (true, false, false);

CREATE TABLE subscription_plans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  billing_interval varchar(20) NOT NULL CHECK (billing_interval IN ('month', 'year', 'one_time')),
  status varchar(20) NOT NULL DEFAULT 'paused' CHECK (status IN ('draft', 'paused', 'active', 'retired')),
  public_visible boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active'),
  CHECK (public_visible = false)
);

CREATE TABLE subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id bigint NOT NULL REFERENCES subscription_plans(id) ON DELETE RESTRICT,
  status varchar(24) NOT NULL CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  external_reference varchar(160),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
);

CREATE UNIQUE INDEX subscriptions_one_current_plan_uq
  ON subscriptions (tenant_id, plan_id)
  WHERE status IN ('pending', 'trialing', 'active', 'past_due', 'paused');

CREATE TABLE entitlement_definitions (
  code varchar(100) PRIMARY KEY,
  name varchar(160) NOT NULL,
  value_type varchar(20) NOT NULL CHECK (value_type IN ('boolean', 'integer', 'decimal', 'text', 'json')),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_entitlements (
  plan_id bigint NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  entitlement_code varchar(100) NOT NULL REFERENCES entitlement_definitions(code) ON DELETE RESTRICT,
  value jsonb NOT NULL,
  PRIMARY KEY (plan_id, entitlement_code)
);

CREATE TABLE tenant_entitlements (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entitlement_code varchar(100) NOT NULL REFERENCES entitlement_definitions(code) ON DELETE RESTRICT,
  source_type varchar(24) NOT NULL CHECK (source_type IN ('subscription', 'manual', 'promotion', 'system')),
  source_id varchar(160) NOT NULL,
  value jsonb NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entitlement_code, source_type, source_id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE payments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  subscription_id bigint,
  provider varchar(40) NOT NULL,
  provider_payment_id varchar(160),
  status varchar(24) NOT NULL CHECK (status IN ('created', 'pending', 'authorized', 'paid', 'failed', 'cancelled', 'refunded')),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  paid_at timestamptz,
  failure_code varchar(100),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES subscriptions(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (provider, provider_payment_id)
);

CREATE TABLE balance_accounts (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL,
  balance_minor bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, currency)
);

CREATE TABLE balance_transactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL,
  currency char(3) NOT NULL,
  direction varchar(10) NOT NULL CHECK (direction IN ('credit', 'debit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  balance_after_minor bigint NOT NULL,
  transaction_type varchar(40) NOT NULL,
  reference_type varchar(60),
  reference_id varchar(160),
  idempotency_key varchar(160) NOT NULL,
  description varchar(300) NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, currency) REFERENCES balance_accounts(tenant_id, currency) ON DELETE RESTRICT,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX balance_transactions_account_time_idx
  ON balance_transactions (tenant_id, currency, created_at DESC, id DESC);

CREATE TABLE idempotency_records (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  namespace varchar(160) NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  request_hash char(64) NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  response_code integer,
  response_body jsonb,
  resource_type varchar(80),
  resource_id varchar(160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (tenant_id, namespace, idempotency_key),
  CHECK ((status = 'completed' AND response_code IS NOT NULL) OR status <> 'completed')
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

GRANT SELECT ON billing_settings, subscription_plans, entitlement_definitions, plan_entitlements TO wyerp_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions, tenant_entitlements, payments, balance_accounts, idempotency_records TO wyerp_app;
GRANT SELECT, INSERT ON balance_transactions TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE subscriptions_id_seq, payments_id_seq, balance_transactions_id_seq TO wyerp_app;
