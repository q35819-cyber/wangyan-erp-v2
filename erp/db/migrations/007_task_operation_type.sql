ALTER TABLE sync_tasks
  ADD COLUMN IF NOT EXISTS task_type varchar(20) NOT NULL DEFAULT 'sync';

ALTER TABLE sync_tasks
  DROP CONSTRAINT IF EXISTS sync_tasks_task_type_check;

ALTER TABLE sync_tasks
  ADD CONSTRAINT sync_tasks_task_type_check
  CHECK (task_type IN ('sync', 'create', 'edit', 'archive'));

CREATE INDEX IF NOT EXISTS sync_tasks_tenant_type_started_idx
  ON sync_tasks (tenant_id, task_type, started_at DESC, task_id);
