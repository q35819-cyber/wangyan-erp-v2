GRANT USAGE ON SCHEMA public TO wyerp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants,
  users,
  tenant_members,
  sessions,
  roles,
  role_permissions,
  member_roles,
  shops,
  member_shop_scopes
TO wyerp_app;

GRANT SELECT ON permissions TO wyerp_app;
GRANT SELECT, INSERT ON audit_events TO wyerp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wyerp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wyerp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO wyerp_app;
