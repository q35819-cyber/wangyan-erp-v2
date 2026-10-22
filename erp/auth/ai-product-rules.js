'use strict';

// 商品内容规则：一条全局规则 + 六项单项规则，全系统共用，只有数据库 is_system_admin=true 的账号可读写。
const RULE_KEYS = Object.freeze(['global', 'title', 'tags', 'summary', 'richTitle', 'richDescription', 'sellingPoints']);
const ITEM_RULE_KEYS = Object.freeze(RULE_KEYS.filter(key => key !== 'global'));
const RULE_LABELS = Object.freeze({
  global: '商品内容全局规则',
  title: '商品标题规则',
  tags: '标签规则',
  summary: '商品简介规则',
  sellingPoints: '卖点提炼规则',
  richTitle: '图文标题规则',
  richDescription: '图文描述规则'
});
const MAX_BODY_CHARS = 12000;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }

function validatePolicy(key, policy) {
  if (!policy) throw fail('ai_product_policy_missing', '商品内容策略尚未配置，请联系系统管理员。', 409);
  const fields = { global: ['prohibitedClaims', 'materialTerms'], title: ['ownBrand', 'rejectBrandPlaceholder', 'compatibility', 'compatibilityExpressions'], summary: ['compatibility', 'compatibilityExpressions'], tags: ['excludeBrand', 'excludeModel'] };
  if (typeof policy !== 'object' || Array.isArray(policy) || policy.schemaVersion !== 1 || Object.keys(policy).some(name => !['schemaVersion', ...(fields[key] || [])].includes(name))) throw fail('ai_product_policy_invalid', '商品内容策略字段或版本不正确，请检查后保存。');
  const phrases = (value, languages, required, max = 20) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !languages.includes(name))) throw fail('ai_product_policy_invalid', '策略短语必须按指定语言填写。');
    for (const language of languages) {
      const list = value[language];
      if (!Array.isArray(list) || list.length > max || (required && !list.length) || list.some(term => typeof term !== 'string' || !term || term.trim() !== term || Array.from(term).length > 100 || /[\u0000-\u001f\u007f]/.test(term)) || new Set(list.map(term => term.toLowerCase())).size !== list.length) throw fail('ai_product_policy_invalid', `策略短语每种语言最多${max}条，每条1至100字，不得重复或包含首尾空白及控制字符。`);
    }
  };
  if (key === 'global') {
    phrases(policy.prohibitedClaims, ['zh', 'ru', 'en'], false, 128);
    if (!Object.hasOwn(policy, 'materialTerms')) throw fail('ai_material_policy_missing', '材料英文许可表尚未配置，请联系系统管理员。', 409);
    const terms = policy.materialTerms;
    if (!Array.isArray(terms) || terms.length > 128 || terms.some(term => typeof term !== 'string' || term.length > 100 || !/[a-z]/i.test(term) || !/^[a-z0-9]+(?:[- ][a-z0-9]+)*$/i.test(term) || term.split(' ').length > 5) || new Set(terms.map(term => term.toLowerCase())).size !== terms.length) throw fail('ai_material_policy_invalid', '材料许可表最多128条，每条1至100个英文字母或数字，可用单空格或连字符连接且最多5个词，不得重复或填写句子、正则。');
  }
  if (key === 'title' && (!['explicit_only', 'omit'].includes(policy.ownBrand) || typeof policy.rejectBrandPlaceholder !== 'boolean')) throw fail('ai_product_policy_invalid', '请正确设置标题品牌策略和无品牌占位检查。');
  if (['title', 'summary'].includes(key)) {
    if (!['allow', 'deny'].includes(policy.compatibility)) throw fail('ai_product_policy_invalid', '请选择允许或禁止适配身份。');
    phrases(policy.compatibilityExpressions, ['zh', 'ru'], policy.compatibility === 'allow');
  }
  if (key === 'tags' && (typeof policy.excludeBrand !== 'boolean' || typeof policy.excludeModel !== 'boolean')) throw fail('ai_product_policy_invalid', '标签品牌和型号策略必须设置为开启或关闭。');
  return policy;
}

