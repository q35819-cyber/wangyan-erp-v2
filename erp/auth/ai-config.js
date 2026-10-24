'use strict';

const crypto = require('crypto');
const { encryptValue, decryptValue } = require('./credential-crypto');
const vendorAdapter = require('./ai-vendor-adapter');

const PRODUCT_CAPABILITIES = new Set(['product-translation', 'title-optimization', 'description-optimization', 'selling-point-generation', 'attribute-text-optimization']);
const IMAGE_CAPABILITIES = new Set(['image-translation', 'image-redraw', 'image-repair']);
// 视频生成通道本期仅做能力登记（界面勾选与展示），不接通任何真实生成调用。
const VIDEO_CAPABILITY = 'video-generation';
const CAPABILITY_GROUPS = Object.freeze({
  text: Object.freeze([...PRODUCT_CAPABILITIES]),
  image: Object.freeze([...IMAGE_CAPABILITIES]),
  video: Object.freeze([VIDEO_CAPABILITY])
});
const GROUP_LABELS = Object.freeze({ text: '文本', image: '图片', video: '视频' });
function groupsForCapabilities(capabilities) {
  const set = new Set(Array.isArray(capabilities) ? capabilities : []);
  const groups = [];
  if ([...PRODUCT_CAPABILITIES].some(capability => set.has(capability))) groups.push('text');
  if ([...IMAGE_CAPABILITIES].some(capability => set.has(capability))) groups.push('image');
  if (set.has(VIDEO_CAPABILITY)) groups.push('video');
  return groups;
}
const PROTOCOLS = new Set(['openai-chat-completions', 'openai-image', 'dashscope-native', 'grsai-gemini-generate', 'grsai-generate', 'custom-structured']);
const GRS_TEXT_PROTOCOL = 'grsai-gemini-generate';
const GRS_IMAGE_PROTOCOL = 'grsai-generate';
// GRS AI 国内节点固定；全球节点 https://grsaiapi.com 按用户决定不开放选择。
const GRS_BASE_URL = 'https://grsai.dakka.com.cn';
const NANO_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9'];
const NANO2_RATIOS = [...NANO_RATIOS, '1:4', '4:1', '1:8', '8:1'];
const GPT_RATIOS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '21:9', '9:21', '1:3', '3:1', '2:1', '1:2'];
// 模型名按用户 2026-09-14 决定先内置写死；来源为 GRS AI 官方接口文档，禁止前端自行填写。
const GRS_MODELS = Object.freeze({
  product: Object.freeze([
    { name: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', capabilities: [...PRODUCT_CAPABILITIES] },
    { name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', capabilities: [...PRODUCT_CAPABILITIES] },
    { name: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', capabilities: [...PRODUCT_CAPABILITIES] }
  ]),
  image: Object.freeze([
    { name: 'nano-banana', label: 'Nano Banana', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-fast', label: 'Nano Banana Fast', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-2', label: 'Nano Banana 2', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO2_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-2-cl', label: 'Nano Banana 2 CL', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO2_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-2-2k-cl', label: 'Nano Banana 2 2K CL', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO2_RATIOS, imageSizes: ['2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-2-4k-cl', label: 'Nano Banana 2 4K CL', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO2_RATIOS, imageSizes: ['4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-pro', label: 'Nano Banana Pro', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-pro-vt', label: 'Nano Banana Pro VT', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-pro-cl', label: 'Nano Banana Pro CL', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-pro-vip', label: 'Nano Banana Pro VIP', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['1K', '2K', '4K'], qualities: [], backgrounds: [] },
    { name: 'nano-banana-pro-4k-vip', label: 'Nano Banana Pro 4K VIP', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: NANO_RATIOS, imageSizes: ['4K'], qualities: [], backgrounds: [] },
    { name: 'gpt-image-2', label: 'GPT Image 2', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: GPT_RATIOS, imageSizes: [], qualities: ['auto'], backgrounds: [], pixelSizes: ['1024x1024'] },
    { name: 'gpt-image-2-vip', label: 'GPT Image 2 VIP', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: GPT_RATIOS, imageSizes: [], qualities: ['medium'], backgrounds: ['transparent'], pixelSizes: ['1024x1024', '2048x2048', '2880x2880'] },
    { name: 'gpt-image-2.5', label: 'GPT Image 2.5', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: GPT_RATIOS, imageSizes: [], qualities: ['auto'], backgrounds: [], pixelSizes: ['1024x1024'] },
    { name: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: GPT_RATIOS, imageSizes: [], qualities: ['low', 'medium', 'high'], backgrounds: ['transparent'], pixelSizes: ['1024x1024', '2048x2048', '3840x2160'] },
    { name: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', capabilities: [...IMAGE_CAPABILITIES], aspectRatios: GPT_RATIOS, imageSizes: [], qualities: ['low', 'medium', 'high', 'xhigh', 'max'], backgrounds: ['transparent'], pixelSizes: ['1024x1024', '2048x2048', '3840x2160'] }
  ])
});
function grsaiModels(section) { return section === 'product' ? GRS_MODELS.product : section === 'image' ? GRS_MODELS.image : []; }
function grsaiModel(section, name) { return grsaiModels(section).find(item => item.name === String(name || '').trim()) || null; }
const TEMPLATE_DEFINITIONS = Object.freeze({
  'deepseek-official': { section: 'product', protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com', model: { name: 'deepseek-v4-flash' }, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: 'https://platform.deepseek.com/api_keys', documentationUrl: 'https://api-docs.deepseek.com/' },
  'alibaba-model-studio-image': { section: 'image', protocol: 'dashscope-native', baseUrl: '', model: {}, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: 'https://bailian.console.aliyun.com/?apiKey=1#/api-key', documentationUrl: 'https://help.aliyun.com/zh/model-studio/' },
  'grsai-product': { section: 'product', protocol: GRS_TEXT_PROTOCOL, baseUrl: GRS_BASE_URL, model: { name: 'gemini-3.8-flash' }, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: 'https://grsai.ai/zh/dashboard/api-keys', documentationUrl: 'https://qmy27nhsd9.apifox.cn/452418916e0' },
  'grsai-image': { section: 'image', protocol: GRS_IMAGE_PROTOCOL, baseUrl: GRS_BASE_URL, model: { name: 'gpt-image-2.5' }, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: 'https://grsai.ai/zh/dashboard/api-keys', documentationUrl: 'https://qmy27nhsd9.apifox.cn/452392911e0' },
  'agentrouter-product': { section: 'product', protocol: 'openai-chat-completions', baseUrl: '', model: {}, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: 'https://agentrouter.org/register?aff=76NE', documentationUrl: '' },
  'agentrouter-image': { section: 'image', protocol: 'openai-image', baseUrl: '', model: {}, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: 'https://agentrouter.org/register?aff=76NE', documentationUrl: '' },
  'apiyi-product': { section: 'product', protocol: 'openai-chat-completions', baseUrl: '', model: {}, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: 'https://api.apiyi.com/register/?aff_code=TcwN', documentationUrl: '' },
  'apiyi-image': { section: 'image', protocol: 'openai-image', baseUrl: '', model: {}, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: 'https://api.apiyi.com/register/?aff_code=TcwN', documentationUrl: '' },
  'truesota-product': { section: 'product', protocol: 'openai-chat-completions', baseUrl: '', model: {}, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: 'https://true-sota.com/register?aff=P5LG2DX3KF9U', documentationUrl: '' },
  'truesota-image': { section: 'image', protocol: 'openai-image', baseUrl: '', model: {}, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: 'https://true-sota.com/register?aff=P5LG2DX3KF9U', documentationUrl: '' },
  'custom-product': { section: 'product', protocol: 'openai-chat-completions', baseUrl: '', model: {}, capabilities: [...PRODUCT_CAPABILITIES], registrationUrl: '', documentationUrl: '' },
  'custom-image': { section: 'image', protocol: 'openai-image', baseUrl: '', model: {}, capabilities: [...IMAGE_CAPABILITIES], registrationUrl: '', documentationUrl: '' }
});

function fail(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }
function publicHttps(value, code = 'invalid_ai_base_url', { allowEmpty = false, allowPrivate = false } = {}) {
  if (allowEmpty && !String(value || '').trim()) return '';
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { throw fail(code, '仅允许公开 HTTPS 地址'); }
  const localHost = /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?::\]?)|^\[?(?:fc|fd|fe80):/i.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!allowPrivate && localHost)) throw fail(code, '仅允许公开 HTTPS 地址');
  return url.toString().replace(/\/$/, '');
}
function normalizeModel(value, existing) {
  if (typeof value === 'string') { const name = value.trim().slice(0, 160); return name ? { name } : {}; }
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : existing || {};
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'adapter') { result.adapter = item; continue; }
    if (!['name', ...IMAGE_CAPABILITIES].includes(key) || typeof item !== 'string') throw fail('invalid_ai_model', '模型配置格式不正确');
    if (item.trim()) result[key] = item.trim().slice(0, 160);
  }
  return result;
}
function modelForCapability(model, capability) { return String(model?.[capability] || model?.name || '').trim(); }
function grsaiModelSelection(section, value, existing) {
  const source = value === undefined || value === null || value === '' ? existing : value;
  const entries = typeof source === 'string' ? [['name', source]] : source && typeof source === 'object' && !Array.isArray(source) ? Object.entries(source) : [];
  const result = {};
  for (const [key, item] of entries) {
    const allowedKey = section === 'product' ? key === 'name' : key === 'name' || IMAGE_CAPABILITIES.has(key);
    if (!allowedKey || typeof item !== 'string' || !item.trim()) continue;
    if (!grsaiModel(section, item)) throw fail('invalid_ai_model', 'GRS AI 只允许使用页面内置的官方模型名');
    result[key] = item.trim();
  }
  if (Object.keys(result).length) return result;
  return { ...TEMPLATE_DEFINITIONS[section === 'product' ? 'grsai-product' : 'grsai-image'].model };
}
function normalize(input, { key, tenantId, ownerUserId, existing, allowCustom = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_ai_configuration', 'AI 配置格式不正确');
  const apiKey = input.apiKey == null ? '' : String(input.apiKey).trim();
  if (apiKey.length > 8192) throw fail('invalid_ai_api_key', 'API 密钥长度不正确');
  if (input.removeApiKey === true && apiKey) throw fail('invalid_ai_api_key', '删除密钥时不能同时填写新密钥');
  const existingCredential = input.removeApiKey === true ? null : existing?.encrypted_api_key || existing?.encryptedApiKey;
  const hasCredential = Boolean(apiKey || existingCredential);
  const section = String(input.section || existing?.section || '');
  const allowed = section === 'product' ? PRODUCT_CAPABILITIES : section === 'image' ? new Set([...IMAGE_CAPABILITIES, VIDEO_CAPABILITY]) : null;
  if (!allowed) throw fail('invalid_ai_section', 'AI 配置区必须为商品优化或图片');
  let capabilities = Array.from(new Set(Array.isArray(input.capabilities) ? input.capabilities.map(String) : existing?.capabilities || []));
  if (capabilities.some(capability => !allowed.has(capability)) || hasCredential && !capabilities.some(capability => capability !== VIDEO_CAPABILITY)) throw fail('invalid_ai_capabilities', '配置能力与配置区不匹配');
  const protocol = String(input.protocol || existing?.protocol || '');
  const allowedProtocols = section === 'product' ? new Set(['openai-chat-completions', GRS_TEXT_PROTOCOL, 'custom-structured']) : new Set(['openai-image', 'dashscope-native', GRS_IMAGE_PROTOCOL, 'custom-structured']);
  if (!PROTOCOLS.has(protocol) || !allowedProtocols.has(protocol)) throw fail('invalid_ai_protocol', '该配置区不支持此协议');
  const templateId = String(input.template || existing?.template || (section === 'product' ? 'custom-product' : 'custom-image')).slice(0, 64);
  const definition = TEMPLATE_DEFINITIONS[templateId];
  if (!definition || definition.section !== section || (definition.protocol !== protocol && !(allowCustom && protocol === 'custom-structured' && ['custom-product','custom-image'].includes(templateId)))) throw fail('invalid_ai_template', '模板、配置区和接口协议不匹配');
  if (!templateId.startsWith('grsai-') && !(allowCustom && ['custom-product', 'custom-image'].includes(templateId))) throw fail('invalid_ai_template', '仅单机版允许自定义AI平台及模型');
  const fixedPreset = templateId.startsWith('grsai-');
  if (fixedPreset) capabilities = [...definition.capabilities];
  const supportsVideo = input.supportsVideo === undefined ? capabilities.includes(VIDEO_CAPABILITY) : input.supportsVideo === true;
  if (section === 'image' && supportsVideo && !capabilities.includes(VIDEO_CAPABILITY)) capabilities.push(VIDEO_CAPABILITY);
  if (section === 'image' && !supportsVideo && capabilities.includes(VIDEO_CAPABILITY)) capabilities = capabilities.filter(capability => capability !== VIDEO_CAPABILITY);
  const name = String(input.name || existing?.name || '').trim();
  if (!name || name.length > 120) throw fail('invalid_ai_name', '配置名称长度必须为 1-120');
  const model = fixedPreset ? grsaiModelSelection(section, input.model, existing?.model) : normalizeModel(input.model, existing?.model);
  if (protocol === 'custom-structured') model.adapter = vendorAdapter.validate(model.adapter, section);
  else if (model.adapter !== undefined) throw fail('invalid_ai_vendor_adapter', '该协议不接受可编程供应商适配器');
  if (hasCredential && capabilities.some(capability => !modelForCapability(model, capability))) throw fail('invalid_ai_model', '每项能力都必须配置模型');
  if (apiKey && !key) throw fail('ai_credential_encryption_unavailable', '服务器尚未配置受保护凭证密钥', 503);
  const id = existing?.id || crypto.randomUUID();
  const timeoutMs = fixedPreset ? 180000 : Number(input.timeoutMs ?? existing?.timeout_ms ?? 30000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw fail('invalid_ai_timeout', '请求超时必须为 1-180 秒');
  const baseUrl = publicHttps(input.baseUrl || existing?.base_url || existing?.baseUrl, 'invalid_ai_base_url', { allowEmpty: !hasCredential, allowPrivate: fixedPreset });
  if (definition.baseUrl && baseUrl !== definition.baseUrl) throw fail('invalid_ai_base_url', '内置官方模板不能修改服务地址');
  return {
    id, tenantId: String(tenantId), ownerUserId: String(ownerUserId), name, section,
    template: templateId,
    protocol, baseUrl,
    registrationUrl: definition.registrationUrl || publicHttps(input.registrationUrl ?? existing?.registration_url ?? '', 'invalid_ai_registration_url', { allowEmpty: true }),
    documentationUrl: definition.documentationUrl || publicHttps(input.documentationUrl ?? existing?.documentation_url ?? '', 'invalid_ai_documentation_url', { allowEmpty: true }),
    model, capabilities, timeoutMs, enabled: hasCredential && input.enabled !== false, allowSubaccounts: input.allowSubaccounts === true,
    encryptedApiKey: apiKey ? encryptValue(apiKey, key, `wyerp:${tenantId}:${ownerUserId}:ai:${id}`) : existingCredential || null
  };
}
function redact(row, hideEndpoint = false) {
  let baseUrl = row.base_url ?? row.baseUrl ?? '';
  if (hideEndpoint) { try { baseUrl = new URL(baseUrl).origin; } catch (_) { baseUrl = ''; } }
  return { id: String(row.id), name: row.name, section: row.section, template: row.template, protocol: row.protocol, baseUrl, registrationUrl: row.published_invitation_url || row.registration_url || row.registrationUrl || '', registrationSource: row.published_invitation_url ? 'administrator-invitation' : 'official', documentationUrl: row.documentation_url ?? row.documentationUrl ?? '', model: row.model, capabilities: row.capabilities, groups: groupsForCapabilities(row.capabilities), supportsVideo: (row.capabilities || []).includes(VIDEO_CAPABILITY), timeoutMs: row.timeout_ms ?? row.timeoutMs ?? 30000, enabled: row.enabled, allowSubaccounts: row.allow_subaccounts ?? row.allowSubaccounts, credentialsConfigured: Boolean(row.encrypted_api_key ?? row.encryptedApiKey), testedAt: row.tested_at ?? row.testedAt ?? null, testKind: row.test_kind ?? row.testKind ?? null, testStatus: row.test_status ?? row.testStatus ?? 'untested', defaultCapabilities: row.default_capabilities || row.defaultCapabilities || [], preferredCapabilities: row.preferred_capabilities || row.preferredCapabilities || [] };
}
function exportTemplate(row) {
  const value = redact(row);
  const definition = TEMPLATE_DEFINITIONS[value.template];
  return { name: value.name, section: value.section, template: value.template, protocol: value.protocol, baseUrl: value.baseUrl, registrationUrl: definition?.registrationUrl || value.registrationUrl, documentationUrl: definition?.documentationUrl || value.documentationUrl, model: value.model, capabilities: value.capabilities, timeoutMs: value.timeoutMs, allowSubaccounts: value.allowSubaccounts, enabled: value.enabled };
}
function template(id) { const value = TEMPLATE_DEFINITIONS[id]; if (!value) throw fail('ai_template_not_found', 'AI 配置模板不存在', 404); return JSON.parse(JSON.stringify({ id, ...value })); }
function decrypt(row, key) { if (!row?.encrypted_api_key) throw fail('ai_configuration_missing_key', '所选配置尚未填写 API 密钥', 409); return decryptValue(row.encrypted_api_key, key, `wyerp:${row.tenant_id}:${row.owner_user_id}:ai:${row.id}`); }

module.exports = { normalize, redact, exportTemplate, template, modelForCapability, publicHttps, decrypt, fail, grsaiModels, grsaiModel, groupsForCapabilities, GRS_BASE_URL, GRS_TEXT_PROTOCOL, GRS_IMAGE_PROTOCOL, PRODUCT_CAPABILITIES, IMAGE_CAPABILITIES, VIDEO_CAPABILITY, CAPABILITY_GROUPS, GROUP_LABELS, TEMPLATE_DEFINITIONS };