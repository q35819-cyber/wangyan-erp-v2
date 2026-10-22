'use strict';

const crypto = require('crypto');

const CHANGE_WINDOW_MS = 30 * 60 * 1000;
const RISK_COOLDOWN_MS = 5 * 60 * 1000;
const AUTO_UNFREEZE_MS = 24 * 60 * 60 * 1000;
const SHORT_WINDOW_MS = 10 * 1000;
const SHORT_WINDOW_MAX = 50;
const MINUTE_WINDOW_MS = 60 * 1000;
const MINUTE_WINDOW_MAX = 180;
const MAX_RISKS = 10;
const RISK_CHAIN_RESET_MS = 24 * 60 * 60 * 1000;

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 240 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function maskedDevice(value) {
  const text = String(value || '');
  return text ? text.slice(0, 6) + '…' + text.slice(-4) : '';
}

function normalizeIp(value) {
  const ip = String(value || 'unknown').replace(/^::ffff:/, '').replace(/%.+$/, '').slice(0, 80);
  return ip || 'unknown';
}

function ipNetwork(value) {
  const ip = normalizeIp(value);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

function identityChangeRisk(profile, recentRows, ip, deviceHashValue) {
  const currentNetwork = ipNetwork(ip);
  const recent = Array.isArray(recentRows) ? recentRows : [];
  const knownDevices = new Set(recent.map(row => String(row && row.device_hash || '')).filter(Boolean));
  const knownNetworks = new Set(recent.map(row => ipNetwork(row && row.ip_address)).filter(Boolean));
  [profile && profile.first_device_hash, profile && profile.last_device_hash].map(value => String(value || '')).filter(Boolean).forEach(value => knownDevices.add(value));
  [profile && profile.first_ip, profile && profile.last_ip].map(value => value ? ipNetwork(value) : '').filter(Boolean).forEach(value => knownNetworks.add(value));
  const sameDevice = Boolean(deviceHashValue && knownDevices.has(String(deviceHashValue)));
  const sameNetwork = Boolean(currentNetwork && knownNetworks.has(currentNetwork));
  return { changed: !sameDevice && !sameNetwork, sameDevice, sameNetwork, currentNetwork };
}

function shouldSendRiskMail(count, frozen) {
  return Boolean(frozen || Number(count) === 1 || Number(count) === 5);
}

function riskTaskStatus(frozen) {
  return frozen ? 'failed' : 'done';
}

function riskCountsTowardFreeze(type) {
  return type === 'identity_change';
}

function createUserSecurityMonitor(options) {
  const pool = options.pool;
  const taskStore = options.taskStore;
  const mailer = options.mailer;
  const requestWindows = new Map();
  const riskCooldowns = new Map();
  const now = options.now || (() => Date.now());

  function deviceHash(deviceId) {
    const raw = String(deviceId || '');
    if (!/^[a-f0-9]{64}$/i.test(raw)) return '';
    return crypto.createHmac('sha256', options.deviceSecret).update(raw).digest('hex');
  }

  async function ensureProfile(client, account) {
    await client.query(
      `INSERT INTO user_security_profiles (tenant_id, user_id, security_email)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [account.tenantId, account.userId, validEmail(account.username) || null]
    );
  }

  async function affectedAccount(tenantId, userId) {
    const result = await pool.query(
      `SELECT tm.tenant_id::text, tm.user_id::text, u.username, tm.display_name, tm.member_type
       FROM tenant_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1 AND tm.user_id = $2 LIMIT 1`, [tenantId, userId]
    );
    const row = result.rows[0];
    return row && { tenantId: row.tenant_id, userId: row.user_id, username: row.username,
      displayName: row.display_name || row.username, memberType: row.member_type, permissions: [] };
  }

  async function sendRiskMail(account, profile, reason, frozen) {
    const userRecipient = validEmail(profile.security_email) || validEmail(account.username);
    const recipient = userRecipient || mailer.recipient;
    const identity = account.memberType === 'member' ? `子账号ID ${account.userId}` : '账号';
    const message = frozen
      ? `${identity}有风险，账号组已冻结，已通知系统管理员。系统管理员 24 小时内未处理且未发现新异常时将自动解封。`
      : `${identity}出现异常访问：${reason}。如果不是本人操作，请立即修改密码并联系管理员。`;
    if (recipient) mailer.sendSecurityAlert(recipient, frozen ? '账号安全冻结提醒' : '账号安全风险提醒',
      message + (!userRecipient ? '\n该用户尚未配置安全邮箱，本提醒已转发至系统管理员邮箱。' : '')).catch(() => {});
    if (frozen && userRecipient && userRecipient !== mailer.recipient) mailer.sendSecurityAlert(mailer.recipient, '用户账号组已自动冻结', `${message}\n登录账号：${account.username}\n连续异常：${MAX_RISKS} 次`).catch(() => {});
  }

  async function writeTask(account, count, reason, status) {
    await taskStore.upsertSyncTask(account, {
      id: `user-security-${account.userId}`, type: 'sync', status: status || 'running',
      value: Math.min(100, count * 10), name: `用户安全监控 · ${account.username}`,
      label: count >= MAX_RISKS ? '连续 10 次异常，账号组已冻结' : `检测到第 ${count} 次异常`,
      reason, startedAt: new Date(now()).toISOString()
    });
  }

  async function freezeTenant(client, account, reason) {
    const active = await client.query(
      `SELECT tm.user_id::text FROM tenant_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.tenant_id = $1 AND tm.status = 'active' AND u.is_system_admin = false FOR UPDATE`, [account.tenantId]
    );
    const ids = active.rows.map(row => row.user_id);
    if (ids.length) {
      await client.query(`UPDATE tenant_members SET status = 'disabled', updated_at = now()
        WHERE tenant_id = $1 AND user_id = ANY($2::bigint[]) AND status = 'active'`, [account.tenantId, ids]);
      await client.query(`UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'security_auto_frozen'
        WHERE tenant_id = $1 AND user_id = ANY($2::bigint[]) AND revoked_at IS NULL`, [account.tenantId, ids]);
    }
    const until = new Date(now() + AUTO_UNFREEZE_MS);
    await client.query(
      `UPDATE user_security_profiles SET block_type = 'auto_frozen', block_reason = $3, blocked_at = now(),
       auto_unfreeze_at = $4, blocked_member_ids = $5::jsonb, admin_handled = false, updated_at = now()
       WHERE tenant_id = $1 AND user_id = $2`,
      [account.tenantId, account.userId, reason, until, JSON.stringify(ids)]
    );
    return until;
  }

  async function recordRisk(account, type, reason, context) {
    const cooldownKey = `${account.tenantId}|${account.userId}|${type}`;
    const last = riskCooldowns.get(cooldownKey) || 0;
    if (now() - last < RISK_COOLDOWN_MS) return { counted: false };
    if (!last && riskCooldowns.size >= 50000) riskCooldowns.delete(riskCooldowns.keys().next().value);
    riskCooldowns.set(cooldownKey, now());
    const client = await pool.connect();
    let profile;
    let count;
    let frozen = false;
    try {
      await client.query('BEGIN');
      await ensureProfile(client, account);
      const current = await client.query(
        `SELECT * FROM user_security_profiles WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
        [account.tenantId, account.userId]
      );
      profile = current.rows[0];
      if (profile.block_type !== 'none') { await client.query('COMMIT'); return { counted: false, blocked: true }; }
      const freezeEligible = riskCountsTowardFreeze(type);
      const previousRiskAt = profile.last_risk_at ? new Date(profile.last_risk_at).getTime() : 0;
      const previousCount = previousRiskAt && now() - previousRiskAt <= RISK_CHAIN_RESET_MS ? Number(profile.risk_count || 0) : 0;
      count = freezeEligible ? Math.min(MAX_RISKS, previousCount + 1) : Number(profile.risk_count || 0);
      if (freezeEligible) {
        await client.query(
          `UPDATE user_security_profiles SET risk_count = $3, last_risk_at = now(), last_ip = $4,
           last_device_hash = COALESCE(NULLIF($5, ''), last_device_hash), last_seen_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2`,
          [account.tenantId, account.userId, count, context.ip, context.deviceHash]
        );
      } else {
        await client.query(
          `UPDATE user_security_profiles SET last_ip = $3,
           last_device_hash = COALESCE(NULLIF($4, ''), last_device_hash), last_seen_at = now(), updated_at = now()
           WHERE tenant_id = $1 AND user_id = $2`,
          [account.tenantId, account.userId, context.ip, context.deviceHash]
        );
      }
      await client.query(
        `INSERT INTO user_security_events (tenant_id, user_id, event_type, risk_count, ip_address, device_hash, reason, details)
         VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8::jsonb)`,
        [account.tenantId, account.userId, type, count, context.ip, context.deviceHash, reason, JSON.stringify(context.details || {})]
      );
      if (freezeEligible && count >= MAX_RISKS) { await freezeTenant(client, account, reason); frozen = true; }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    // Request-rate spikes remain audit events only. They must not advance the
    // identity-risk chain, create noisy task-center rows or trigger freeze-chain mail.
    if (!riskCountsTowardFreeze(type)) return { counted: false, monitored: true, count, frozen: false };
    // An identity-risk check is point-in-time, not a long-running sync job.
    // Keep only an account freeze as failed; otherwise close the task immediately.
    await writeTask(account, count, reason, riskTaskStatus(frozen)).catch(() => {});
    if (shouldSendRiskMail(count, frozen)) sendRiskMail(account, profile || {}, reason, frozen);
    return { counted: true, count, frozen };
  }

  async function noteLogin(account, input) {
    const ip = normalizeIp(input.ip);
    const hash = deviceHash(input.deviceId);
    const client = await pool.connect();
    let changed = false;
    let reason = '';
    try {
      await client.query('BEGIN');
      await ensureProfile(client, account);
      const profileResult = await client.query(
        `SELECT * FROM user_security_profiles WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [account.tenantId, account.userId]
      );
      const profile = profileResult.rows[0];
      const first = !profile.first_login_at;
      let identity = { changed: false, sameDevice: false, sameNetwork: false, currentNetwork: ipNetwork(ip) };
      if (!first) {
        const recent = await client.query(
          `SELECT ip_address, device_hash FROM user_security_events
           WHERE tenant_id = $1 AND user_id = $2 AND event_type = 'login' AND created_at >= now() - interval '30 minutes'`,
          [account.tenantId, account.userId]
        );
        identity = identityChangeRisk(profile, recent.rows, ip, hash);
        if (identity.changed && input.emailVerified !== true) { changed = true; reason = '检测到新的浏览器设备与新的 IP 网段同时出现'; }
      }
      await client.query(
        `UPDATE user_security_profiles SET first_ip = COALESCE(first_ip, $3), first_device_hash = COALESCE(first_device_hash, NULLIF($4,'')),
         first_login_at = COALESCE(first_login_at, now()), last_ip = $3, last_device_hash = COALESCE(NULLIF($4,''), last_device_hash),
         last_seen_at = now(), updated_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [account.tenantId, account.userId, ip, hash]
      );
      await client.query(
        `INSERT INTO user_security_events (tenant_id,user_id,event_type,ip_address,device_hash,details)
         VALUES ($1,$2,'login',$3,NULLIF($4,''),$5::jsonb)`,
        [account.tenantId, account.userId, ip, hash, JSON.stringify({ network: identity.currentNetwork, first, sameDevice: identity.sameDevice, sameNetwork: identity.sameNetwork, emailVerified: input.emailVerified === true })]
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return changed ? recordRisk(account, 'identity_change', reason, { ip, deviceHash: hash }) : { counted: false };
  }

  function noteRequest(account, input) {
    const key = `${account.tenantId}|${account.userId}`;
    const stamp = now();
    let state = requestWindows.get(key);
    if (!state) {
      if (requestWindows.size >= 50000) requestWindows.delete(requestWindows.keys().next().value);
      state = { short: [], minute: [], updatedAt: stamp };
    }
    state.short = state.short.filter(value => stamp - value < SHORT_WINDOW_MS);
    state.minute = state.minute.filter(value => stamp - value < MINUTE_WINDOW_MS);
    state.short.push(stamp); state.minute.push(stamp); state.updatedAt = stamp; requestWindows.set(key, state);
    if (state.short.length > SHORT_WINDOW_MAX || state.minute.length > MINUTE_WINDOW_MAX) {
      const reason = state.short.length > SHORT_WINDOW_MAX
        ? `10 秒内请求 ${state.short.length} 次，超过正常上限 ${SHORT_WINDOW_MAX} 次`
        : `1 分钟内请求 ${state.minute.length} 次，超过正常上限 ${MINUTE_WINDOW_MAX} 次`;
      recordRisk(account, 'request_rate', reason, {
        ip: normalizeIp(input.ip), deviceHash: deviceHash(input.deviceId),
        details: { shortCount: state.short.length, minuteCount: state.minute.length }
      }).catch(() => {});
    }
  }

  async function list() {
    const result = await pool.query(
      `SELECT usp.tenant_id::text, usp.user_id::text, u.username, tm.display_name, tm.member_type, tm.status,
              COALESCE(up.full_name,'') AS profile_full_name,COALESCE(up.email,'') AS email,
              usp.security_email, usp.first_ip, usp.first_device_hash, usp.first_login_at, usp.last_ip,
              usp.last_device_hash, usp.last_seen_at, usp.risk_count, usp.last_risk_at, usp.block_type,
              usp.block_reason, usp.blocked_at, usp.auto_unfreeze_at, usp.admin_handled,
              COALESCE((SELECT count(*) FROM user_security_events usev WHERE usev.tenant_id=usp.tenant_id AND usev.user_id=usp.user_id),0)::int AS event_count
       FROM user_security_profiles usp JOIN users u ON u.id=usp.user_id
       JOIN tenant_members tm ON tm.tenant_id=usp.tenant_id AND tm.user_id=usp.user_id
       LEFT JOIN user_profiles up ON up.user_id=usp.user_id
       WHERE u.is_system_admin = false ORDER BY usp.last_seen_at DESC NULLS LAST, usp.user_id DESC`
    );
    return result.rows.map(row => ({
      tenantId: row.tenant_id, userId: row.user_id, username: row.username, profileFullName: row.profile_full_name || '', email: row.email || '', displayName: row.display_name || row.username,
      memberType: row.member_type, memberStatus: row.status, securityEmail: row.security_email || '', firstIp: row.first_ip || '',
      firstDevice: maskedDevice(row.first_device_hash), firstLoginAt: row.first_login_at, lastIp: row.last_ip || '',
      lastDevice: maskedDevice(row.last_device_hash), lastSeenAt: row.last_seen_at, riskCount: Number(row.risk_count),
      lastRiskAt: row.last_risk_at, blockType: row.block_type, blockReason: row.block_reason,
      blockedAt: row.blocked_at, autoUnfreezeAt: row.auto_unfreeze_at, adminHandled: row.admin_handled,
      eventCount: Number(row.event_count)
    }));
  }

  async function adminAction(admin, userId, action, input = {}) {
    if (!/^\d+$/.test(String(userId))) throw Object.assign(new Error('未找到该用户，请刷新列表后重试。'), { publicCode: 'invalid_user_id' });
    const requestedTenantId = /^\d+$/.test(String(input.tenantId || '')) ? String(input.tenantId) : null;
    const target = await pool.query(
      `SELECT tm.tenant_id::text, tm.user_id::text, u.username, tm.member_type FROM tenant_members tm JOIN users u ON u.id=tm.user_id
       WHERE tm.user_id=$1 AND u.is_system_admin=false AND ($2::bigint IS NULL OR tm.tenant_id=$2::bigint)
       ORDER BY tm.created_at LIMIT 1`, [userId, requestedTenantId]
    );
    if (!target.rowCount) throw Object.assign(new Error('未找到该用户，请核对账号后重试。'), { publicCode: 'user_not_found' });
    const account = { tenantId: target.rows[0].tenant_id, userId: target.rows[0].user_id, username: target.rows[0].username, memberType: target.rows[0].member_type, permissions: [] };
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await ensureProfile(client, account);
      if (action === 'set_email') {
        const email = validEmail(input.email);
        if (!email && String(input.email || '').trim()) throw Object.assign(new Error('邮箱格式不正确，请填写完整的邮箱地址（例如 name@example.com）。'), { publicCode: 'invalid_email' });
        await client.query(`UPDATE user_security_profiles SET security_email=$3, admin_handled=true, updated_at=now() WHERE tenant_id=$1 AND user_id=$2`, [account.tenantId, account.userId, email || null]);
      } else if (action === 'freeze' || action === 'ban') {
        const blockType = action === 'ban' ? 'banned' : 'manual_frozen';
        await client.query(`UPDATE tenant_members SET status='disabled', updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND status<>'removed'`, [account.tenantId, account.userId]);
        await client.query(`UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()), revoke_reason=$3 WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL`, [account.tenantId, account.userId, `security_${blockType}`]);
        await client.query(`UPDATE user_security_profiles SET block_type=$3, block_reason=$4, blocked_at=now(), auto_unfreeze_at=NULL,
          blocked_member_ids=$5::jsonb, admin_handled=true, updated_at=now() WHERE tenant_id=$1 AND user_id=$2`,
          [account.tenantId, account.userId, blockType, action === 'ban' ? '系统管理员手动封号' : '系统管理员手动冻结', JSON.stringify([account.userId])]);
      } else if (action === 'unfreeze' || action === 'unban') {
        const current = await client.query(`SELECT block_type,blocked_member_ids FROM user_security_profiles WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`, [account.tenantId, account.userId]);
        const savedIds = current.rows[0] && current.rows[0].block_type === 'auto_frozen' && Array.isArray(current.rows[0].blocked_member_ids)
          ? current.rows[0].blocked_member_ids.filter(id => /^\d+$/.test(String(id))) : [account.userId];
        await client.query(`UPDATE tenant_members SET status='active', updated_at=now() WHERE tenant_id=$1 AND user_id=ANY($2::bigint[]) AND status='disabled'`, [account.tenantId, savedIds]);
        await client.query(`UPDATE user_security_profiles SET block_type='none', block_reason='', risk_count=0, auto_unfreeze_at=NULL,
          blocked_member_ids='[]'::jsonb, admin_handled=true, updated_at=now() WHERE tenant_id=$1 AND user_id=$2`, [account.tenantId, account.userId]);
      } else throw Object.assign(new Error('请选择正确的操作后再提交。'), { publicCode: 'invalid_action' });
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    await taskStore.recordAudit({ ...admin, tenantId: account.tenantId }, `user.security.${action}`, 'user', account.userId, 'success', {}).catch(() => {});
    return { ok: true };
  }

  async function unfreezeAfterEmailVerification(account) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await ensureProfile(client, account);
      const current = await client.query(
        `SELECT block_type,blocked_member_ids FROM user_security_profiles
          WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE`,
        [account.tenantId, account.userId]
      );
      if (!current.rowCount || current.rows[0].block_type !== 'auto_frozen') {
        await client.query('COMMIT');
        return { changed: false };
      }
      const ids = Array.isArray(current.rows[0].blocked_member_ids)
        ? current.rows[0].blocked_member_ids.filter(id => /^\d+$/.test(String(id)))
        : [account.userId];
      if (ids.length) {
        await client.query(
          `UPDATE tenant_members SET status='active',updated_at=now()
            WHERE tenant_id=$1 AND user_id=ANY($2::bigint[]) AND status='disabled'`,
          [account.tenantId, ids]
        );
      }
      await client.query(
        `UPDATE user_security_profiles
            SET block_type='none',block_reason='',risk_count=0,auto_unfreeze_at=NULL,
                blocked_member_ids='[]'::jsonb,admin_handled=false,updated_at=now()
          WHERE tenant_id=$1 AND user_id=$2 AND block_type='auto_frozen'`,
        [account.tenantId, account.userId]
      );
      await client.query('COMMIT');
      await taskStore.recordAudit(account, 'user.security.email_unfreeze', 'user', account.userId, 'success', {}).catch(() => {});
      await writeTask(account, 0, '', 'done').catch(() => {});
      return { changed: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function autoUnfreeze() {
    const due = await pool.query(
      `SELECT tenant_id::text,user_id::text,blocked_member_ids FROM user_security_profiles
       WHERE block_type='auto_frozen' AND admin_handled=false AND auto_unfreeze_at<=now()`
    );
    for (const row of due.rows) {
      const ids = Array.isArray(row.blocked_member_ids) ? row.blocked_member_ids.filter(id => /^\d+$/.test(String(id))) : [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (ids.length) await client.query(`UPDATE tenant_members SET status='active',updated_at=now() WHERE tenant_id=$1 AND user_id=ANY($2::bigint[]) AND status='disabled'`, [row.tenant_id, ids]);
        await client.query(`UPDATE user_security_profiles SET block_type='none',block_reason='',risk_count=0,auto_unfreeze_at=NULL,
          blocked_member_ids='[]'::jsonb,updated_at=now() WHERE tenant_id=$1 AND user_id=$2 AND block_type='auto_frozen' AND admin_handled=false`, [row.tenant_id, row.user_id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); }
      finally { client.release(); }
      const account = await affectedAccount(row.tenant_id, row.user_id);
      if (account) await writeTask(account, 0, '', 'done').catch(() => {});
    }
    return due.rowCount;
  }

  function cleanup() {
    const stamp = now();
    for (const [key, value] of requestWindows.entries()) if (!value || stamp - value.updatedAt > 2 * MINUTE_WINDOW_MS) requestWindows.delete(key);
    for (const [key, value] of riskCooldowns.entries()) if (!value || stamp - value > 2 * RISK_COOLDOWN_MS) riskCooldowns.delete(key);
  }

  return { deviceHash, noteLogin, noteRequest, recordRisk, list, adminAction, unfreezeAfterEmailVerification, autoUnfreeze, cleanup };
}

module.exports = { createUserSecurityMonitor, validEmail, normalizeIp, ipNetwork, identityChangeRisk, shouldSendRiskMail, riskTaskStatus, riskCountsTowardFreeze, constants: {
  CHANGE_WINDOW_MS, RISK_COOLDOWN_MS, AUTO_UNFREEZE_MS, SHORT_WINDOW_MS, SHORT_WINDOW_MAX, MINUTE_WINDOW_MS, MINUTE_WINDOW_MAX, MAX_RISKS, RISK_CHAIN_RESET_MS
} };
