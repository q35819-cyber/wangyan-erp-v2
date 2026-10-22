-- 系统管理员邮箱仅作为资料/通知邮箱，不作为邮箱登录标识。
-- 普通非管理员账号之间仍保持邮箱唯一；管理员邮箱可与任意普通账号共用。
-- 旧 042 的全局 lower(email) 唯一索引无法表达“管理员豁免”，
-- 因此改为由数据库同步的管理员豁免位 + 普通用户部分唯一索引。

ALTER TABLE user_profiles
  ADD COLUMN email_unique_exempt boolean NOT NULL DEFAULT false;

UPDATE user_profiles up
SET email_unique_exempt = u.is_system_admin
FROM users u
WHERE u.id = up.user_id
  AND up.email_unique_exempt IS DISTINCT FROM u.is_system_admin;

DROP INDEX IF EXISTS user_profiles_email_lower_uq;

CREATE UNIQUE INDEX user_profiles_non_admin_email_lower_uq
  ON user_profiles (lower(email))
  WHERE email <> '' AND email_unique_exempt = false;

CREATE OR REPLACE FUNCTION sync_user_profile_email_unique_exempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  admin_flag boolean;
BEGIN
  SELECT is_system_admin INTO admin_flag
  FROM users
  WHERE id = NEW.user_id;

  IF admin_flag IS NULL THEN
    RAISE EXCEPTION 'profile user missing: %', NEW.user_id;
  END IF;

  NEW.email_unique_exempt := admin_flag;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_profiles_email_unique_exempt_sync_trg ON user_profiles;
CREATE TRIGGER user_profiles_email_unique_exempt_sync_trg
BEFORE INSERT OR UPDATE OF user_id, email ON user_profiles
FOR EACH ROW
EXECUTE FUNCTION sync_user_profile_email_unique_exempt();

CREATE OR REPLACE FUNCTION sync_user_admin_profile_email_unique_exempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.is_system_admin IS DISTINCT FROM OLD.is_system_admin THEN
    UPDATE user_profiles
    SET email_unique_exempt = NEW.is_system_admin
    WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_admin_profile_email_unique_exempt_sync_trg ON users;
CREATE TRIGGER users_admin_profile_email_unique_exempt_sync_trg
AFTER UPDATE OF is_system_admin ON users
FOR EACH ROW
EXECUTE FUNCTION sync_user_admin_profile_email_unique_exempt();

COMMENT ON COLUMN user_profiles.email_unique_exempt IS
  'true only for system administrator; admin email is profile/notification only and excluded from normal-user email uniqueness/login identity';
