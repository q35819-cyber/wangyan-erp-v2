CREATE TABLE user_security_profiles (
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL,
  security_email varchar(240),
  first_ip varchar(80),
  first_device_hash char(64),
  first_login_at timestamptz,
  last_ip varchar(80),
  last_device_hash char(64),
  last_seen_at timestamptz,
  risk_count smallint NOT NULL DEFAULT 0 CHECK (risk_count BETWEEN 0 AND 10),
  last_risk_at timestamptz,
  block_type varchar(24) NOT NULL DEFAULT 'none'
    CHECK (block_type IN ('none', 'auto_frozen', 'manual_frozen', 'banned')),
  block_reason varchar(1000) NOT NULL DEFAULT '',
  blocked_at timestamptz,
  auto_unfreeze_at timestamptz,
  blocked_member_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  admin_handled boolean NOT NULL DEFAULT false,
  last_warning_email_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE user_security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL,
  event_type varchar(40) NOT NULL,
  risk_count smallint NOT NULL DEFAULT 0,
  ip_address varchar(80),
  device_hash char(64),
  reason varchar(1000) NOT NULL DEFAULT '',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX user_security_profiles_block_idx
  ON user_security_profiles (block_type, auto_unfreeze_at);
CREATE INDEX user_security_events_user_time_idx
  ON user_security_events (tenant_id, user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_security_profiles, user_security_events TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE user_security_events_id_seq TO wyerp_app;
