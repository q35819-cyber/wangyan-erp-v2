ALTER TABLE sync_tasks
  ADD COLUMN IF NOT EXISTS entity_article varchar(180) NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS entity_sku varchar(180) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS sync_tasks_tenant_article_idx
  ON sync_tasks (tenant_id, entity_article)
  WHERE entity_article <> '';
