-- 系统管理员身份收口：唯一 admin，禁止作为客户子账号，并清理可安全识别的历史错误成员关系。
-- 规则：用户名 admin <=> is_system_admin=true；系统管理员只能保留一条 active owner/all 成员关系。

-- 先撤销任何非 admin 账号被误授予的系统管理员标记。
UPDATE users
SET is_system_admin = false, updated_at = now()
WHERE is_system_admin = true
  AND lower(username) <> 'admin';

-- 历史 admin 账号统一恢复为唯一系统管理员身份。
UPDATE users
SET is_system_admin = true, status = 'active', updated_at = now()
WHERE lower(username) = 'admin';

DO $$
DECLARE
  admin_id bigint;
  home_tenant_id bigint;
  active_owner_count integer;
BEGIN
  SELECT id INTO admin_id
  FROM users
  WHERE lower(username) = 'admin'
  ORDER BY id
  LIMIT 1;

  IF admin_id IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*)::integer INTO active_owner_count
  FROM tenant_members
  WHERE user_id = admin_id
    AND member_type = 'owner'
    AND status = 'active';

  IF active_owner_count = 1 THEN
    SELECT tm.tenant_id INTO home_tenant_id
    FROM tenant_members tm
    JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = admin_id
      AND tm.member_type = 'owner'
      AND tm.status = 'active'
      AND t.name = '系统管理'
    LIMIT 1;

    IF home_tenant_id IS NULL THEN
      RAISE EXCEPTION 'admin 的唯一活动 owner 关系不在系统管理租户，禁止自动猜测客户租户，请先人工确认';
    END IF;
  ELSIF active_owner_count > 1 THEN
    SELECT tm.tenant_id INTO home_tenant_id
    FROM tenant_members tm
    JOIN tenants t ON t.id = tm.tenant_id
    WHERE tm.user_id = admin_id
      AND tm.member_type = 'owner'
      AND tm.status = 'active'
      AND t.name = '系统管理'
    ORDER BY tm.tenant_id
    LIMIT 1;

    IF home_tenant_id IS NULL THEN
      RAISE EXCEPTION 'admin 同时拥有多个租户且无法唯一识别系统管理租户，禁止自动猜测，请先人工确认';
    END IF;

    IF EXISTS (
      SELECT 1 FROM tenant_members
      WHERE user_id = admin_id
        AND member_type = 'owner'
        AND status = 'active'
        AND tenant_id <> home_tenant_id
    ) THEN
      RAISE EXCEPTION 'admin 仍是多个活动租户的 owner，禁止自动删除客户主账号关系，请先人工确认';
    END IF;
  ELSE
    INSERT INTO tenants(slug, name, status)
    VALUES (
      'system-admin-home-' || admin_id::text || '-' || substr(md5(clock_timestamp()::text || admin_id::text), 1, 8),
      '系统管理',
      'active'
    )
    RETURNING id INTO home_tenant_id;

    INSERT INTO tenant_members
      (tenant_id, user_id, member_type, status, shop_scope_mode, display_name, created_by_user_id, joined_at)
    VALUES
      (home_tenant_id, admin_id, 'owner', 'active', 'all', '系统管理员', admin_id, now());
  END IF;

  -- 如果 admin 在客户空间拥有“所有者语义”的业务对象，自动删除可能损坏客户数据，因此失败关闭并要求人工确认。
  IF EXISTS (SELECT 1 FROM agents WHERE owner_user_id = admin_id AND tenant_id <> home_tenant_id)
     OR EXISTS (SELECT 1 FROM ai_configurations WHERE owner_user_id = admin_id AND tenant_id <> home_tenant_id)
     OR EXISTS (SELECT 1 FROM ai_configuration_defaults WHERE owner_user_id = admin_id AND tenant_id <> home_tenant_id)
     OR EXISTS (SELECT 1 FROM ai_prompt_templates WHERE owner_user_id = admin_id AND tenant_id <> home_tenant_id)
     OR EXISTS (SELECT 1 FROM ai_subaccount_permissions WHERE owner_user_id = admin_id AND tenant_id <> home_tenant_id)
  THEN
    RAISE EXCEPTION '历史 admin 客户成员关系仍被客户所有者数据引用，禁止自动删除业务数据，请先人工确认归属';
  END IF;

  -- admin 在客户空间的个人偏好/通知属于错误成员关系附属数据，可安全清理。
  DELETE FROM ai_user_preferences
  WHERE user_id = admin_id AND tenant_id <> home_tenant_id;

  DELETE FROM ai_subaccount_permissions
  WHERE user_id = admin_id AND tenant_id <> home_tenant_id;

  DELETE FROM user_notifications
  WHERE user_id = admin_id AND tenant_id <> home_tenant_id;

  -- member_roles、member_shop_scopes、sessions、client_sync_devices、安全事件/资料均由外键级联清理。
  DELETE FROM tenant_members
  WHERE user_id = admin_id
    AND tenant_id <> home_tenant_id;

  UPDATE tenant_members
  SET member_type = 'owner',
      status = 'active',
      shop_scope_mode = 'all',
      updated_at = now()
  WHERE tenant_id = home_tenant_id
    AND user_id = admin_id;
