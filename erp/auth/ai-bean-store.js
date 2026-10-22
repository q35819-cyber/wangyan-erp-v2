'use strict';

// AI 豆租户钱包：整数豆记账（禁止浮点），事务 + 行锁 + 幂等键。
// 定价规则（2026-09-17 用户确认）：
//   1 元 = 100 豆；收费业务实时价格统一读取 ai_pricing_config；IMAGE_COST_BEAN=10 仅保留为旧任务/测试兼容兜底。AI 普通文字翻译免费。
//   新租户注册赠送 100 豆；第一期充值由系统管理员人工操作。
const WELCOME_GIFT_BEAN = 100;
const IMAGE_COST_BEAN = 10;
const CNY_TO_BEAN = 100;
const MAX_AMOUNT_BEAN = 100000000;

const CREDIT_TYPES = Object.freeze(['welcome_gift', 'recharge', 'refund', 'agent_reward', 'membership_reward', 'referral_signup_reward', 'referral_paid_reward']);
const MUTATE_TYPES = Object.freeze(['freeze', 'consume', 'release', 'welcome_gift', 'recharge', 'refund', 'admin_adjust', 'agent_reward', 'agent_reward_reversal', 'membership_reward', 'referral_signup_reward', 'referral_paid_reward', 'referral_reward_reversal']);
const KEY_RE = /^[A-Za-z0-9._:-]{4,160}$/;

function beanError(code, textOrStatus = 400, status = 400) {
  const text = typeof textOrStatus === 'string' ? textOrStatus : code;
  return Object.assign(new Error(text), { publicCode: code, status: typeof textOrStatus === 'number' ? textOrStatus : status });
}
function positiveInteger(value, field) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_AMOUNT_BEAN) throw beanError('invalid_ai_bean_' + field, 'AI豆数量必须是1到100000000之间的整数，请修改后再提交。', 400);
  return n;
}
function tenantKey(value) {
  const s = String(value == null ? '' : value);
  if (!/^\d+$/.test(s)) throw beanError('invalid_tenant_id', '客户空间编号无效，请重新登录后再试。', 400);
  return s;
}
function cleanText(value, max, field) {
  const s = String(value == null ? '' : value).trim();
  if (s.length > max) throw beanError('invalid_ai_bean_' + field, '该字段内容超过允许长度，请缩短后再提交。', 400);
  return s;
}
function normalizeOrderRef(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return raw
    .replace(/^(?:freeze|settle|release|consume):/i, '')
    .replace(/:(?:freeze|settle|release|consume)$/i, '') || raw;
}
function orderNoFromRow(row) {
  const businessRef = String(row && row.business_ref || '').trim();
  const key = String(row && row.idempotency_key || '').trim();
  if (businessRef && !['admin-recharge','admin-adjust'].includes(businessRef)) return businessRef;
  if (businessRef) return businessRef + ':' + key;
  return normalizeOrderRef(key) || ('ai-event:' + String(row && row.id || ''));
}
function actorLabel(row) {
  const actorUserId = row && row.actor_user_id == null ? '' : String(row.actor_user_id);
  if (!actorUserId) return '历史未记录';
  const username = String(row && row.actor_username || '').trim();
  if (row && row.actor_is_system_admin === true || username.toLowerCase() === 'admin') return '系统管理员';
  const profileFullName = String(row && row.actor_profile_full_name || '').trim();
  const email = String(row && row.actor_email || '').trim();
  return profileFullName || email || '历史未记录';
}

