CREATE TABLE ai_configurations (
  id uuid PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_user_id bigint NOT NULL,
  name varchar(120) NOT NULL,
  section varchar(16) NOT NULL CHECK (section IN ('product','image')),
  template varchar(64) NOT NULL,
  protocol varchar(64) NOT NULL,
  base_url varchar(2048) NOT NULL,
  registration_url varchar(2048) NOT NULL DEFAULT '',
  documentation_url varchar(2048) NOT NULL DEFAULT '',
  model jsonb NOT NULL DEFAULT '{}'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  encrypted_api_key jsonb,
  timeout_ms integer NOT NULL DEFAULT 30000 CHECK (timeout_ms BETWEEN 1000 AND 30000),
  enabled boolean NOT NULL DEFAULT true,
  allow_subaccounts boolean NOT NULL DEFAULT false,
  tested_at timestamptz,
  test_kind varchar(16),
  test_status varchar(16) NOT NULL DEFAULT 'untested' CHECK (test_status IN ('untested','passed','failed')),
  test_error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, owner_user_id, name),
  UNIQUE (id, tenant_id, owner_user_id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE ai_configuration_defaults (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_user_id bigint NOT NULL,
  capability varchar(64) NOT NULL,
  configuration_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, owner_user_id, capability),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (configuration_id, tenant_id, owner_user_id) REFERENCES ai_configurations(id, tenant_id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE ai_user_preferences (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id bigint NOT NULL,
  owner_user_id bigint NOT NULL,
  capability varchar(64) NOT NULL,
  configuration_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, capability),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (configuration_id, tenant_id, owner_user_id) REFERENCES ai_configurations(id, tenant_id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE ai_subaccount_permissions (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_user_id bigint NOT NULL,
  user_id bigint NOT NULL,
  allowed boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, owner_user_id, user_id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE ai_provider_registration_overrides (
  template varchar(64) PRIMARY KEY,
  invitation_url varchar(2048) NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_configurations_available_idx ON ai_configurations (tenant_id, owner_user_id, section, enabled);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_configurations, ai_configuration_defaults, ai_user_preferences, ai_subaccount_permissions, ai_provider_registration_overrides TO wyerp_app;
