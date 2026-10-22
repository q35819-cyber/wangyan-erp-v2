ALTER TABLE backup_generations
  ADD COLUMN alert_attempted_at timestamptz,
  ADD COLUMN alerted_at timestamptz,
  ADD COLUMN alert_failure varchar(500);

CREATE INDEX backup_generations_incomplete_alert_idx
  ON backup_generations (completed_at, generation_id)
  WHERE status = 'complete' AND incomplete_sync_count > 0 AND alerted_at IS NULL;
