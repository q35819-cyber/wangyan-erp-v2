'use strict';
/* Client-only safe declaration parser: JSON, JSON in markdown fences, restricted
   `export default <JSON>`, or OpenAI-compatible curl. NEVER eval imported text. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.wyerpAiQuickImport = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const MAX_CHARS = 60000;
  const MAX_PROVIDERS = 10;
  const TEXT = ['product-translation', 'title-optimization', 'description-optimization', 'selling-point-generation', 'attribute-text-optimization'];
  const IMAGE = ['image-translation', 'image-redraw', 'image-repair'];
  const fail = message => { throw new Error(message); };
  function parseJson(raw) {
    const input = String(raw || '').trim();
    const fenced = /^```(?:json|javascript|typescript|ts|js)?\s*([\s\S]*?)\s*```$/i.exec(input);
    let text = fenced ? fenced[1].trim() : input;
    if (/^export\s+default\s+/i.test(text)) text = text.replace(/^export\s+default\s+/i, '').replace(/;\s*$/, '').trim();
    if (/^(?:const|let|var)\s+/.test(text)) fail('仅接受 JSON 配置对象；请让 AI 输出 export default 后跟严格 JSON，不能包含可执行脚本');
    try { return JSON.parse(text); }
    catch (_) { fail('配置不是有效 JSON。代码模式支持 export default 加严格 JSON 对象，不执行 TypeScript/JavaScript 函数'); }
  }
  function parseCurl(text) {
    const urlMatch = /https:\/\/[^\s"'\\]+/i.exec(text);
    if (!urlMatch) fail('cURL 中没有公开 HTTPS 接口地址');
    let full;
    try { full = new URL(urlMatch[0]); }
    catch (_) { fail('cURL 接口地址无效'); }
    const suffix = /\/(?:chat\/completions|images\/edits)$/i;
    if (!suffix.test(full.pathname)) fail('仅识别 OpenAI 兼容的 /chat/completions 或 /images/edits 请求示例');
    const image = /\/images\/edits$/i.test(full.pathname);
    const baseUrl = full.origin + full.pathname.replace(suffix, '');
    const token = /\bBearer\s+([^\s"'\\]+)/i.exec(text)?.[1] || '';
    let model = '';
    const modelMatch = /["']model["']\s*:\s*["']([^"']+)["']/i.exec(text);
    if (modelMatch) model = modelMatch[1];
    return { providers: [{
      name: image ? 'cURL 图片模型' : 'cURL 文本模型',
      type: image ? 'image' : 'text', baseUrl, apiKey: token,
      model, default: true
    }] };
  }
  function cleanProvider(item, i) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('第' + (i + 1) + '条平台配置不是对象');
    const type = String(item.type || item.section || '').trim().toLowerCase();
    const section = type === 'text' || type === 'product' ? 'product' : type === 'image' ? 'image' : '';
    if (!section) fail('第' + (i + 1) + '条配置类型必须是 text 或 image');
    const name = String(item.name || '').trim();
    const baseUrl = String(item.baseUrl || item.base_url || item.url || '').trim();
    const model = typeof item.model === 'string' ? item.model.trim() : String(item.model?.name || item.modelId || '').trim();
    const apiKey = String(item.apiKey || item.api_key || item.key || '').trim();
    if (!name || name.length > 120 || !model || model.length > 160 || !apiKey || apiKey.length > 8192) fail('第' + (i + 1) + '条请填写名称、模型ID和密钥（长度须符合要求）');
    if (/[\u0000-\u001f]/.test(name + model) || /\s/.test(model)) fail('第' + (i + 1) + '条模型ID含非法空白或控制字符');
    let url;
    try { url = new URL(baseUrl); }
    catch (_) { fail('第' + (i + 1) + '条API地址不合法'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) fail('第' + (i + 1) + '条API地址必须是无凭据、无查询参数的HTTPS地址');
    const normalizedUrl = url.toString().replace(/\/$/, '');
    return Object.freeze({
      name, section, baseUrl: normalizedUrl, model, apiKey,
      enabled: item.enabled !== false, makeDefault: item.default !== false,
      template: section === 'product' ? 'custom-product' : 'custom-image',
      protocol: section === 'product' ? 'openai-chat-completions' : 'openai-image',
      capabilities: section === 'product' ? [...TEXT] : [...IMAGE]
    });
  }
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw || raw.length > MAX_CHARS) fail('请粘贴不超过60,000字的配置');
    const container = /^(?:curl(?:\.exe)?\s)/i.test(raw) ? parseCurl(raw) : parseJson(raw);
    const items = Array.isArray(container) ? container
      : Array.isArray(container?.providers) ? container.providers : [container];
    if (items.length < 1 || items.length > MAX_PROVIDERS) fail('每次最多导入10条AI模型配置');
    const normalized = items.map(cleanProvider);
    if (new Set(normalized.map(row => row.name)).size !== normalized.length) fail('配置中有重复名称，请先去重');
    return normalized;
  }
  function publicPreview(item) {
    return {
      name: item.name, type: item.section === 'product' ? '文本' : '图片',
      baseUrl: item.baseUrl, model: item.model, key: '已填写（不回显）',
      default: item.makeDefault
    };
  }
  return Object.freeze({ parse, publicPreview, MAX_CHARS, MAX_PROVIDERS });
});