function mapEvent(row) {
  const amount = Number(row.amount_bean);
  const balanceAfter = Number(row.balance_after);
  const frozenAfter = Number(row.frozen_after);
  let balanceBefore = balanceAfter;
  let frozenBefore = frozenAfter;
  if (row.event_type === 'freeze') { balanceBefore += amount; frozenBefore -= amount; }
  else if (row.event_type === 'consume') frozenBefore += amount;
  else if (row.event_type === 'release') { balanceBefore -= amount; frozenBefore += amount; }
  else if (row.direction === 'credit') balanceBefore -= amount;
  else if (row.direction === 'debit') balanceBefore += amount;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    eventType: row.event_type,
    direction: row.direction,
    amountBean: amount,
    balanceBefore,
    frozenBefore,
    balanceAfter,
    frozenAfter,
    idempotencyKey: row.idempotency_key,
    businessRef: row.business_ref || '',
    orderNo: orderNoFromRow(row),
    reason: row.reason || '',
    actorUserId: row.actor_user_id == null ? null : String(row.actor_user_id),
    actorUsername: row.actor_username || '',
    actorDisplayName: row.actor_display_name || '',
    actorProfileFullName: String(row.actor_profile_full_name || ''),
    actorEmail: String(row.actor_email || ''),
    actorIsSystemAdmin: row.actor_is_system_admin === true,
    actorLabel: actorLabel(row),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

async function mutateOn(client, tenantIdRaw, options) {
    const tenantId = tenantKey(tenantIdRaw);
    const amount = positiveInteger(options.amount, 'amount');
    const key = String(options.idempotencyKey || '');
    if (!KEY_RE.test(key)) throw beanError('idempotency_key_required', '本次操作缺少防重复提交编号，请刷新页面后重新操作一次。', 400);
    if (!MUTATE_TYPES.includes(options.eventType)) {
      throw beanError('invalid_ai_bean_event_type', 'AI豆流水类型不合法，请联系系统管理员核对该功能的计费配置。', 400);
    }
    if (!['credit', 'debit'].includes(options.direction)) throw beanError('invalid_ai_bean_direction', 'AI豆收支方向不合法，请联系系统管理员核对该功能的计费配置。', 400);
    const requestedBusinessRef = cleanText(options.businessRef, 160, 'business_ref');
    const businessRef = requestedBusinessRef || cleanText(normalizeOrderRef(key), 160, 'business_ref');
    const reason = cleanText(options.reason, 500, 'reason');
    const actorUserId = options.actorUserId == null || options.actorUserId === '' ? null : Number(options.actorUserId);
    if (actorUserId != null && !Number.isSafeInteger(actorUserId)) throw beanError('invalid_ai_bean_actor', '操作者编号无效，请重新登录后再试。', 400);

    const duplicate = await client.query(
      'SELECT * FROM ai_bean_events WHERE tenant_id=$1 AND idempotency_key=$2',
      [tenantId, key]
    );
    if (duplicate.rowCount) return { replayed: true, event: mapEvent(duplicate.rows[0]) };
    await client.query('INSERT INTO ai_bean_accounts(tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    const locked = await client.query(
      'SELECT balance_bean,frozen_bean FROM ai_bean_accounts WHERE tenant_id=$1 FOR UPDATE',
      [tenantId]
    );
    const current = { balance: Number(locked.rows[0].balance_bean), frozen: Number(locked.rows[0].frozen_bean) };
    let next;
    try { next = options.apply(current); }
    catch (error) {
      error.beanWallet = { balanceBefore: current.balance, frozenBefore: current.frozen, balanceAfter: current.balance, frozenAfter: current.frozen };
      throw error;
    }
    if (!Number.isSafeInteger(next.balance) || !Number.isSafeInteger(next.frozen) || next.balance < 0 || next.frozen < 0) {
      throw beanError('ai_bean_balance_invalid', 'AI豆余额数据异常，服务端已拒绝本次操作，请联系系统管理员核查账户。', 409);
    }
    await client.query(
      'UPDATE ai_bean_accounts SET balance_bean=$2,frozen_bean=$3,updated_at=now() WHERE tenant_id=$1',
      [tenantId, next.balance, next.frozen]
    );
    const inserted = await client.query(
      `INSERT INTO ai_bean_events
         (tenant_id,event_type,direction,amount_bean,balance_after,frozen_after,idempotency_key,business_ref,reason,actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [tenantId, options.eventType, options.direction, amount, next.balance, next.frozen, key, businessRef, reason, actorUserId]
    );
    return { replayed: false, event: mapEvent(inserted.rows[0]), balanceBean: next.balance, frozenBean: next.frozen };
}

// 供会员审核事务使用；调用方负责 BEGIN/COMMIT 和失败阶段审计。
async function creditMembershipOn(client, tenantIdRaw, options) {
  const amount = positiveInteger(options.amount, 'amount');
  const businessRef = cleanText(options.businessRef, 160, 'business_ref');
  const actorUserId = Number(options.actorUserId);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw beanError('invalid_ai_bean_actor', '操作者编号无效，请重新登录后再试。', 400);
  }
  const result = await mutateOn(client, tenantIdRaw, {
    ...options,
    amount,
    businessRef,
    actorUserId,
    eventType: 'membership_reward',
    direction: 'credit',
    apply: current => ({ balance: current.balance + amount, frozen: current.frozen })
  });
  if (result.replayed && (
    result.event.eventType !== 'membership_reward'
    || result.event.amountBean !== amount
    || result.event.businessRef !== businessRef
  )) {
    throw beanError('idempotency_key_conflict', '本次会员赠豆编号已被其他操作占用，请联系系统管理员核查。', 409);
  }
  return result;
}

function createAiBeanStore(pool) {
  async function balanceOn(client, tenantId) {
    const result = await client.query('SELECT balance_bean,frozen_bean FROM ai_bean_accounts WHERE tenant_id=$1', [tenantKey(tenantId)]);
    if (!result.rowCount) return { balanceBean: 0, frozenBean: 0, exists: false };
    return { balanceBean: Number(result.rows[0].balance_bean), frozenBean: Number(result.rows[0].frozen_bean), exists: true };
  }
  async function balance(tenantId) {
    return balanceOn(pool, tenantId);
  }

  // 独立记账事务（原有对外行为）：幂等键并发抢跑时转为重放返回，不重复记账。
  async function mutate(tenantIdRaw, options) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await mutateOn(client, tenantIdRaw, options);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error && error.code === '23505') {
        const again = await pool.query('SELECT * FROM ai_bean_events WHERE tenant_id=$1 AND idempotency_key=$2', [tenantKey(tenantIdRaw), String(options.idempotencyKey || '')]);
        if (again.rowCount) return { replayed: true, event: mapEvent(again.rows[0]) };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // 提交 AI 图片任务前冻结：余额 → 冻结
  async function freeze(tenantId, params) {
    return mutate(tenantId, {
      ...params, eventType: 'freeze', direction: 'debit',
      apply: current => {
        if (current.balance < positiveInteger(params.amount, 'amount')) throw beanError('insufficient_ai_beans', 'AI豆余额不足，请先充值后再使用该功能。', 402);
        return { balance: current.balance - Number(params.amount), frozen: current.frozen + Number(params.amount) };
      }
    });
  }
  async function freezeOn(client, tenantId, params) {
    return mutateOn(client, tenantId, {
      ...params, eventType: 'freeze', direction: 'debit',
      apply: current => {
        if (current.balance < positiveInteger(params.amount, 'amount')) throw beanError('insufficient_ai_beans', 'AI豆余额不足，请先充值后再使用该功能。', 402);
        return { balance: current.balance - Number(params.amount), frozen: current.frozen + Number(params.amount) };
      }
    });
  }
  async function freezeOn(client, tenantId, params) {
    return mutateOn(client, tenantId, {
      ...params, eventType: 'freeze', direction: 'debit',
      apply: current => {
        if (current.balance < positiveInteger(params.amount, 'amount')) throw beanError('insufficient_ai_beans', 'AI豆余额不足，请先充值后再使用该功能。', 402);
        return { balance: current.balance - Number(params.amount), frozen: current.frozen + Number(params.amount) };
      }
    });
  }
  // 出图成功结算：冻结扣减（钱真正花掉）
  async function settle(tenantId, params) {
    return mutate(tenantId, {
      ...params, eventType: 'consume', direction: 'debit',
      apply: current => {
        const amount = positiveInteger(params.amount, 'amount');
        if (current.frozen < amount) throw beanError('ai_beans_frozen_inconsistent', '冻结中的AI豆与余额记录不一致，请联系系统管理员核查后再试。', 409);
        return { balance: current.balance, frozen: current.frozen - amount };
      }
    });
  }
  // 失败/放弃：冻结退回余额
  async function release(tenantId, params) {
    return mutate(tenantId, {
      ...params, eventType: 'release', direction: 'credit',
      apply: current => {
        const amount = positiveInteger(params.amount, 'amount');
        if (current.frozen < amount) throw beanError('ai_beans_frozen_inconsistent', '冻结中的AI豆与余额记录不一致，请联系系统管理员核查后再试。', 409);
        return { balance: current.balance + amount, frozen: current.frozen - amount };
      }
    });
  }
  // 充值/补偿/赠送入余额
  async function credit(tenantId, params) {
    if (!CREDIT_TYPES.includes(params.eventType)) throw beanError('invalid_ai_bean_event_type', 'AI豆流水类型不合法，请联系系统管理员核对该功能的计费配置。', 400);
    const amount = positiveInteger(params.amount, 'amount');
    return mutate(tenantId, { ...params, eventType: params.eventType, direction: 'credit', apply: current => ({ balance: current.balance + amount, frozen: current.frozen }) });
  }
  // 管理员人工调账：delta 为正=补豆，为负=扣豆
  async function adminAdjust(tenantId, params) {
    const delta = Number(params.deltaBean);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > MAX_AMOUNT_BEAN) throw beanError('invalid_ai_bean_delta', '调整数量必须是非零且不超过100000000的整数，请修改后再提交。', 400);
    return mutate(tenantId, {
      ...params, amount: Math.abs(delta), eventType: 'admin_adjust', direction: delta > 0 ? 'credit' : 'debit',
      apply: current => {
        if (delta < 0 && current.balance < Math.abs(delta)) throw beanError('admin_adjust_below_zero', '扣减数量超过当前余额，账户余额不能为负，请减小调整数量后再提交。', 409);
        return { balance: current.balance + delta, frozen: current.frozen };
      }
    });
  }

  async function listEvents(tenantId, options = {}) {
    const id = tenantKey(tenantId);
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const beforeId = Number(options.beforeId);
    const eventType = String(options.eventType || '').trim();
    if (eventType && !MUTATE_TYPES.includes(eventType)) throw beanError('invalid_ai_bean_event_type', '请选择有效的AI豆流水类型后再筛选。', 400);
    const values = [id];
    let where = 'WHERE ai_bean_events.tenant_id=$1';
    if (Number.isSafeInteger(beforeId) && beforeId > 0) { values.push(beforeId); where += ' AND ai_bean_events.id < $' + values.length; }
    if (eventType) { values.push(eventType); where += ' AND ai_bean_events.event_type=$' + values.length; }
    if (options.hideSettledFreeze === true) {
      where += ` AND NOT (
        ai_bean_events.event_type='freeze'
        AND EXISTS (
          SELECT 1 FROM ai_bean_events settled
          WHERE settled.tenant_id=ai_bean_events.tenant_id
            AND settled.business_ref=ai_bean_events.business_ref
            AND settled.event_type IN ('consume','release')
            AND settled.id>ai_bean_events.id
        )
      )`;
    }
    const sql = 'SELECT ai_bean_events.*,u.username AS actor_username,u.is_system_admin AS actor_is_system_admin,tm.display_name AS actor_display_name,' +
      "COALESCE(up.full_name,'') AS actor_profile_full_name,CASE WHEN up.email_verified_at IS NOT NULL THEN COALESCE(up.email,'') ELSE '' END AS actor_email " +
      'FROM ai_bean_events ' +
      'LEFT JOIN users u ON u.id=ai_bean_events.actor_user_id ' +
      'LEFT JOIN tenant_members tm ON tm.tenant_id=ai_bean_events.tenant_id AND tm.user_id=ai_bean_events.actor_user_id ' +
      'LEFT JOIN user_profiles up ON up.user_id=ai_bean_events.actor_user_id ' +
      where + ' ORDER BY ai_bean_events.id DESC LIMIT ' + String(limit + 1);
    const result = await pool.query(sql, values);
    const rows = result.rows;
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(mapEvent), hasMore };
  }

  async function adminAccounts() {
    const result = await pool.query(`SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.status AS tenant_status,
      COALESCE(a.balance_bean,0) AS balance_bean, COALESCE(a.frozen_bean,0) AS frozen_bean, a.updated_at,
      (SELECT u.username FROM tenant_members m JOIN users u ON u.id=m.user_id
       WHERE m.tenant_id=t.id AND m.member_type='owner' AND m.status='active' ORDER BY m.joined_at,m.user_id LIMIT 1) AS owner_username
      FROM tenants t LEFT JOIN ai_bean_accounts a ON a.tenant_id=t.id ORDER BY t.id DESC`);
    return { items: result.rows.map(row => ({ tenantId: String(row.tenant_id), tenantName: row.tenant_name,
      tenantStatus: row.tenant_status, ownerUsername: row.owner_username || '',
      balanceBean: Number(row.balance_bean), frozenBean: Number(row.frozen_bean),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at })) };
  }

  async function adminAccount(tenantId) {
    const result = await pool.query(
      `SELECT t.id::text AS tenant_id,t.name AS tenant_name,t.status AS tenant_status,
              COALESCE(a.balance_bean,0) AS balance_bean,COALESCE(a.frozen_bean,0) AS frozen_bean,a.updated_at
       FROM tenants t LEFT JOIN ai_bean_accounts a ON a.tenant_id=t.id
       WHERE t.id=$1`,
      [tenantKey(tenantId)]
    );
    if (!result.rowCount) throw beanError('tenant_not_found', '未找到对应的客户空间，请刷新后重新选择客户。', 404);
    const row = result.rows[0];
    return {
      tenantId: String(row.tenant_id), tenantName: row.tenant_name, tenantStatus: row.tenant_status,
      balanceBean: Number(row.balance_bean), frozenBean: Number(row.frozen_bean),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
    };
  }

  return { balance, balanceOn, freeze, freezeOn, settle, release, credit, adminAdjust, listEvents, adminAccount, adminAccounts, mutateOn };
}

// 代理商AI豆码奖励（2026-09-22 用户最新裁决）：按购买豆数的30%奖励，只记整数豆。
// 例如：1000豆 -> 300豆；若未来开放非整百额度，也统一向下取整，禁止产生小数豆。
function agentRewardBean(amountBean) {
  const amount = Number(amountBean);
  if (!Number.isSafeInteger(amount) || amount <= 0) return 0;
  return Math.floor(amount * 30 / 100);
}

const MAX_BEAN_CODE_AMOUNT = 1000000;

module.exports = {
  createAiBeanStore,
  mutateOn,
  creditMembershipOn,
  WELCOME_GIFT_BEAN,
  IMAGE_COST_BEAN,
  CNY_TO_BEAN,
  MAX_BEAN_CODE_AMOUNT,
  agentRewardBean,
  welcomeGiftIdempotencyKey: tenantId => `welcome-gift:v1:${tenantId}`
};
