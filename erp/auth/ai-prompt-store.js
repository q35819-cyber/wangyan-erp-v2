'use strict';

const prompts = require('./ai-prompts');
// 系统级官方图片提示词按这六类入库维护；可读开关只对这六类有界面入口。
const IMAGE_CATEGORY_KEYS = Object.freeze(['image-main', 'image-scene', 'image-selling', 'image-accessory', 'image-white-base', 'image-size']);
function error(code, text, status = 400) { return Object.assign(new Error(text || '服务端未给出中文提示，请按页面提示重试；仍未成功请联系管理员。'), { publicCode: code, status }); }
function promptConfigured(body) { return Boolean(String(body || '').trim()) && !/待系统管理员或租户填写/.test(String(body || '')); }
// 生效模板解析：已显式选用的自定义模板优先；否则管理员保存的已启用自定义模板中最新一条自动作为本租户默认（等同官方模板）；都没有才回退官方。
function resolveEffective(custom, functionKey) {
  const enabled = custom.filter(item => item.functionKey === functionKey && item.enabled);
  const selected = enabled.find(item => item.selected);
  if (selected) return { source: 'custom', promptId: selected.id, auto: false };
  const latest = enabled.reduce((best, item) => (!best || new Date(item.updatedAt) >= new Date(best.updatedAt) ? item : best), null);
  if (latest) return { source: 'custom', promptId: latest.id, auto: true };
  return { source: 'official', promptId: null, auto: false };
}
// 官方模板视图：ai_official_prompts 中该类别最新一条启用记录覆盖代码常量；没有入库记录时用常量兜底。
async function loadOfficial(client) {
  const result = await client.query('SELECT * FROM ai_official_prompts WHERE enabled ORDER BY updated_at DESC, official_key');
  const latestByFunction = new Map();
  for (const row of result.rows) {
    if (!latestByFunction.has(row.function_key)) latestByFunction.set(row.function_key, row);
  }
  return prompts.OFFICIAL.map(function (base) {
    const dbRow = latestByFunction.get(base.functionKey);
    return {
      key: dbRow ? dbRow.official_key : base.key,
      version: dbRow ? Number(dbRow.version) : base.version,
      name: dbRow ? dbRow.name : base.name,
      functionKey: base.functionKey,
      body: dbRow ? dbRow.body : base.body,
      configured: promptConfigured(dbRow ? dbRow.body : base.body),
      readable: dbRow ? Boolean(dbRow.tenant_readable) : true,
      systemManaged: Boolean(dbRow)
    };
  });
}
function maskOfficial(rows, isSystemAdmin) {
  return rows.map(function (row) {
    if (isSystemAdmin || row.readable) return row;
    return Object.assign({}, row, { name: '官方模板', body: '', masked: true });
  });
}
function createAiPromptStore(pool, writeAudit) {
  async function context(account, client = pool) {
    const result = await client.query("SELECT user_id::text FROM tenant_members WHERE tenant_id=$1 AND member_type='owner' AND status='active' ORDER BY joined_at,user_id LIMIT 1", [account.tenantId]);
    if (!result.rowCount) throw error('ai_owner_not_found', '未找到该账号的主账号信息，请重新登录后再试。', 409);
    const ownerUserId = result.rows[0].user_id;
    return { ownerUserId, isOwner: account.memberType === 'owner' && String(account.userId) === ownerUserId };
  }
  async function list(account) {
    const ctx = await context(account);
    const result = await pool.query(`SELECT p.*,s.function_key AS selected_function FROM ai_prompt_templates p LEFT JOIN ai_prompt_selections s ON s.tenant_id=p.tenant_id AND s.prompt_id=p.id WHERE p.tenant_id=$1 ORDER BY p.created_at,p.id`, [account.tenantId]);
    const custom = result.rows.map(row => ({ id: row.id, name: row.name, functionKey: row.function_key, body: row.body, enabled: row.enabled, officialKey: row.official_key, officialVersion: row.official_version, selected: Boolean(row.selected_function), updatedAt: row.updated_at }));
    const official = await loadOfficial(pool);
    return { owner: ctx.isOwner, systemAdmin: Boolean(account.isSystemAdmin), official: maskOfficial(official, Boolean(account.isSystemAdmin)), custom, variables: prompts.VARIABLES, effective: prompts.FUNCTIONS.map(functionKey => Object.assign({ functionKey }, resolveEffective(custom, functionKey))) };
  }
  async function getOwner(account, id, client = pool) {
    const ctx = await context(account, client); if (!ctx.isOwner) throw error('ai_prompt_owner_required', '只有主账号可以管理提示词，请改用主账号操作。', 403);
    const result = await client.query('SELECT * FROM ai_prompt_templates WHERE id=$1 AND tenant_id=$2', [id, account.tenantId]);
    if (!result.rowCount) throw error('ai_prompt_not_found', '未找到该提示词，请刷新列表后重新选择。', 404); return result.rows[0];
  }
  async function save(account, input) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); const ctx = await context(account, client); if (!ctx.isOwner) throw error('ai_prompt_owner_required', '只有主账号可以管理提示词，请改用主账号操作。', 403);
      const existing = input.id ? await getOwner(account, input.id, client) : null; const value = prompts.normalize(input, existing);
      const result = await client.query(`INSERT INTO ai_prompt_templates(id,tenant_id,owner_user_id,name,function_key,body,enabled,official_key,official_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,function_key=EXCLUDED.function_key,body=EXCLUDED.body,enabled=EXCLUDED.enabled,updated_at=now() WHERE ai_prompt_templates.tenant_id=$2 RETURNING *`, [value.id, account.tenantId, ctx.ownerUserId, value.name, value.functionKey, value.body, value.enabled, value.officialKey, value.officialVersion]);
      if (!result.rowCount) throw error('ai_prompt_not_found', '未找到该提示词，请刷新列表后重新选择。', 404);
      if (!value.enabled) await client.query('DELETE FROM ai_prompt_selections WHERE tenant_id=$1 AND prompt_id=$2', [account.tenantId, value.id]);
      await writeAudit(client, account, 'ai.prompt.save', 'ai_prompt', value.id, 'success', { functionKey: value.functionKey, enabled: value.enabled }); await client.query('COMMIT'); return result.rows[0];
    } catch (cause) { await client.query('ROLLBACK'); if (cause?.code === '23505') throw error('ai_prompt_name_duplicate', '已经存在同名提示词，请换一个名称后再保存。', 409); throw cause; } finally { client.release(); }
  }
  async function remove(account, id) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await getOwner(account, id, client); const used = await client.query('SELECT 1 FROM ai_prompt_selections WHERE tenant_id=$1 AND prompt_id=$2', [account.tenantId, id]); if (used.rowCount) throw error('ai_prompt_in_use', '该提示词正在被功能使用，请先改用其他提示词后再删除。', 409); await client.query('DELETE FROM ai_prompt_templates WHERE id=$1 AND tenant_id=$2', [id, account.tenantId]); await writeAudit(client, account, 'ai.prompt.delete', 'ai_prompt', id, 'success', {}); await client.query('COMMIT'); }
    catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function select(account, functionKey, promptId) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const ctx = await context(account, client); if (!ctx.isOwner) throw error('ai_prompt_owner_required', '只有主账号可以管理提示词，请改用主账号操作。', 403); if (!prompts.FUNCTIONS.includes(functionKey)) throw error('ai_prompt_function_invalid', '该功能编号不受支持，请刷新页面后重新选择功能。');
      if (!promptId) await client.query('DELETE FROM ai_prompt_selections WHERE tenant_id=$1 AND function_key=$2', [account.tenantId, functionKey]);
      else { const row = await client.query('SELECT 1 FROM ai_prompt_templates WHERE id=$1 AND tenant_id=$2 AND function_key=$3 AND enabled', [promptId, account.tenantId, functionKey]); if (!row.rowCount) throw error('ai_prompt_unavailable', '该提示词已停用或不可用，请另选一个提示词后再提交。', 409); await client.query(`INSERT INTO ai_prompt_selections(tenant_id,function_key,prompt_id,updated_by_user_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,function_key) DO UPDATE SET prompt_id=EXCLUDED.prompt_id,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`, [account.tenantId, functionKey, promptId, account.userId]); }
      await writeAudit(client, account, 'ai.prompt.select', 'ai_prompt', promptId || functionKey, 'success', { functionKey, source: promptId ? 'custom' : 'official' }); await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function effective(account, functionKey, options = {}) {
    if (options && options.officialOnly === true) {
      const officialOnly = await loadOfficial(pool);
      return officialOnly.find(item => item.functionKey === functionKey)?.body || '';
    }
    const data = await list(account);
    const eff = data.effective.find(row => row.functionKey === functionKey);
    if (eff && eff.promptId) {
      const chosen = data.custom.find(item => item.id === eff.promptId && item.enabled !== false);
      if (chosen) return chosen.body;
    }
    // 不走遮罩后的 list：可读开关只影响界面展示，服务端业务流程仍取真实官方正文。
    const official = await loadOfficial(pool);
    return official.find(item => item.functionKey === functionKey)?.body || '';
  }
  async function saveOfficial(account, officialKey, input) {
    if (!account.isSystemAdmin) throw error('system_admin_required', '只有系统管理员可以维护官方提示词，请改用系统管理员账号操作。', 403);
    const key = String(officialKey || '');
    if (!/^[a-z0-9-]{3,64}$/.test(key)) throw error('ai_official_prompt_not_found', '未找到对应的官方提示词，请刷新列表后重试。', 404);
    const name = String(input && input.name || '').trim();
    if (!name || name.length > 120) throw error('ai_official_prompt_name_invalid', '官方提示词名称不能为空，且长度不能超过120字。');
    const body = prompts.validateBody(input && input.body);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM ai_official_prompts WHERE official_key=$1', [key]);
      let row;
      if (existing.rowCount) {
        const updated = await client.query('UPDATE ai_official_prompts SET name=$2, body=$3, version=version+1, updated_by_user_id=$4, updated_at=now() WHERE official_key=$1 RETURNING *', [key, name, body, account.userId]);
        row = updated.rows[0];
      } else {
        const base = prompts.OFFICIAL.find(item => item.key === key && IMAGE_CATEGORY_KEYS.includes(item.functionKey));
        if (!base) throw error('ai_official_prompt_not_found', '未找到对应的官方提示词，请刷新列表后重试。', 404);
        const inserted = await client.query(`INSERT INTO ai_official_prompts(official_key,function_key,name,body,tenant_readable,created_by_user_id,updated_by_user_id) VALUES($1,$2,$3,$4,true,$5,$5) RETURNING *`, [key, base.functionKey, name, body, account.userId]);
        row = inserted.rows[0];
      }
      await writeAudit(client, account, 'ai.official.save', 'ai_official_prompt', key, 'success', { functionKey: row.function_key, version: Number(row.version) });
      await client.query('COMMIT');
      return { key: row.official_key, functionKey: row.function_key, name: row.name, body: row.body, version: Number(row.version), readable: Boolean(row.tenant_readable) };
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
  }
  // 系统管理员设置某条官方模板是否对所有租户可读；常量类别首次设置时按常量内容补建行。
  async function setOfficialReadable(account, officialKey, readable) {
    if (!account.isSystemAdmin) throw error('system_admin_required', '只有系统管理员可以维护官方提示词，请改用管理员账号操作。', 403);
    if (typeof readable !== 'boolean') throw error('ai_official_readable_invalid', '可见性开关取值不正确，请重新选择后再保存。');
    const key = String(officialKey || '');
    if (!/^[a-z0-9-]{3,64}$/.test(key)) throw error('ai_official_prompt_not_found', '未找到对应的官方提示词，请刷新列表后重试。', 404);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM ai_official_prompts WHERE official_key=$1', [key]);
      let row;
      if (existing.rowCount) {
        const updated = await client.query('UPDATE ai_official_prompts SET tenant_readable=$2, updated_by_user_id=$3, updated_at=now() WHERE official_key=$1 RETURNING *', [key, readable, account.userId]);
        row = updated.rows[0];
      } else {
        const base = prompts.OFFICIAL.find(item => item.key === key && IMAGE_CATEGORY_KEYS.includes(item.functionKey));
        if (!base) throw error('ai_official_prompt_not_found', '未找到对应的官方提示词，请刷新列表后重试。', 404);
        const inserted = await client.query(`INSERT INTO ai_official_prompts(official_key,function_key,name,body,tenant_readable,created_by_user_id,updated_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [key, base.functionKey, base.name, prompts.validateBody(base.body), readable, account.userId]);
        row = inserted.rows[0];
      }
      await writeAudit(client, account, 'ai.official.readable', 'ai_official_prompt', key, 'success', { functionKey: row.function_key, readable });
      await client.query('COMMIT');
      return { key, functionKey: row.function_key, readable: row.tenant_readable };
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
  }
  return { list, getOwner, save, remove, select, effective, saveOfficial, setOfficialReadable };
}
module.exports = { createAiPromptStore };