END
$$;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_admin_identity_chk;

ALTER TABLE users
  ADD CONSTRAINT users_admin_identity_chk
  CHECK (
    (lower(username) = 'admin') = is_system_admin
    AND (NOT is_system_admin OR status = 'active')
  );

DROP INDEX IF EXISTS users_system_admin_idx;

CREATE UNIQUE INDEX users_single_system_admin_uq
  ON users ((1))
  WHERE is_system_admin = true;

CREATE OR REPLACE FUNCTION protect_single_admin_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF lower(OLD.username) = 'admin' AND OLD.is_system_admin = true THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION '唯一系统管理员 admin 账号不能删除';
    END IF;
    IF lower(NEW.username) <> 'admin' OR NEW.is_system_admin <> true OR NEW.status <> 'active' THEN
      RAISE EXCEPTION '唯一系统管理员 admin 不能改名、降级或停用';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS users_single_admin_guard_trg ON users;
CREATE TRIGGER users_single_admin_guard_trg
BEFORE UPDATE OF username, is_system_admin, status OR DELETE
ON users
FOR EACH ROW
EXECUTE FUNCTION protect_single_admin_user();

CREATE OR REPLACE FUNCTION enforce_admin_tenant_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_is_admin boolean := false;
  old_is_admin boolean := false;
BEGIN
  SELECT (is_system_admin = true AND lower(username) = 'admin')
    INTO new_is_admin
  FROM users
  WHERE id = NEW.user_id;

  IF TG_OP = 'UPDATE' THEN
    SELECT (is_system_admin = true AND lower(username) = 'admin')
      INTO old_is_admin
    FROM users
    WHERE id = OLD.user_id;

    IF old_is_admin AND NEW.user_id <> OLD.user_id THEN
      RAISE EXCEPTION '系统管理员 admin 的唯一租户归属不能转移给其他用户';
    END IF;
  END IF;

  IF new_is_admin THEN
    IF NEW.member_type <> 'owner' OR NEW.status <> 'active' OR NEW.shop_scope_mode <> 'all' THEN
      RAISE EXCEPTION '系统管理员 admin 只能作为唯一系统管理租户的 active owner，不能作为子账号';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM tenant_members tm
      WHERE tm.user_id = NEW.user_id
        AND tm.tenant_id <> NEW.tenant_id
    ) THEN
      RAISE EXCEPTION '系统管理员 admin 只能保留一个租户归属，不能加入客户租户';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION prevent_admin_membership_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_is_admin boolean := false;
BEGIN
  SELECT (is_system_admin = true AND lower(username) = 'admin')
    INTO old_is_admin
  FROM users
  WHERE id = OLD.user_id;

  IF old_is_admin THEN
    RAISE EXCEPTION '系统管理员 admin 的唯一系统管理租户归属不能删除';
  END IF;

  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS tenant_members_admin_guard_trg ON tenant_members;
CREATE TRIGGER tenant_members_admin_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, user_id, member_type, status, shop_scope_mode
ON tenant_members
FOR EACH ROW
EXECUTE FUNCTION enforce_admin_tenant_membership();

DROP TRIGGER IF EXISTS tenant_members_admin_delete_guard_trg ON tenant_members;
CREATE TRIGGER tenant_members_admin_delete_guard_trg
BEFORE DELETE
ON tenant_members
FOR EACH ROW
EXECUTE FUNCTION prevent_admin_membership_delete();
