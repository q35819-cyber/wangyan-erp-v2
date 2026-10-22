ALTER TABLE sync_tasks
  ADD COLUMN parent_task_id varchar(120);

ALTER TABLE sync_tasks
  ADD CONSTRAINT sync_tasks_parent_task_id_format
  CHECK (parent_task_id IS NULL OR parent_task_id ~ '^sync-[A-Za-z0-9-]{6,100}$');

CREATE INDEX sync_tasks_tenant_parent_idx
  ON sync_tasks (tenant_id, parent_task_id)
  WHERE parent_task_id IS NOT NULL;

