CREATE TABLE shops (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name varchar(160) NOT NULL,
  external_shop_id varchar(120),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  credential_ciphertext bytea,
  credential_key_version smallint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX shops_external_id_uq
  ON shops (tenant_id, external_shop_id)
  WHERE external_shop_id IS NOT NULL;

CREATE INDEX shops_tenant_status_idx ON shops (tenant_id, status, id);

CREATE TABLE member_shop_scopes (
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL,
  shop_id bigint NOT NULL,
  granted_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, shop_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shop_id) REFERENCES shops(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  action varchar(100) NOT NULL,
  resource_type varchar(80),
  resource_id varchar(160),
  result varchar(20) NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  request_id uuid,
  source_ip_hash varchar(128),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX audit_events_actor_time_idx ON audit_events (actor_user_id, created_at DESC, id DESC);

INSERT INTO permissions (code, module, action, description) VALUES
  ('tenant.members.read', 'tenant', 'read_members', '查看子账号与成员状态'),
  ('tenant.members.manage', 'tenant', 'manage_members', '创建、停用和移除子账号'),
  ('tenant.roles.read', 'tenant', 'read_roles', '查看角色和权限'),
  ('tenant.roles.manage', 'tenant', 'manage_roles', '配置角色和权限'),
  ('shops.read', 'shops', 'read', '查看授权店铺'),
  ('shops.write', 'shops', 'write', '编辑授权店铺'),
  ('shops.credentials.manage', 'shops', 'manage_credentials', '配置和轮换店铺凭证'),
  ('orders.read', 'orders', 'read', '查看授权店铺订单'),
  ('orders.write', 'orders', 'write', '修改授权店铺订单业务字段'),
  ('orders.export', 'orders', 'export', '导出授权店铺订单'),
  ('products.read', 'products', 'read', '查看授权店铺商品'),
  ('products.write', 'products', 'write', '修改授权店铺商品'),
  ('sync.run', 'sync', 'run', '发起授权店铺同步任务'),
  ('audit.read', 'audit', 'read', '查看租户审计日志'),
  ('overview.import', 'overview', 'import', '导入公共大盘数据')
ON CONFLICT (code) DO NOTHING;