// 冲突检测只识别规则文本里显式写出的长度约束（例如“最多120字”“不超过 200 个字符”）。
// ponytail: 上限=只比长度数值；若以后要按禁词、必含字段等维度判冲突，需另加结构化列并新增迁移，同时把页面改成对应控件。
function declaredMaxChars(body) {
  const matches = [...String(body || '').matchAll(/(?:最多|不超过|至多|上限|≤)\s*(\d{1,6})\s*(?:个)?\s*(?:字|字符|字元)/g)].map(item => Number(item[1]));
  return matches.length ? Math.min(...matches.filter(value => Number.isFinite(value) && value > 0)) : null;
}
function ruleConflict(globalBody, itemBody) {
  const globalLimit = declaredMaxChars(globalBody);
  const itemLimit = declaredMaxChars(itemBody);
  if (!globalLimit || !itemLimit || globalLimit === itemLimit) return null;
  return { globalLimit, itemLimit };
}
function requireSystemAdmin(account) {
  if (!account || account.isSystemAdmin !== true) throw fail('system_admin_required', '仅系统管理员可以查看或修改商品内容规则', 403);
}
function normalizeInput(input, existing) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ai_product_rule_invalid', '商品内容规则格式不正确');
  const key = String(input.key || input.ruleKey || '');
  if (!RULE_KEYS.includes(key)) throw fail('ai_product_rule_invalid', '未知的商品内容规则项');
  const body = String(input.body == null ? '' : input.body).trim();
  if (!body) throw fail('ai_product_rule_invalid', `${RULE_LABELS[key]}不能为空`);
  if (body.length > MAX_BODY_CHARS) throw fail('ai_product_rule_invalid', `${RULE_LABELS[key]}不能超过 ${MAX_BODY_CHARS} 字`);
  const name = String(input.name || existing?.name || RULE_LABELS[key]).trim().slice(0, 80);
  const enabled = input.enabled === undefined ? (existing ? existing.enabled !== false : true) : input.enabled === true;
  return { key, name: name || RULE_LABELS[key], body, enabled, policy: validatePolicy(key, input.policy === undefined ? existing?.policy : input.policy) };
}

