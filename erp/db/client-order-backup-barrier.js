#!/usr/bin/env node
'use strict';

const { Client } = require('pg');
const { createDatabaseConfig } = require('./config');
const ORDER_AUTO_SYNC_PAUSED = true;

async function dailyCycleState(client) {
  if (ORDER_AUTO_SYNC_PAUSED) return null;
  await client.query(
    `UPDATE client_order_sync_runs run SET state='lease_expired',failure_code='client_sync_lease_expired',
       failure_detail='每日同步在最晚备份时间前未完成',completed_at=now(),lease_expires_at=NULL,updated_at=now()
     FROM client_order_daily_cycles cycle
     WHERE run.daily_cycle_id=cycle.cycle_id AND cycle.status='collecting' AND cycle.cutoff_at<=now()
       AND run.state IN ('waiting_client','leased')`
  );
  await client.query(
    `UPDATE client_order_daily_participants participant SET state='lease_expired',
       failure_code='client_sync_lease_expired',updated_at=now()
     FROM client_order_daily_cycles cycle
     WHERE participant.cycle_id=cycle.cycle_id AND cycle.status='collecting' AND cycle.cutoff_at<=now()
       AND participant.state IN ('waiting_client','leased')`
  );
  const result = await client.query(
    `SELECT cycle.cycle_id,cycle.cycle_day,cycle.status,cycle.cutoff_at,cycle.participant_count,
       count(participant.*) FILTER (WHERE participant.state='snapshot_ready')::int snapshot_ready_count,
       count(participant.*) FILTER (WHERE participant.state IN ('failed','lease_expired'))::int failed_count,
       count(participant.*) FILTER (WHERE participant.state IN ('waiting_client','leased'))::int waiting_count
     FROM client_order_daily_cycles cycle
     LEFT JOIN client_order_daily_participants participant ON participant.cycle_id=cycle.cycle_id
     WHERE cycle.cycle_day=CURRENT_DATE
       AND cycle.status IN ('collecting','ready','backup_incomplete')
     GROUP BY cycle.cycle_id ORDER BY cycle.created_at DESC LIMIT 1`
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, should_wait: Number(row.waiting_count) > 0 && new Date(row.cutoff_at) > new Date() };
}

