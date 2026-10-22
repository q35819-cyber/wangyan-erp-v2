ALTER TABLE billing_settings
  ADD COLUMN membership_charging_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN activation_codes_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN automatic_agent_penalties_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE membership_plan_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_code varchar(24) NOT NULL,
  version_no integer NOT NULL CHECK (version_no > 0),
  name varchar(80) NOT NULL,
  currency char(3) NOT NULL DEFAULT 'CNY',
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  duration_days integer NOT NULL CHECK (duration_days > 0),
  benefit_rank smallint NOT NULL CHECK (benefit_rank >= 0),
  status varchar(16) NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  public_visible boolean NOT NULL DEFAULT false,
  benefits jsonb NOT NULL CHECK (jsonb_typeof(benefits) = 'object'),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_code, version_no),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE UNIQUE INDEX membership_plan_versions_published_uq
  ON membership_plan_versions (plan_code) WHERE status = 'published';

INSERT INTO membership_plan_versions
  (plan_code, version_no, name, currency, price_minor, duration_days, benefit_rank, status, public_visible, benefits)
VALUES
  ('trial', 1, '免费体验', 'CNY', 0, 7, 0, 'published', true,
   '{"shopLimit":1,"dailySkuLimit":10,"favoriteLimit":100,"childAccountLimit":0,"relist":true,"resell":false,"analytics":false,"aiEdit":false,"profileBonusDays":7}'::jsonb),
  ('month', 1, '月卡会员', 'CNY', 49900, 30, 1, 'published', true,
   '{"shopLimit":10,"dailySkuLimit":500,"favoriteLimit":1000,"childAccountLimit":1,"relist":true,"resell":true,"analytics":true,"aiEdit":true}'::jsonb),
  ('quarter', 1, '季卡会员', 'CNY', 129900, 90, 2, 'published', true,
   '{"shopLimit":50,"dailySkuLimit":1000,"favoriteLimit":2000,"childAccountLimit":5,"relist":true,"resell":true,"analytics":true,"aiEdit":true}'::jsonb),
  ('year', 1, '年卡会员', 'CNY', 449900, 365, 3, 'published', true,
   '{"shopLimit":200,"dailySkuLimit":null,"favoriteLimit":3000,"childAccountLimit":20,"relist":true,"resell":true,"analytics":true,"aiEdit":true}'::jsonb);

CREATE TABLE membership_periods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_version_id bigint NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  source_type varchar(32) NOT NULL CHECK (source_type IN ('registration_trial', 'profile_trial', 'direct_payment', 'activation_code', 'holiday_bonus', 'partner', 'agent', 'manual')),
  source_ref varchar(160) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('queued', 'active', 'paused', 'frozen', 'expired', 'revoked')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  remaining_seconds bigint CHECK (remaining_seconds IS NULL OR remaining_seconds >= 0),
  created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_type, source_ref),
  UNIQUE (tenant_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (source_type = 'partner' OR ends_at IS NOT NULL)
);

CREATE INDEX membership_periods_current_idx
  ON membership_periods (tenant_id, state, starts_at, ends_at);

CREATE TABLE membership_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  period_id bigint,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(48) NOT NULL,
  previous_state varchar(16),
  next_state varchar(16),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, period_id) REFERENCES membership_periods(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE membership_trial_claims (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  claim_type varchar(24) NOT NULL CHECK (claim_type IN ('registration', 'profile_complete')),
  verified_phone_hash char(64),
  period_id bigint NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, claim_type),
  FOREIGN KEY (tenant_id, period_id) REFERENCES membership_periods(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX membership_trial_phone_once_uq
  ON membership_trial_claims (verified_phone_hash)
  WHERE claim_type = 'profile_complete' AND verified_phone_hash IS NOT NULL;

CREATE TABLE agents (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  source varchar(20) NOT NULL CHECK (source IN ('assigned', 'application')),
  status varchar(24) NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'cancelled', 'expired', 'permanently_banned')),
  contract_version varchar(80),
  deposit_mode varchar(16) NOT NULL DEFAULT 'waived' CHECK (deposit_mode IN ('waived', 'required')),
  credit_score smallint NOT NULL DEFAULT 10 CHECK (credit_score BETWEEN 0 AND 10),
  qualified_at timestamptz,
  expires_at timestamptz,
  first_qualified_at timestamptz,
  application_blocked_until timestamptz,
  assigned_reason varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  CHECK (expires_at IS NULL OR qualified_at IS NULL OR expires_at > qualified_at)
);