function createAiProductRuleStore(pool, writeAudit) {
  async function rows(client = pool, requirePolicy = false) {
    try {
      const result = await client.query('SELECT rule_key,name,body,policy,enabled,updated_at::text AS updated_at,updated_by_user_id FROM ai_product_content_rules ORDER BY CASE WHEN rule_key=$1 THEN 0 ELSE 1 END,rule_key', ['global']);
      return result.rows;
    } catch (error) {
      if (error.code === '42703' && !requirePolicy) return (await client.query('SELECT rule_key,name,body,enabled,updated_at::text AS updated_at,updated_by_user_id FROM ai_product_content_rules ORDER BY rule_key')).rows;
      if (error.code === '42703') throw fail('ai_product_policy_uninitialized', '商品内容策略尚未初始化，请联系系统管理员。', 503);
      throw error;
    }
  }
  async function list(account) {
    requireSystemAdmin(account);
    const found = await rows(pool, true);
    return found.map(row => ({ key: row.rule_key, name: row.name, body: row.body, enabled: row.enabled, updatedAt: row.updated_at, policy: row.policy, maxChars: declaredMaxChars(row.body) }));
  }
  async function effective(itemKey, options = {}) {
    if (!ITEM_RULE_KEYS.includes(itemKey)) throw fail('ai_product_rule_invalid', '未知的商品内容规则项');
    const found = Object.fromEntries((options.snapshot || await rows(pool, options.requirePolicy === true)).map(row => [row.rule_key, row]));
    const item = found[itemKey];
    if (!item || item.enabled !== true || !String(item.body || '').trim()) throw fail('ai_product_rule_unavailable', `${RULE_LABELS[itemKey]}未启用、缺失或正文为空，请由系统管理员处理后再生成`, 409);
    const global = found.global && found.global.enabled === true ? found.global : null;
    if (options.requireGlobal === true && (!global || !String(global.body || '').trim())) throw fail('ai_product_rule_unavailable', `${RULE_LABELS.global}未启用、缺失或正文为空，请由系统管理员处理后再生成`, 409);
    const conflict = global ? ruleConflict(global.body, item.body) : null;
    if (conflict) throw fail('ai_product_rule_conflict', `全局规则限定最多${conflict.globalLimit}字，${RULE_LABELS[itemKey]}限定最多${conflict.itemLimit}字，两者冲突，请系统管理员统一后再试`, 409);
    const result = { key: itemKey, name: RULE_LABELS[itemKey], global: global ? global.body : '', item: item.body, ...(options.requirePolicy === true ? { policy: validatePolicy(itemKey, item.policy), globalPolicy: validatePolicy('global', global?.policy) } : {}) };
    return options.includeMetadata === true ? { ...result, versions: { global: global ? String(global.updated_at || '') : '', item: String(item.updated_at || '') } } : result;
  }
  async function attributeRule(options = {}) {
    const global = (options.snapshot || await rows(pool, true)).find(row => row.rule_key === 'global');
    if (!global || !global.enabled) throw fail('ai_product_policy_missing', '商品内容策略尚未配置，请联系系统管理员。', 409);
    return { global: global.body, globalPolicy: validatePolicy('global', global.policy), versions: { global: String(global.updated_at) } };
  }
  async function saveAll(account, rules) {
    requireSystemAdmin(account);
    if (!Array.isArray(rules) || !rules.length || rules.length > RULE_KEYS.length) throw fail('ai_product_rule_invalid', '请提交 1-7 条商品内容规则');
    const keys = rules.map(input => String(input && (input.key || input.ruleKey) || ''));
    if (new Set(keys).size !== keys.length) throw fail('ai_product_rule_duplicate', '同一规则项不能重复提交');
    for (const input of rules) {
      const key = String(input && (input.key || input.ruleKey) || '');
      if (!RULE_KEYS.includes(key)) throw fail('ai_product_rule_invalid', '未知的商品内容规则项');
      if (!String(input.body || '').trim()) throw fail('ai_product_rule_invalid', `${RULE_LABELS[key]}不能为空`);
    }
    const client = await pool.connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query('SELECT rule_key FROM ai_product_content_rules ORDER BY rule_key FOR UPDATE');
    const existingRows = await rows(client, true);
    const existingByKey = Object.fromEntries(existingRows.map(row => [row.rule_key, row]));
    for (const input of rules) {
      const existing = existingByKey[String(input.key || input.ruleKey || '')];
      if (!existing || typeof input.expectedUpdatedAt !== 'string' || input.expectedUpdatedAt !== String(existing.updated_at)) throw fail('ai_product_rule_stale', '规则已被其他管理员修改，请刷新后重新保存。', 409);
    }
    pending = rules.map(input => normalizeInput(input, existingByKey[String(input && (input.key || input.ruleKey) || '')]));
    const pendingByKey = Object.fromEntries(pending.map(item => [item.key, item]));
    const combined = { ...Object.fromEntries(existingRows.map(row => [row.rule_key, { key: row.rule_key, body: row.body, enabled: row.enabled }])), ...pendingByKey };
    const globalBody = combined.global && combined.global.enabled !== false ? combined.global.body : '';
    for (const item of Object.values(combined)) {
      if (item.key === 'global' || item.enabled !== true || !globalBody) continue;
      const conflict = ruleConflict(globalBody, item.body);
      if (conflict) throw fail('ai_product_rule_conflict', `${RULE_LABELS.global}限定最多${conflict.globalLimit}字，${RULE_LABELS[item.key]}限定最多${conflict.itemLimit}字，两者冲突，请统一后再保存`, 409);
    }
      for (const item of pending) {
        await client.query('INSERT INTO ai_product_content_rules(rule_key,name,body,enabled,updated_by_user_id,policy,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now()) ON CONFLICT(rule_key) DO UPDATE SET name=EXCLUDED.name,body=EXCLUDED.body,policy=EXCLUDED.policy,enabled=EXCLUDED.enabled,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()', [item.key, item.name, item.body, item.enabled, account.userId, JSON.stringify(item.policy)]);
        await writeAudit(client, account, 'ai.product-rule.save', 'ai_product_rule', item.key, 'success', { enabled: item.enabled, bodyChars: item.body.length });
      }
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
    return pending.map(item => ({ key: item.key, name: item.name, body: item.body, enabled: item.enabled, policy: item.policy, maxChars: declaredMaxChars(item.body) }));
  }
  return { list, effective, attributeRule, saveAll, rows, declaredMaxChars, ruleConflict, RULE_KEYS, ITEM_RULE_KEYS, RULE_LABELS, MAX_BODY_CHARS };
}

module.exports = { createAiProductRuleStore, RULE_KEYS, ITEM_RULE_KEYS, RULE_LABELS, MAX_BODY_CHARS, declaredMaxChars, ruleConflict, normalizeInput, validatePolicy, fail };
