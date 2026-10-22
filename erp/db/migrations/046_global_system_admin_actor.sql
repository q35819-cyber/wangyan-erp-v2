-- 系统管理员是全局用户，不属于客户租户成员。
-- actor/creator/updater 字段记录“谁执行过操作”，允许引用全局系统管理员；
-- 真正的租户成员关系（会话、通知、角色、店铺范围等）仍继续引用 tenant_members。

ALTER TABLE audit_events
  DROP CONSTRAINT audit_actor_membership_fk,
  ADD CONSTRAINT audit_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE tenant_documents
  DROP CONSTRAINT tenant_documents_tenant_id_updated_by_user_id_fkey,
  ADD CONSTRAINT tenant_documents_updated_by_user_fk FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE background_jobs
  DROP CONSTRAINT background_jobs_tenant_id_actor_user_id_fkey,
  ADD CONSTRAINT background_jobs_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE client_order_daily_participants
  DROP CONSTRAINT client_order_daily_participants_tenant_id_actor_user_id_fkey,
  ADD CONSTRAINT client_order_daily_participants_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE membership_daily_sku_usage
  DROP CONSTRAINT membership_daily_sku_usage_tenant_id_actor_user_id_fkey,
  ADD CONSTRAINT membership_daily_sku_usage_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE sku_image_links
  DROP CONSTRAINT sku_image_links_tenant_id_created_by_user_id_fkey,
  ADD CONSTRAINT sku_image_links_created_by_user_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE sku_image_objects
  DROP CONSTRAINT sku_image_objects_tenant_id_created_by_user_id_fkey,
  ADD CONSTRAINT sku_image_objects_created_by_user_fk FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE sync_tasks
  DROP CONSTRAINT sync_tasks_tenant_id_actor_user_id_fkey,
  ADD CONSTRAINT sync_tasks_actor_user_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
