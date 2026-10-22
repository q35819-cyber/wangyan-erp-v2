ALTER TABLE users
  ADD COLUMN is_system_admin boolean NOT NULL DEFAULT false;

CREATE INDEX users_system_admin_idx
  ON users (id)
  WHERE is_system_admin = true AND status = 'active';

COMMENT ON COLUMN users.is_system_admin IS
  'Explicit platform administrator grant. Usernames never imply this privilege.';
