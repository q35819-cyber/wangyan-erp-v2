-- 迁移047后 admin 不再属于客户租户；同步设备仍须绑定真实用户和目标租户。
-- 普通用户必须是目标租户的活动成员，唯一系统管理员以全局身份跨租户登记。

ALTER TABLE client_sync_devices
  DROP CONSTRAINT client_sync_devices_tenant_id_user_id_fkey;

CREATE OR REPLACE FUNCTION client_sync_device_actor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = NEW.tenant_id AND status = 'active') THEN
    RAISE EXCEPTION '目标工作空间不可用，无法登记订单同步设备。'
      USING ERRCODE = '23514', CONSTRAINT = 'client_sync_device_actor_scope_chk';
  END IF;

  IF EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NEW.user_id AND u.status = 'active'
      AND lower(u.username) = 'admin' AND u.is_system_admin = true
      AND (SELECT count(*) FROM tenant_members tm WHERE tm.user_id = u.id) = 1
      AND EXISTS (
        SELECT 1 FROM tenant_members tm JOIN tenants home ON home.id = tm.tenant_id
        WHERE tm.user_id = u.id AND tm.member_type = 'owner' AND tm.status = 'active'
          AND tm.shop_scope_mode = 'all' AND home.name = '系统管理' AND home.status = 'active'
      )
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM users u JOIN tenant_members tm ON tm.user_id = u.id
    WHERE u.id = NEW.user_id AND u.status = 'active'
      AND lower(u.username) <> 'admin' AND u.is_system_admin = false
      AND tm.tenant_id = NEW.tenant_id AND tm.status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '当前账号未获目标工作空间的订单同步权限，请重新登录或联系主账号授权。'
    USING ERRCODE = '23514', CONSTRAINT = 'client_sync_device_actor_scope_chk';
END;
$$;

CREATE TRIGGER client_sync_device_actor_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, user_id ON client_sync_devices
FOR EACH ROW EXECUTE FUNCTION client_sync_device_actor_guard();

CREATE OR REPLACE FUNCTION client_sync_device_member_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.status <> 'active' THEN
    UPDATE client_sync_devices
       SET status = 'revoked', authorization_expires_at = now(), updated_at = now()
     WHERE tenant_id = OLD.tenant_id AND user_id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER client_sync_device_member_revoke_trg
AFTER DELETE OR UPDATE OF status ON tenant_members
FOR EACH ROW EXECUTE FUNCTION client_sync_device_member_revoke();

UPDATE client_sync_devices d
   SET status = 'revoked', authorization_expires_at = now(), updated_at = now()
 WHERE NOT EXISTS (
   SELECT 1 FROM users u JOIN tenant_members tm ON tm.user_id = u.id
   JOIN tenants t ON t.id = tm.tenant_id
   WHERE u.id = d.user_id AND u.status = 'active' AND tm.tenant_id = d.tenant_id
     AND tm.status = 'active' AND t.status = 'active'
 ) AND NOT EXISTS (
   SELECT 1 FROM users u JOIN tenants target ON target.id = d.tenant_id
   WHERE u.id = d.user_id AND u.status = 'active' AND target.status = 'active'
     AND lower(u.username) = 'admin' AND u.is_system_admin = true
     AND (SELECT count(*) FROM tenant_members tm WHERE tm.user_id = u.id) = 1
     AND EXISTS (
       SELECT 1 FROM tenant_members tm JOIN tenants home ON home.id = tm.tenant_id
       WHERE tm.user_id = u.id AND tm.member_type = 'owner' AND tm.status = 'active'
         AND tm.shop_scope_mode = 'all' AND home.name = '系统管理' AND home.status = 'active'
     )
 );
