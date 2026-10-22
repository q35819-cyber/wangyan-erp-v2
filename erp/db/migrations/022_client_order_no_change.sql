ALTER TABLE client_order_sync_runs DROP CONSTRAINT client_order_sync_runs_state_check;
ALTER TABLE client_order_sync_runs ADD CONSTRAINT client_order_sync_runs_state_check CHECK (state IN (
  'waiting_client','leased','manifested','backup_ready','uploading','applying',
  'completed','no_change','failed','cancelled','authorization_expired','lease_expired'
));
