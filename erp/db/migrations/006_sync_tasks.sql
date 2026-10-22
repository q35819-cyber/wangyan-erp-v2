CREATE TABLE sync_tasks (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_id varchar(120) NOT NULL,
  actor_user_id bigint NOT NULL,
  actor_username varchar(120) NOT NULL,
  task_name varchar(160) NOT NULL,
  progress_label varchar(500) NOT NULL,
  progress_value smallint NOT NULL DEFAULT 0 CHECK (progress_value BETWEEN 0 AND 100),
  status varchar(20) NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  failure_reason varchar(1500) NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (tenant_id, task_id),
  FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE CASCADE
);

CREATE INDEX sync_tasks_tenant_started_idx ON sync_tasks (tenant_id, started_at DESC, task_id);
CREATE INDEX sync_tasks_actor_started_idx ON sync_tasks (tenant_id, actor_user_id, started_at DESC, task_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON sync_tasks TO wyerp_app;
