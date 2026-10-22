-- 恢复 046 放宽后的数据库级租户 actor 隔离：
-- 普通用户只能作为自己 active 租户成员的 actor/creator/updater；
-- 唯一全局系统管理员 admin 允许跨租户留下操作记录。

CREATE OR REPLACE FUNCTION enforce_tenant_actor_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_column text := TG_ARGV[0];
  actor_id bigint;
  row_tenant_id bigint;
BEGIN
  actor_id := NULLIF(to_jsonb(NEW) ->> actor_column, '')::bigint;
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  row_tenant_id := NULLIF(to_jsonb(NEW) ->> 'tenant_id', '')::bigint;
  IF row_tenant_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '租户操作记录缺少租户标识，数据库已拒绝写入';
  END IF;

  -- 唯一系统管理员允许跨租户记录操作。
  IF EXISTS (
    SELECT 1
    FROM users u
    WHERE u.id = actor_id
      AND u.is_system_admin = true
      AND lower(u.username) = 'admin'
      AND u.status = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  -- 其余用户必须是当前租户的 active 成员。
  IF NOT EXISTS (
    SELECT 1
    FROM tenant_members tm
    JOIN users u ON u.id = tm.user_id
    WHERE tm.tenant_id = row_tenant_id
      AND tm.user_id = actor_id
      AND tm.status = 'active'
      AND u.status = 'active'
      AND u.is_system_admin = false
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '操作人不属于当前租户，数据库已拒绝跨租户写入';
  END IF;

  RETURN NEW;
END
$$;

-- 该 SECURITY DEFINER 函数只允许由下面的触发器调用，避免成为普通 SQL 调用入口。
REVOKE ALL ON FUNCTION enforce_tenant_actor_scope() FROM PUBLIC;

DROP TRIGGER IF EXISTS audit_events_actor_scope_guard_trg ON audit_events;
CREATE TRIGGER audit_events_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, actor_user_id
ON audit_events
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('actor_user_id');

DROP TRIGGER IF EXISTS tenant_documents_actor_scope_guard_trg ON tenant_documents;
CREATE TRIGGER tenant_documents_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, updated_by_user_id
ON tenant_documents
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('updated_by_user_id');

DROP TRIGGER IF EXISTS background_jobs_actor_scope_guard_trg ON background_jobs;
CREATE TRIGGER background_jobs_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, actor_user_id
ON background_jobs
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('actor_user_id');

DROP TRIGGER IF EXISTS client_order_daily_participants_actor_scope_guard_trg ON client_order_daily_participants;
CREATE TRIGGER client_order_daily_participants_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, actor_user_id
ON client_order_daily_participants
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('actor_user_id');

DROP TRIGGER IF EXISTS membership_daily_sku_usage_actor_scope_guard_trg ON membership_daily_sku_usage;
CREATE TRIGGER membership_daily_sku_usage_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, actor_user_id
ON membership_daily_sku_usage
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('actor_user_id');

DROP TRIGGER IF EXISTS sku_image_links_actor_scope_guard_trg ON sku_image_links;
CREATE TRIGGER sku_image_links_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, created_by_user_id
ON sku_image_links
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('created_by_user_id');

DROP TRIGGER IF EXISTS sku_image_objects_actor_scope_guard_trg ON sku_image_objects;
CREATE TRIGGER sku_image_objects_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, created_by_user_id
ON sku_image_objects
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('created_by_user_id');

DROP TRIGGER IF EXISTS sync_tasks_actor_scope_guard_trg ON sync_tasks;
CREATE TRIGGER sync_tasks_actor_scope_guard_trg
BEFORE INSERT OR UPDATE OF tenant_id, actor_user_id
ON sync_tasks
FOR EACH ROW
EXECUTE FUNCTION enforce_tenant_actor_scope('actor_user_id');