async function main() {
  const command = process.argv[2];
  const client = new Client(createDatabaseConfig({ migration: true }));
  await client.connect();
  try {
    if (command === 'status') {
      const result = await client.query(`SELECT state,count(*)::int count FROM client_order_sync_runs WHERE mode IN ('manual_all','manual_selected') AND state IN ('waiting_client','leased','manifested','backup_ready','uploading','applying') GROUP BY state ORDER BY state`);
      const dailyCycle = await dailyCycleState(client);
      process.stdout.write(JSON.stringify({ states: result.rows, dailyCycle }) + '\n');
      return;
    }
    if (command === 'begin') {
      await client.query('BEGIN');
      const dailyCycle = await dailyCycleState(client);
      if (dailyCycle && dailyCycle.should_wait) throw Object.assign(new Error('当日订单同步周期仍有店铺未完成，暂不能开启备份代次，请等待自动同步收尾后重试。'), { code: 'client_order_daily_cycle_waiting' });
      const incomplete = dailyCycle ? Number(dailyCycle.participant_count) - Number(dailyCycle.snapshot_ready_count) : 0;
      const result = await client.query(
        `INSERT INTO backup_generations(status,daily_cycle_id,incomplete_sync_count)
         VALUES ('running',$1,$2) RETURNING generation_id,started_at`,
        [dailyCycle && dailyCycle.cycle_id || null, Math.max(0, incomplete)]
      );
      if (dailyCycle) await client.query(
        `UPDATE client_order_daily_cycles SET status=$2,completed_at=now(),updated_at=now() WHERE cycle_id=$1`,
        [dailyCycle.cycle_id, incomplete ? 'backup_incomplete' : 'ready']
      );
      await client.query('COMMIT');
      process.stdout.write(JSON.stringify({ generationId: Number(result.rows[0].generation_id), startedAt: result.rows[0].started_at,
        dailyCycleId: dailyCycle && dailyCycle.cycle_id || null, incompleteSyncCount: Math.max(0, incomplete) }) + '\n');
      return;
    }
    const generationId = Number(process.argv[3]);
    if (!Number.isSafeInteger(generationId) || generationId < 1) throw Object.assign(new Error('备份代次编号无效，请从上一段输出里取用真实的代次编号后重试。'), { code: 'backup_generation_invalid' });
    if (command === 'complete') {
      const backupName = String(process.argv[4] || '').slice(0, 240);
      const dumpSha256 = String(process.argv[5] || '').toLowerCase();
      if (!backupName || !/^[a-f0-9]{64}$/.test(dumpSha256)) throw Object.assign(new Error('备份证据不完整：必须同时提供备份文件名和64位SHA-256摘要，请补齐参数后重试。'), { code: 'backup_evidence_invalid' });
      await client.query('BEGIN');
      const generation = await client.query(`UPDATE backup_generations SET status='complete',backup_name=$2,dump_sha256=$3,completed_at=now() WHERE generation_id=$1 AND status='running' RETURNING started_at`, [generationId, backupName, dumpSha256]);
      if (!generation.rowCount) throw Object.assign(new Error('备份代次不存在或已结束，请重新开始备份并核对代次编号。'), { code: 'backup_generation_not_running' });
      const released = await client.query(`UPDATE client_order_sync_runs SET state='backup_ready',backup_generation_id=$1,updated_at=now() WHERE mode IN ('manual_all','manual_selected') AND state='manifested' AND updated_at<=$2`, [generationId, generation.rows[0].started_at]);
      const empty = await client.query(
        `UPDATE client_order_sync_runs run SET state='no_change',
           server_revision=COALESCE((SELECT version FROM business_data_versions version
             WHERE version.tenant_id=run.tenant_id AND version.document_key='erp_orders_data'),0),
           completed_at=now(),updated_at=now()
         FROM client_order_sync_manifests manifest
         WHERE run.run_id=manifest.run_id AND run.backup_generation_id=$1 AND run.mode IN ('manual_all','manual_selected') AND run.state='backup_ready'
           AND manifest.order_count=0 AND manifest.batch_count=0
         RETURNING run.run_id,run.tenant_id`, [generationId]
      );
      if (empty.rowCount) await client.query(
        `UPDATE sync_tasks task SET status='done',progress_value=100,progress_label='客户端订单同步完成（无变化）',
           ended_at=now(),updated_at=now()
         FROM client_order_sync_runs run
         WHERE run.backup_generation_id=$1 AND run.mode IN ('manual_all','manual_selected') AND run.state='no_change'
           AND task.tenant_id=run.tenant_id AND task.task_id='client-order-'||run.run_id::text`, [generationId]
      );
      await client.query(
        `UPDATE client_order_daily_cycles cycle SET status='backed_up',updated_at=now()
         FROM backup_generations generation WHERE generation.generation_id=$1 AND generation.daily_cycle_id=cycle.cycle_id`, [generationId]
      );
      await client.query('COMMIT');
      process.stdout.write(JSON.stringify({ generationId, releasedRuns: released.rowCount, emptyRunsNoChange: empty.rowCount }) + '\n');
      return;
    }
    if (command === 'fail') {
      const failureCode = String(process.argv[4] || 'backup_failed').replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 100);
      await client.query(`UPDATE backup_generations SET status='failed',failure_code=$2 WHERE generation_id=$1 AND status='running'`, [generationId, failureCode]);
      process.stdout.write(JSON.stringify({ generationId, status: 'failed' }) + '\n');
      return;
    }
    throw new Error('usage: client-order-backup-barrier.js status|begin|complete|fail');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
