'use strict';

const AI_CAPABILITIES = Object.freeze(['product-translation', 'title-optimization', 'description-optimization', 'selling-point-generation', 'attribute-text-optimization', 'image-translation', 'image-redraw', 'image-repair']);
// 用户界面偏好白名单（非权限、非资金结论；真正可用性仍以提交时校验为准）。
const UI_PREFERENCE_VALIDATORS = Object.freeze({
  'billing-channel': value => value === 'official' || value === 'own'
});

function error(code, text, status = 400) { return Object.assign(new Error(text), { publicCode: code, status }); }
function hasEncryptedApiKey(value) {
  if (!value) return false;
  return typeof value === 'object' ? Boolean(String(value.ciphertext || '').trim()) : Boolean(String(value).trim());
}
function canUseAiConfiguration(row, requiredCapabilities, { isOwner = false, allowCustom = false } = {}) {
  const required = Array.isArray(requiredCapabilities) ? requiredCapabilities : [requiredCapabilities];
  return Boolean(row && (isOwner || row.ai_allowed !== false)
    && (String(row.template || '').startsWith('grsai-') || (allowCustom && ['custom-product', 'custom-image'].includes(String(row.template || ''))))
    && row.enabled && hasEncryptedApiKey(row.encrypted_api_key)
    && required.every(capability => Array.isArray(row.capabilities) && row.capabilities.includes(capability)));
}
const REGISTRATION_HOSTS = Object.freeze({
  'deepseek-official': 'platform.deepseek.com',
  'alibaba-model-studio-image': 'bailian.console.aliyun.com',
  'grsai-product': 'grsai.ai',
  'grsai-image': 'grsai.ai',
  'agentrouter-product': 'agentrouter.org', 'agentrouter-image': 'agentrouter.org',
  'apiyi-product': 'api.apiyi.com', 'apiyi-image': 'api.apiyi.com',
  'truesota-product': 'true-sota.com', 'truesota-image': 'true-sota.com'
});
function invitationUrl(template, value) {
  const expectedHost = REGISTRATION_HOSTS[template];
  if (!expectedHost) throw error('ai_registration_template_not_supported', '该邀请模板暂不支持自动登记，请手动填写AI服务配置。', 400);
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw error('invalid_ai_invitation_url', '邀请链接格式不正确，请粘贴供应商官方的HTTPS邀请链接。', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.hostname !== expectedHost && !url.hostname.endsWith(`.${expectedHost}`))) throw error('invalid_ai_invitation_url', '邀请链接格式不正确，请粘贴供应商官方的HTTPS邀请链接。', 400);
  return url.toString();
}
function createAiConfigStore(pool, writeAudit, { standaloneMode = false } = {}) {
  async function ownerContext(account, client = pool) {
    const result = await client.query(
      `SELECT user_id::text FROM tenant_members WHERE tenant_id=$1 AND member_type='owner' AND status='active' ORDER BY joined_at,user_id LIMIT 1`,
      [account.tenantId]
    );
    if (!result.rowCount) throw error('ai_owner_not_found', '未找到该AI配置所属客户空间的主账号，请先补齐账号资料。', 409);
    const ownerUserId = result.rows[0].user_id;
    return { ownerUserId, isOwner: account.memberType === 'owner' && String(account.userId) === ownerUserId };
  }
  async function list(account) {
    const context = await ownerContext(account);
    const result = await pool.query(
      `SELECT c.*, o.invitation_url AS published_invitation_url, d.capability AS default_capability, p.capability AS preferred_capability, COALESCE(sap.allowed,true) AS ai_allowed, sap.allowed_capabilities
       FROM ai_configurations c
       LEFT JOIN ai_provider_registration_overrides o ON o.template=c.template AND o.is_published
       LEFT JOIN ai_configuration_defaults d ON d.configuration_id=c.id AND d.tenant_id=c.tenant_id AND d.owner_user_id=c.owner_user_id
       LEFT JOIN ai_user_preferences p ON p.configuration_id=c.id AND p.tenant_id=c.tenant_id AND p.owner_user_id=c.owner_user_id AND p.user_id=$3
       LEFT JOIN ai_subaccount_permissions sap ON sap.tenant_id=c.tenant_id AND sap.owner_user_id=c.owner_user_id AND sap.user_id=$3
       WHERE c.tenant_id=$1 AND c.owner_user_id=$2
         AND ($4::boolean OR (c.enabled AND COALESCE(sap.allowed,true)))
       ORDER BY c.created_at,c.id`,
      [account.tenantId, context.ownerUserId, account.userId, context.isOwner]
    );
    const rows = [];
    for (const row of result.rows) {
      const existing = rows.find(item => String(item.id) === String(row.id));
      if (existing) {
        if (row.default_capability && !existing.default_capabilities.includes(row.default_capability)) existing.default_capabilities.push(row.default_capability);
        if (row.preferred_capability && !existing.preferred_capabilities.includes(row.preferred_capability)) existing.preferred_capabilities.push(row.preferred_capability);
      } else rows.push({ ...row, default_capabilities: row.default_capability ? [row.default_capability] : [], preferred_capabilities: row.preferred_capability ? [row.preferred_capability] : [] });
    }
    return { ...context, allowCustom: standaloneMode, rows };
  }
  async function listSubaccounts(account) {
    const context = await ownerContext(account);
    if (!context.isOwner) return [];
    const result = await pool.query(
      `SELECT tm.user_id::text,u.username,COALESCE(up.full_name,'') AS profile_full_name,COALESCE(up.email,'') AS email,
              COALESCE(p.allowed,true) AS ai_allowed,COALESCE(p.allowed_capabilities,$3::text[]) AS allowed_capabilities
       FROM tenant_members tm JOIN users u ON u.id=tm.user_id
       LEFT JOIN user_profiles up ON up.user_id=tm.user_id
       LEFT JOIN ai_subaccount_permissions p ON p.tenant_id=tm.tenant_id AND p.owner_user_id=$2 AND p.user_id=tm.user_id
       WHERE tm.tenant_id=$1 AND tm.member_type<>'owner' AND tm.status='active' ORDER BY u.username,tm.user_id`,
      [account.tenantId, context.ownerUserId, AI_CAPABILITIES]
    );
    return result.rows.map(row => ({ userId: row.user_id, username: row.username, profileFullName: row.profile_full_name || '', email: row.email || '', aiAllowed: row.ai_allowed, allowedCapabilities: row.allowed_capabilities }));
  }
  async function getOwner(account, id, client = pool) {
    const context = await ownerContext(account, client);
    if (!context.isOwner) throw error('ai_configuration_owner_required', '只有本空间主账号可以管理AI配置与密钥，请用主账号登录后重试。', 403);
    const result = await client.query('SELECT * FROM ai_configurations WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3', [id, account.tenantId, context.ownerUserId]);
    if (!result.rowCount) throw error('ai_configuration_not_found', '未找到该AI服务配置，请刷新页面后重新选择。', 404);
    return result.rows[0];
  }
  async function save(account, config) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const context = await ownerContext(account, client);
      if (!context.isOwner) throw error('ai_configuration_owner_required', '只有本空间主账号可以管理AI配置与密钥，请用主账号登录后重试。', 403);
      const result = await client.query(
        `INSERT INTO ai_configurations(id,tenant_id,owner_user_id,name,section,template,protocol,base_url,registration_url,documentation_url,model,capabilities,encrypted_api_key,timeout_ms,enabled,allow_subaccounts)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)
         ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,section=EXCLUDED.section,template=EXCLUDED.template,protocol=EXCLUDED.protocol,base_url=EXCLUDED.base_url,registration_url=EXCLUDED.registration_url,documentation_url=EXCLUDED.documentation_url,model=EXCLUDED.model,capabilities=EXCLUDED.capabilities,encrypted_api_key=EXCLUDED.encrypted_api_key,timeout_ms=EXCLUDED.timeout_ms,enabled=EXCLUDED.enabled,allow_subaccounts=EXCLUDED.allow_subaccounts,tested_at=NULL,test_kind=NULL,test_status='untested',test_error_code=NULL,updated_at=now()
         WHERE ai_configurations.tenant_id=$2 AND ai_configurations.owner_user_id=$3 RETURNING *`,
        [config.id, account.tenantId, context.ownerUserId, config.name, config.section, config.template, config.protocol, config.baseUrl, config.registrationUrl, config.documentationUrl, JSON.stringify(config.model), JSON.stringify(config.capabilities), config.encryptedApiKey && JSON.stringify(config.encryptedApiKey), config.timeoutMs, config.enabled, config.allowSubaccounts]
      );
      if (!result.rowCount) throw error('ai_configuration_not_found', '未找到该AI服务配置，请刷新页面后重新选择。', 404);
      await writeAudit(client, account, 'ai.configuration.save', 'ai_configuration', config.id, 'success', { section: config.section, capabilities: config.capabilities });
      await client.query('COMMIT');
      return result.rows[0];
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function saveMany(account, configs) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const context = await ownerContext(account, client);
      if (!context.isOwner) throw error('ai_configuration_owner_required', '只有本空间主账号可以管理AI配置与密钥，请用主账号登录后重试。', 403);
      const rows = [];
      for (const config of configs) {
        const result = await client.query(
          `INSERT INTO ai_configurations(id,tenant_id,owner_user_id,name,section,template,protocol,base_url,registration_url,documentation_url,model,capabilities,encrypted_api_key,timeout_ms,enabled,allow_subaccounts)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16)
           ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,section=EXCLUDED.section,template=EXCLUDED.template,protocol=EXCLUDED.protocol,base_url=EXCLUDED.base_url,registration_url=EXCLUDED.registration_url,documentation_url=EXCLUDED.documentation_url,model=EXCLUDED.model,capabilities=EXCLUDED.capabilities,encrypted_api_key=EXCLUDED.encrypted_api_key,timeout_ms=EXCLUDED.timeout_ms,enabled=EXCLUDED.enabled,allow_subaccounts=EXCLUDED.allow_subaccounts,tested_at=NULL,test_kind=NULL,test_status='untested',test_error_code=NULL,updated_at=now()
           WHERE ai_configurations.tenant_id=$2 AND ai_configurations.owner_user_id=$3 RETURNING *`,
          [config.id, account.tenantId, context.ownerUserId, config.name, config.section, config.template, config.protocol, config.baseUrl, config.registrationUrl, config.documentationUrl, JSON.stringify(config.model), JSON.stringify(config.capabilities), config.encryptedApiKey && JSON.stringify(config.encryptedApiKey), config.timeoutMs, config.enabled, config.allowSubaccounts]
        );
        if (!result.rowCount) throw error('ai_configuration_not_found', '未找到该AI服务配置，请刷新页面后重新选择。', 404);
        rows.push(result.rows[0]);
      }
      await writeAudit(client, account, 'ai.configuration.bundle.save', 'ai_provider', 'grsai', 'success', { templates: configs.map(config => config.template) });
      await client.query('COMMIT');
      return rows;
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function remove(account, id) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await getOwner(account, id, client);
      await client.query('DELETE FROM ai_configurations WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3', [id, account.tenantId, account.userId]);
      await writeAudit(client, account, 'ai.configuration.delete', 'ai_configuration', id, 'success', {});
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function removeMany(account, ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const context = await ownerContext(account, client);
      if (!context.isOwner) throw error('ai_configuration_owner_required', '只有本空间主账号可以管理AI配置与密钥，请用主账号登录后重试。', 403);
      await client.query('DELETE FROM ai_configurations WHERE tenant_id=$1 AND owner_user_id=$2 AND id=ANY($3::uuid[])', [account.tenantId, context.ownerUserId, ids]);
      await writeAudit(client, account, 'ai.configuration.bundle.delete', 'ai_provider', 'grsai', 'success', { count: ids.length });
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function markTest(account, id, outcome) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await getOwner(account, id, client);
      const result = await client.query(
        `UPDATE ai_configurations SET tested_at=now(),test_kind=$4,test_status=$5,test_error_code=$6,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3 RETURNING *`,
        [id, account.tenantId, account.userId, outcome.kind, outcome.ok ? 'passed' : 'failed', outcome.errorCode || null]
      );
      await writeAudit(client, account, 'ai.configuration.test', 'ai_configuration', id, outcome.ok ? 'success' : 'failed', { kind: outcome.kind, errorCode: outcome.errorCode || null });
      await client.query('COMMIT');
      return result.rows[0];
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  // 启用/停用某条配置；启用时按能力组（文本/图片）自动顶替同组其它已启用密钥，每类同时只有一个生效密钥。
  async function setEnabled(account, id, enabled) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await getOwner(account, id, client);
      const next = Boolean(enabled);
      if (next && !row.encrypted_api_key) throw error('ai_configuration_missing_key', '该AI服务配置还没有填写API密钥，请先补齐密钥后再使用。', 409);
      if (next && !standaloneMode) {
        const overlapCaps = row.capabilities.filter(capability => AI_CAPABILITIES.includes(capability));
        if (overlapCaps.length) {
          // 只要与本条任一实际能力（不含纯登记的视频标签）重叠，同组其它启用行一并停用。
          await client.query(
            `UPDATE ai_configurations SET enabled=false,updated_at=now()
             WHERE tenant_id=$1 AND owner_user_id=$2 AND id<>$3 AND enabled
               AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(capabilities) cap(value) WHERE cap.value=ANY($4::text[]))`,
            [account.tenantId, row.owner_user_id, id, overlapCaps]
          );
        }
      }
      const result = await client.query(
        'UPDATE ai_configurations SET enabled=$4,updated_at=now() WHERE id=$1 AND tenant_id=$2 AND owner_user_id=$3 RETURNING *',
        [id, account.tenantId, row.owner_user_id, next]
      );
      await writeAudit(client, account, 'ai.configuration.enabled', 'ai_configuration', id, 'success', { enabled: next });
      await client.query('COMMIT');
      return result.rows[0];
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function setDefault(account, capability, configurationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await getOwner(account, configurationId, client);
      if (!row.enabled || !row.encrypted_api_key || !row.capabilities.includes(capability)) throw error('ai_configuration_unavailable', '当前AI服务配置不可用，请检查启用状态、密钥与该项能力的授权后重试。', 409);
      await client.query(
        `INSERT INTO ai_configuration_defaults(tenant_id,owner_user_id,capability,configuration_id) VALUES($1,$2,$3,$4)
         ON CONFLICT(tenant_id,owner_user_id,capability) DO UPDATE SET configuration_id=EXCLUDED.configuration_id`,
        [account.tenantId, account.userId, capability, configurationId]
      );
      await writeAudit(client, account, 'ai.configuration.default', 'ai_configuration', configurationId, 'success', { capability });
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function setPreference(account, capability, configurationId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const context = await ownerContext(account, client);
      const available = await client.query(
        `SELECT c.id FROM ai_configurations c
         LEFT JOIN ai_subaccount_permissions p ON p.tenant_id=c.tenant_id AND p.owner_user_id=c.owner_user_id AND p.user_id=$3
         WHERE c.id=$4 AND c.tenant_id=$1 AND c.owner_user_id=$2 AND c.enabled AND c.encrypted_api_key IS NOT NULL
           AND ($5::boolean OR (c.allow_subaccounts AND COALESCE(p.allowed,true))) AND c.capabilities ? $6`,
        [account.tenantId, context.ownerUserId, account.userId, configurationId, context.isOwner, capability]
      );
      if (!available.rowCount) throw error('ai_configuration_unavailable', '当前AI服务配置不可用，请检查启用状态、密钥与该项能力的授权后重试。', 403);
      await client.query(
        `INSERT INTO ai_user_preferences(tenant_id,user_id,owner_user_id,capability,configuration_id) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id,user_id,capability) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,configuration_id=EXCLUDED.configuration_id,updated_at=now()`,
        [account.tenantId, account.userId, context.ownerUserId, capability, configurationId]
      );
      await writeAudit(client, account, 'ai.configuration.preference', 'ai_configuration', configurationId, 'success', { capability });
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function setSubaccount(account, userId, allowed) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const context = await ownerContext(account, client);
      if (!context.isOwner || String(userId) === context.ownerUserId) throw error('ai_configuration_owner_required', '只有本空间主账号可以管理AI配置与密钥，请用主账号登录后重试。', 403);
      const member = await client.query(`SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND user_id=$2 AND member_type<>'owner' AND status='active' FOR UPDATE`, [account.tenantId, userId]);
      if (!member.rowCount) throw error('member_not_found', '未找到该成员账号，请刷新成员列表后重试。', 404);
      await client.query(
        `INSERT INTO ai_subaccount_permissions(tenant_id,owner_user_id,user_id,allowed,allowed_capabilities) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id,owner_user_id,user_id) DO UPDATE SET allowed=EXCLUDED.allowed,allowed_capabilities=EXCLUDED.allowed_capabilities,updated_at=now()`,
        [account.tenantId, context.ownerUserId, userId, Boolean(allowed), AI_CAPABILITIES]
      );
      await writeAudit(client, account, 'ai.subaccount.permission', 'user', String(userId), 'success', { allowed: Boolean(allowed) });
      await client.query('COMMIT');
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  async function available(account, id, capabilities) {
    const listed = await list(account);
    const row = listed.rows.find(item => String(item.id) === String(id) && canUseAiConfiguration(item, capabilities, listed));
    if (!row) throw Object.assign(error('ai_configuration_unavailable', '当前AI服务配置不可用，请检查启用状态、密钥与该项能力的授权后重试。', 403), { message: '请先保存已启用、有密钥且能力匹配的 GRS AI 配置，并确认当前账号已获授权' });
    return row;
  }
  async function availableDefault(account, capabilities) {
    if (!standaloneMode) throw error('ai_configuration_unavailable', '默认自定义模型仅单机版支持', 403);
    const required = Array.isArray(capabilities) ? capabilities : [capabilities];
    const listed = await list(account);
    const matched = listed.rows.filter(row => canUseAiConfiguration(row, required, listed));
    const chosen = matched.find(row => required.every(key => row.preferred_capabilities.includes(key)))
      || matched.find(row => required.every(key => row.default_capabilities.includes(key)))
      || (matched.length === 1 ? matched[0] : null);
    if (!chosen) throw error('ai_configuration_unavailable', '没有匹配功能的默认AI模型，请在AI配置页面分配模型用途', 409);
    return chosen;
  }
  // 官方任务不接受客户端配置 ID：仅系统管理员拥有的唯一已启用 GRS 配置可被解析。
  async function availableOfficial(account, capabilities) {
    const context = await ownerContext(account);
    const required = Array.isArray(capabilities) ? capabilities : [capabilities];
    const result = await pool.query(
      `SELECT c.*,COALESCE(sap.allowed,true) AS ai_allowed
       FROM ai_configurations c
       JOIN users u ON u.id=c.owner_user_id AND u.is_system_admin=true
       LEFT JOIN ai_subaccount_permissions sap ON sap.tenant_id=$1 AND sap.owner_user_id=$2 AND sap.user_id=$3
       WHERE c.enabled AND c.encrypted_api_key IS NOT NULL AND c.template LIKE 'grsai-%' AND c.capabilities ?& $4::text[]
       ORDER BY c.updated_at,c.id LIMIT 2`,
      [account.tenantId, context.ownerUserId, account.userId, required]
    );
    const rows = result.rows.filter(row => canUseAiConfiguration(row, required, context));
    if (rows.length !== 1) throw Object.assign(error('ai_configuration_unavailable', '当前AI服务配置不可用，请检查启用状态、密钥与该项能力的授权后重试。', 403), { message: '系统管理员尚未维护唯一可用的官方 GRS AI 配置，或当前账号未获授权' });
    return rows[0];
  }
  async function getUiPreferences(account) {
    const result = await pool.query(
      'SELECT pref_key,pref_value FROM ai_user_ui_preferences WHERE tenant_id=$1 AND user_id=$2',
      [account.tenantId, account.userId]
    );
    const preferences = {};
    for (const row of result.rows) preferences[row.pref_key] = row.pref_value;
    return preferences;
  }
  async function setUiPreference(account, key, value) {
    const validator = UI_PREFERENCE_VALIDATORS[key];
    if (!validator || !validator(value)) throw error('ai_ui_preference_invalid', '界面偏好设置内容不正确，已保持原设置不变。', 400);
    await pool.query(
      `INSERT INTO ai_user_ui_preferences(tenant_id,user_id,pref_key,pref_value) VALUES($1,$2,$3,$4::jsonb)
       ON CONFLICT(tenant_id,user_id,pref_key) DO UPDATE SET pref_value=EXCLUDED.pref_value,updated_at=now()`,
      [account.tenantId, account.userId, key, JSON.stringify(value)]
    );
    await writeAudit(pool, account, 'ai.ui-preference.save', 'ai_user', String(account.userId), 'success', { key, value });
  }
  async function listRegistrationOverrides(account) {
    if (!account.isSystemAdmin) throw error('system_admin_required', '该操作仅限系统管理员，请用系统管理员账号登录后再试。', 403);
    const result = await pool.query('SELECT template,invitation_url,is_published,updated_at FROM ai_provider_registration_overrides ORDER BY template');
    return result.rows.map(row => ({ template: row.template, invitationUrl: row.invitation_url, published: row.is_published, updatedAt: row.updated_at }));
  }
  async function listPublishedRegistrationOverrides() {
    const result = await pool.query('SELECT template,invitation_url FROM ai_provider_registration_overrides WHERE is_published ORDER BY template');
    return result.rows.map(row => ({ template: row.template, invitationUrl: row.invitation_url }));
  }
  async function setRegistrationOverride(account, template, value, published) {
    if (!account.isSystemAdmin) throw error('system_admin_required', '该操作仅限系统管理员，请用系统管理员账号登录后再试。', 403);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!String(value || '').trim()) {
        if (!REGISTRATION_HOSTS[template]) throw error('ai_registration_template_not_supported', '该邀请模板暂不支持自动登记，请手动填写AI服务配置。', 400);
        await client.query('DELETE FROM ai_provider_registration_overrides WHERE template=$1', [template]);
        await writeAudit(client, account, 'ai.registration-override.delete', 'ai_provider', template, 'success', {});
        await client.query('COMMIT');
        return { template, invitationUrl: '', published: false };
      }
      const url = invitationUrl(template, value);
      await client.query(
        `INSERT INTO ai_provider_registration_overrides(template,invitation_url,is_published,updated_by_user_id) VALUES($1,$2,$3,$4)
         ON CONFLICT(template) DO UPDATE SET invitation_url=EXCLUDED.invitation_url,is_published=EXCLUDED.is_published,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [template, url, Boolean(published), account.userId]
      );
      await writeAudit(client, account, 'ai.registration-override.save', 'ai_provider', template, 'success', { published: Boolean(published) });
      await client.query('COMMIT');
      return { template, invitationUrl: url, published: Boolean(published) };
    } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
  }
  return { ownerContext, list, listSubaccounts, getOwner, save, saveMany, remove, removeMany, markTest, setEnabled, setDefault, setPreference, setSubaccount, available, availableDefault, availableOfficial, getUiPreferences, setUiPreference, listRegistrationOverrides, listPublishedRegistrationOverrides, setRegistrationOverride };
}

module.exports = { createAiConfigStore, invitationUrl, canUseAiConfiguration };