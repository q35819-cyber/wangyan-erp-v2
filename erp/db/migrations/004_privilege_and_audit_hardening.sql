ALTER TABLE audit_events
  ADD CONSTRAINT audit_actor_membership_fk
  FOREIGN KEY (tenant_id, actor_user_id)
  REFERENCES tenant_members(tenant_id, user_id)
  ON DELETE RESTRICT;

-- Future migrations must grant runtime access explicitly per table. A blanket
-- default grant could accidentally expose a later security or migration table.
ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_migrator IN SCHEMA public
  REVOKE ALL ON TABLES FROM wyerp_app;

ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_migrator IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM wyerp_app;