CREATE TABLE agent_qualification_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(40) NOT NULL,
  reason varchar(500) NOT NULL DEFAULT '',
  previous_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(previous_state) = 'object'),
  next_state jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(next_state) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activation_codes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  requested_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_version_id bigint NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  code_digest char(64) NOT NULL UNIQUE,
  code_mask varchar(32) NOT NULL,
  purpose varchar(16) NOT NULL CHECK (purpose IN ('customer', 'self')),
  state varchar(24) NOT NULL CHECK (state IN ('issued', 'used_temporary', 'payment_review', 'paid', 'voided', 'expired', 'frozen', 'refunded', 'reversed')),
  locked_agent_price_minor bigint NOT NULL CHECK (locked_agent_price_minor >= 0),
  customer_declared_price_minor bigint CHECK (customer_declared_price_minor IS NULL OR customer_declared_price_minor >= 0),
  bound_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  payment_confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (expires_at > requested_at),
  CHECK ((purpose = 'self' AND bound_user_id IS NOT NULL) OR purpose = 'customer')
);

CREATE INDEX activation_codes_agent_window_idx ON activation_codes (tenant_id, requested_at DESC);
CREATE INDEX activation_codes_redeemed_tenant_idx ON activation_codes (redeemed_tenant_id, used_at DESC);

CREATE TABLE activation_code_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  activation_code_id bigint NOT NULL,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  event_type varchar(48) NOT NULL,
  previous_state varchar(24),
  next_state varchar(24),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, activation_code_id) REFERENCES activation_codes(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE membership_private_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  object_key varchar(240) NOT NULL UNIQUE,
  object_kind varchar(32) NOT NULL CHECK (object_kind IN ('payment_evidence', 'customer_payment_evidence', 'identity_document', 'business_license', 'agent_contract')),
  original_name varchar(240) NOT NULL,
  media_type varchar(120) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL,
  uploaded_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE payment_evidence (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  activation_code_id bigint NOT NULL,
  evidence_kind varchar(32) NOT NULL CHECK (evidence_kind IN ('agent_to_platform', 'customer_to_agent')),
  private_object_id bigint NOT NULL,
  review_state varchar(24) NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'needs_review', 'matched', 'rejected', 'confirmed')),
  ocr_state varchar(24) NOT NULL DEFAULT 'not_started' CHECK (ocr_state IN ('not_started', 'queued', 'matched', 'needs_review', 'failed')),
  ocr_fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ocr_fields) = 'object'),
  perceptual_hash varchar(160),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_reason varchar(500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, activation_code_id) REFERENCES activation_codes(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, private_object_id) REFERENCES membership_private_objects(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_financial_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  activation_code_id bigint,
  event_type varchar(40) NOT NULL CHECK (event_type IN ('amount_due', 'payment', 'deposit', 'penalty', 'refund', 'chargeback', 'customer_compensation', 'debt_offset')),
  account_type varchar(20) NOT NULL CHECK (account_type IN ('payable', 'balance', 'deposit')),
  direction varchar(8) NOT NULL CHECK (direction IN ('credit', 'debit')),
  currency char(3) NOT NULL DEFAULT 'CNY',
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  idempotency_key varchar(160) NOT NULL,
  reason varchar(500) NOT NULL DEFAULT '',
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, activation_code_id) REFERENCES activation_codes(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_credit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  event_type varchar(32) NOT NULL CHECK (event_type IN ('default', 'monthly_recovery', 'manual_recovery', 'correction')),
  delta smallint NOT NULL CHECK (delta <> 0),
  score_after smallint NOT NULL CHECK (score_after BETWEEN 0 AND 10),
  cycle_key varchar(80),
  activation_code_id bigint,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  reason varchar(500) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_type, cycle_key),
  FOREIGN KEY (tenant_id, activation_code_id) REFERENCES activation_codes(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE agent_monthly_stats (
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  month_start date NOT NULL CHECK (EXTRACT(DAY FROM month_start) = 1),
  valid_customer_orders integer NOT NULL DEFAULT 0 CHECK (valid_customer_orders >= 0),
  valid_self_orders integer NOT NULL DEFAULT 0 CHECK (valid_self_orders BETWEEN 0 AND 1),
  monthly_equivalents integer NOT NULL DEFAULT 0 CHECK (monthly_equivalents >= 0),
  month_plan_price_minor bigint NOT NULL CHECK (month_plan_price_minor >= 0),
  settled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (tenant_id, month_start)
);

CREATE TABLE agent_appeals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  subject_type varchar(24) NOT NULL CHECK (subject_type IN ('price_violation', 'qualification', 'credit', 'deposit')),
  subject_id varchar(160) NOT NULL,
  state varchar(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn')),
  reason varchar(1000) NOT NULL,
  submitted_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_reason varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id)
);

