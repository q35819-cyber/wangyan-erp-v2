WITH ranked AS (
  SELECT tenant_id, task_id,
         row_number() OVER (
           PARTITION BY tenant_id, actor_user_id, task_type, status
           ORDER BY started_at DESC, task_id DESC
         ) AS row_number
  FROM sync_tasks
)
DELETE FROM sync_tasks target
USING ranked
WHERE target.tenant_id = ranked.tenant_id
  AND target.task_id = ranked.task_id
  AND ranked.row_number > 200;

CREATE INDEX IF NOT EXISTS sync_tasks_retention_idx
  ON sync_tasks (tenant_id, actor_user_id, task_type, status, started_at DESC, task_id DESC);
