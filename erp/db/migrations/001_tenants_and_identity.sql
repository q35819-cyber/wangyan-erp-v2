CREATE TABLE tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug varchar(80) NOT NULL,
  name varchar(160) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_slug_lower_uq ON tenants (lower(slug));

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username varchar(120) NOT NULL,
  password_hash text NOT NULL,
  password_algorithm varchar(30) NOT NULL DEFAULT 'scrypt',
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'locked')),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_username_lower_uq ON users (lower(username));

CREATE TABLE tenant_members (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  member_type varchar(20) NOT NULL CHECK (member_type IN ('owner', 'member')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled', 'removed')),
  shop_scope_mode varchar(20) NOT NULL DEFAULT 'selected' CHECK (shop_scope_mode IN ('all', 'selected')),
  display_name varchar(120),
  created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE UNIQUE INDEX tenant_single_owner_uq
  ON tenant_members (tenant_id)
  WHERE member_type = 'owner' AND status <> 'removed';

CREATE INDEX tenant_members_user_idx ON tenant_members (user_id, status);

CREATE TABLE sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id bigint,
  token_hash bytea NOT NULL UNIQUE,
  csrf_token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason varchar(80),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE,
  CHECK (idle_expires_at <= absolute_expires_at)
);

CREATE INDEX sessions_active_user_idx
  ON sessions (user_id, absolute_expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE roles (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code varchar(60) NOT NULL,
  name varchar(100) NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE permissions (
  code varchar(100) PRIMARY KEY,
  module varchar(50) NOT NULL,
  action varchar(50) NOT NULL,
  description varchar(200) NOT NULL
);

CREATE TABLE role_permissions (
  tenant_id bigint NOT NULL,
  role_id bigint NOT NULL,
  permission_code varchar(100) NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY (tenant_id, role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE member_roles (
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role_id bigint NOT NULL,
  granted_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);