CREATE TABLE membership_campaigns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_code varchar(80) NOT NULL UNIQUE,
  name varchar(160) NOT NULL,
  calendar_year integer NOT NULL CHECK (calendar_year BETWEEN 2020 AND 2200),
  campaign_type varchar(24) NOT NULL CHECK (campaign_type IN ('spring_festival', 'labour_day', 'mid_autumn_national_day')),
  state varchar(16) NOT NULL CHECK (state IN ('draft', 'published', 'ended', 'cancelled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  bonus_days jsonb NOT NULL CHECK (jsonb_typeof(bonus_days) = 'object'),
  confirmed_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (calendar_year, campaign_type),
  CHECK (ends_at > starts_at)
);

CREATE TABLE membership_campaign_awards (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  campaign_id bigint NOT NULL REFERENCES membership_campaigns(id) ON DELETE RESTRICT,
  plan_version_id bigint NOT NULL REFERENCES membership_plan_versions(id) ON DELETE RESTRICT,
  payment_reference varchar(160) NOT NULL,
  awarded_days integer NOT NULL CHECK (awarded_days > 0),
  period_id bigint NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('awarded', 'reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, campaign_id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES membership_periods(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE user_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category varchar(40) NOT NULL,
  title varchar(160) NOT NULL,
  body varchar(1000) NOT NULL,
  resource_type varchar(60),
  resource_id varchar(160),
  dedupe_key varchar(160) NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, dedupe_key),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE INDEX user_notifications_unread_idx
  ON user_notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;

GRANT SELECT ON membership_plan_versions, membership_campaigns TO wyerp_app;
GRANT SELECT, INSERT, UPDATE ON membership_periods, membership_trial_claims, agents, activation_codes,
  payment_evidence, agent_monthly_stats, agent_appeals, membership_campaign_awards, user_notifications TO wyerp_app;
GRANT SELECT, INSERT ON membership_events, agent_qualification_events, activation_code_events,
  membership_private_objects, agent_financial_events, agent_credit_events TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE membership_periods_id_seq, membership_events_id_seq,
  agent_qualification_events_id_seq, activation_codes_id_seq, activation_code_events_id_seq,
  membership_private_objects_id_seq, payment_evidence_id_seq, agent_financial_events_id_seq,
  agent_credit_events_id_seq, agent_appeals_id_seq, user_notifications_id_seq TO wyerp_app;
