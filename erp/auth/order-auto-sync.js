'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function stamp(d = new Date()) { return d.toISOString(); }
function day(d) { return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
function safeError(error) { return String(error && (error.publicCode || error.message) || error || 'unknown').replace(/[\r\n\t]/g, ' ').slice(0, 500); }
function shopTag(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12); }
function atomicJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(tmp, file); }
const SILENT_CONFIGURATION_CODES = new Set([
  'seller_cookie_authorization_required', 'seller_cookie_unauthorized', 'seller_cookies_required',
  'seller_cookie_credential_unreadable',
  'seller_session_required', 'erp_login_required', 'unauthorized',
  'client_sync_device_unavailable', 'client_sync_device_unauthorized', 'client_sync_contract_unverified',
  'client_sync_actor_unavailable', 'client_sync_client_restarted'
]);
function failureNotificationPolicy(error) {
  const code = safeError(error).split(/[；;\s]/)[0];
  return SILENT_CONFIGURATION_CODES.has(code) ? { notify: false, category: 'configuration', code } : { notify: true, category: 'business', code };
}

function createOrderAutoSync(options = {}) {
  const stateFile = options.stateFile;
  const logDir = options.logDir;
  const run = options.run;
  const mailer = options.mailer;
  const now = options.now || (() => new Date());
  let active = false;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  function log(level, event, data = {}) {
    const current = now(); fs.mkdirSync(logDir, { recursive: true });
    const file = path.join(logDir, 'order-auto-sync-' + current.toISOString().slice(0, 7) + '.log');
    fs.appendFileSync(file, JSON.stringify({ time: stamp(current), level, event, ...data }) + '\n', 'utf8');
  }
  async function execute(kind) {
    const started = now(); state[kind + 'Attempt'] = stamp(started); state[kind + 'Status'] = 'running'; delete state[kind + 'Failure']; atomicJson(stateFile, state); log('INFO', 'START', { kind });
    try {
      const result = await run(kind, entry => log(entry.level || 'INFO', entry.event || 'SHOP', { kind, shop: shopTag(entry.shop), count: entry.count, saved: entry.saved, reason: entry.reason }));
      if (result && result.pending) {
        const status = result.noCandidates ? 'no_candidates' : result.waitingClient > 0 && !result.count ? 'waiting_client' : 'queued_client';
        state[kind + 'Status'] = status;
        atomicJson(stateFile, state);
        log('INFO', status === 'no_candidates' ? 'NO_CANDIDATES' : status === 'waiting_client' ? 'WAITING_CLIENT' : 'QUEUED_CLIENT', { kind, durationMs: now() - started, count: result.count || 0, waitingClient: result.waitingClient || 0 });
        return;
      }
      state[kind] = stamp(now()); state[kind + 'Status'] = 'success'; atomicJson(stateFile, state);
      log('INFO', 'SUCCESS', { kind, durationMs: now() - started, count: result && result.count || 0 });
    } catch (error) {
      const failed = now(), reason = safeError(error), policy = failureNotificationPolicy(error); state[kind + 'Status'] = 'failed'; state[kind + 'Failure'] = { failedAt: stamp(failed), reason, category: policy.category }; atomicJson(stateFile, state); log('ERROR', 'FAIL', { kind, startedAt: stamp(started), failedAt: stamp(failed), durationMs: failed - started, reason, category: policy.category });
      if (!policy.notify) log('INFO', 'MAIL_SKIPPED', { kind, reason: '配置或登录状态异常不发送邮件', code: policy.code });
      else if (mailer && mailer.configured) {
        // 管理员告警邮件的"原因"必须是中文，代号只作溯源；状态文件与服务端日志继续保留原始文本供排查。
        const plainErrorText = String(error && error.message || '');
        const mailReason = /[\u3400-\u9fff]/.test(plainErrorText) ? plainErrorText.replace(/[\r\n\t]/g, ' ').slice(0, 500)
          : '服务器订单自动同步未执行成功，本次没有写入任何订单数据；内部代号：' + policy.code;
        try { await mailer.sendSystemAlert('订单自动同步失败', '服务器订单自动同步任务执行失败，请检查 Ozon、店铺权限和网络。', [{ name: kind, endpoint: error && error.shop ? '店铺 ' + shopTag(error.shop) : '自动调度器', purpose: `开始 ${stamp(started)}；失败 ${stamp(failed)}；阶段 ${String(error && error.stage || '同步')}`, reason: mailReason, attempts: 1, lastCheckedAt: stamp(failed) }]); }
        catch (mailError) { log('ERROR', 'MAIL_FAIL', { kind, reason: safeError(mailError) }); }
      } else log('WARN', 'MAIL_SKIPPED', { kind, reason: 'SMTP未配置' });
    }
  }
  function elapsed(key, ms, current) { const before = Date.parse(state[key] || ''); return !Number.isFinite(before) || current.getTime() - before >= ms; }
  async function tick() {
    if (active) return false; active = true;
    try {
      const current = now();
      if (current.getHours() >= 2 && (!state.dailyAttempt || day(new Date(state.dailyAttempt)) !== day(current))) await execute('daily');
      if (elapsed('newOrdersAttempt', 2 * 60 * 60 * 1000, current)) await execute('newOrders');
      if (elapsed('trackedPrepAttempt', 10 * 60 * 1000, current)) await execute('trackedPrep');
      return true;
    } finally { active = false; }
  }
  return { tick, execute, state: () => ({ ...state }), shopTag };
}
module.exports = { createOrderAutoSync, failureNotificationPolicy };
