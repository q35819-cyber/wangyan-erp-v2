-- 自动订单运行保留原记录；手动与自动各自维持同店最多一条活动运行。
DROP INDEX client_order_sync_runs_active_shop_idx;
CREATE UNIQUE INDEX client_order_sync_runs_active_manual_shop_idx
  ON client_order_sync_runs (tenant_id, shop_external_id)
  WHERE mode IN ('manual_all','manual_selected')
    AND state IN ('waiting_client','leased','manifested','backup_ready','uploading','applying');
CREATE UNIQUE INDEX client_order_sync_runs_active_auto_shop_idx
  ON client_order_sync_runs (tenant_id, shop_external_id)
  WHERE mode IN ('auto_daily','auto_new','auto_tracked')
    AND state IN ('waiting_client','leased','manifested','backup_ready','uploading','applying');

-- 历史自动批次可能仍为 running；它不得占用手动运行的批次名额。
DROP INDEX client_order_upload_batches_one_running_shop_idx;
CREATE UNIQUE INDEX client_order_upload_batches_one_running_shop_idx
  ON client_order_upload_batches (tenant_id, shop_external_id, run_id)
  WHERE state = 'running';
