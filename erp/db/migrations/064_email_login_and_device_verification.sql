-- B-09 邮箱登录、首次/新设备二次验证、忘记密码验证码登录。
-- 普通账号：邮箱+密码；注册必须邮箱+密码+邮箱验证码。
-- 系统管理员：admin账号+密码，继续走管理员专用登录，不使用邮箱。
-- 验证码按 purpose 隔离，注册/二次验证/忘记密码不可互相复用。

CREATE TABLE auth_email_challenges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purpose varchar(32) NOT NULL CHECK (purpose IN ('register','login_step_up','password_recovery')),
  email varchar(240) NOT NULL,
  user_id bigint REFERENCES users(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  consumed_at timestamptz,
  created_ip varchar(80),
  created_device_hash char(64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_email_challenges_lookup_idx
  ON auth_email_challenges (lower(email), purpose, created_at DESC);

CREATE INDEX auth_email_challenges_user_idx
  ON auth_email_challenges (user_id, purpose, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE user_login_devices (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_hash char(64) NOT NULL,
  first_verified_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz NOT NULL DEFAULT now(),
  last_ip varchar(80),
  revoked_at timestamptz,
  revoke_reason varchar(120),
  PRIMARY KEY (user_id, device_hash)
);

CREATE INDEX user_login_devices_active_idx
  ON user_login_devices (user_id, last_verified_at DESC)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_email_challenges, user_login_devices TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE auth_email_challenges_id_seq TO wyerp_app;
