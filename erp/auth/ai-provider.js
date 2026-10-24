'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { modelForCapability, grsaiModel } = require('./ai-config');
const vendorAdapter = require('./ai-vendor-adapter');

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
const SOURCE_IMAGE_TYPES = Object.freeze({ ...IMAGE_TYPES, 'image/bmp': 'bmp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif' });
function fail(code, message, status = 502) { return Object.assign(new Error(message), { publicCode: code, status }); }
function rejection(status, action = '请求') {
  if (status === 401 || status === 403) return fail('ai_authentication_failed', `AI ${action}认证失败`);
  if (status === 402) return fail('ai_balance_insufficient', `AI ${action}余额不足`);
  if (status === 404) return fail('ai_model_not_found', `AI ${action}模型不存在`);
  if (status === 422) return fail('ai_content_rejected', `AI ${action}内容被拒绝`);
  if (status === 429) return fail('ai_rate_limited', `AI ${action}触发限流`);
  return fail('ai_provider_rejected', `AI 服务拒绝本次${action}`);
}
function safeHostname(hostname) { return String(hostname || '').toLowerCase().replace(/\.$/, ''); }
function proxyDnsAddress(address) {
  if (!net.isIPv4(address)) return false;
  const b = address.split('.').map(Number);
  return b[0] === 198 && (b[1] === 18 || b[1] === 19) || b[0] === 100 && b[1] >= 64 && b[1] <= 127;
}
function privateIp(address) {
  if (net.isIPv4(address)) {
    const b = address.split('.').map(Number);
    return b[0] === 0 || b[0] === 10 || b[0] === 127 || b[0] === 169 && b[1] === 254 || b[0] === 172 && b[1] >= 16 && b[1] <= 31 ||
      b[0] === 100 && b[1] >= 64 && b[1] <= 127 || b[0] === 192 && (b[1] === 168 || b[1] === 0 || b[1] === 2) ||
      b[0] === 198 && (b[1] === 18 || b[1] === 19 || b[1] === 51 && b[2] === 100) ||
      b[0] === 203 && b[1] === 0 && b[2] === 113 || b[0] >= 224;
  }
  const value = String(address).toLowerCase().split('%')[0];
  if (!net.isIPv6(value)) return true;
  return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:') || /^::ffff:(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(value);
}
function addressClass(address) {
  if (proxyDnsAddress(address)) return 'proxy_fake_ip';
  return privateIp(address) ? 'protected' : net.isIP(String(address || '')) ? 'public' : 'invalid';
}
async function resolvePublic(hostname, lookup = dns.lookup) {
  let addresses;
  try { addresses = await lookup(hostname, { all: true, verbatim: true }); } catch (_) { throw fail('ai_provider_unreachable', 'AI 服务地址无法解析'); }
  if (!Array.isArray(addresses)) addresses = [addresses];
  if (!addresses.length || addresses.some(item => !item || !net.isIP(String(item.address || '')))) throw fail('ai_provider_unreachable', 'AI 服务地址无法解析');
  return addresses;
}
function safeHostname(hostname) { return String(hostname || '').toLowerCase().replace(/\.$/, ''); }
function proxyDnsAddress(address) {
  if (!net.isIPv4(address)) return false;
  const b = address.split('.').map(Number);
  return b[0] === 198 && (b[1] === 18 || b[1] === 19) || b[0] === 100 && b[1] >= 64 && b[1] <= 127;
}
function addressClass(address) {
  if (proxyDnsAddress(address)) return 'proxy_fake_ip';
  return privateIp(address) ? 'protected' : net.isIP(String(address || '')) ? 'public' : 'invalid';
}
async function ensurePublicUrl(value, lookup = dns.lookup) {
  let url;
  try { url = new URL(value); } catch (_) { throw fail('invalid_ai_base_url', 'AI服务地址无效', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('invalid_ai_base_url', 'AI服务地址必须为公开HTTPS地址', 400);
  await resolvePublic(url.hostname, lookup);
  return url;
}
function stripJsonFence(value) {
  const text = String(value || '').trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? match[1].trim() : text;
}
function parseJsonBuffer(buffer, limit = MAX_RESPONSE_BYTES) {  if (buffer.length > limit) throw fail('ai_response_too_large', 'AI 返回内容过大');
  try { return JSON.parse(buffer.toString('utf8')); } catch (_) { throw fail('ai_response_invalid', 'AI 返回格式无效'); }
}
async function readJson(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > limit) throw fail('ai_response_too_large', 'AI 返回内容过大');
  return parseJsonBuffer(Buffer.from(await response.arrayBuffer()), limit);
}
async function secureJsonRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, lookup = dns.lookup, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw fail('invalid_ai_base_url', 'AI服务地址必须为公开HTTPS地址', 400);
  return new Promise((resolve, reject) => {
    const req = https.request(target, {
      method, headers, timeout: Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 180000),
      lookup(hostname, options, callback) {
        Promise.resolve(resolvePublic(hostname, lookup)).then(addresses => {
          // Node 按 options.all 决定期望的回调形状：all=true 必须回数组，否则回单个地址+族。
          if (options && options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }, callback);
      }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); return reject(fail('ai_redirect_denied', 'AI 服务重定向已被拒绝')); }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > maxResponseBytes) req.destroy(fail('ai_response_too_large', 'AI 返回内容过大')); else chunks.push(chunk); });
      response.on('end', () => {
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        if (!ok) return resolve({ ok, status: response.statusCode, headers: response.headers, payload: {} });
        try { resolve({ ok, status: response.statusCode, headers: response.headers, payload: parseJsonBuffer(Buffer.concat(chunks), maxResponseBytes) }); } catch (error) { reject(error); }
      });
    });
    req.on('timeout', () => req.destroy(fail('ai_timeout', 'AI 请求超时，未修改商品草稿')));
    req.on('error', error => reject(error.publicCode ? error : fail('ai_provider_unreachable', 'AI 服务连接失败')));
    if (body) req.write(body);
    req.end();
  });
}
async function requestJson(url, options, fetchImpl, lookup) {
  if (!fetchImpl) return secureJsonRequest(url, { ...options, lookup });
  await ensurePublicUrl(url, lookup);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetchImpl(url, { method: options.method, redirect: 'error', signal: controller.signal, headers: options.headers, body: options.body });
    return { ok: response.ok, status: response.status, payload: response.ok ? await readJson(response, options.maxResponseBytes || MAX_RESPONSE_BYTES) : {} };
  } catch (error) {
    if (error.name === 'AbortError') throw fail('ai_timeout', 'AI 请求超时，未修改商品草稿');
    throw error;
  } finally { clearTimeout(timer); }
}
function redactSecrets(value, apiKey) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  text = String(text || '').replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-***').replace(/(apikey=)[^&"'\s]+/gi, '$1***');
  const key = String(apiKey || '');
  if (key) text = text.split(key).join('sk-***');
  return text.length > 4000 ? text.slice(0, 4000) + '…（已截断）' : text;
}
function traceExchange(list, entry) { if (Array.isArray(list) && list.length < 40) list.push(entry); }
function providerRequestId(payload) {
  const value = payload?.requestId ?? payload?.request_id ?? payload?.taskId ?? payload?.task_id ?? payload?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 180) : 'unavailable';
}
function setChatDiagnostic(target, values) {
  if (target && typeof target === 'object' && !Array.isArray(target)) Object.assign(target, values);
}
function diagnosticError(error) { return String(error && (error.publicCode || error.message) || 'ai_provider_failed').slice(0, 120); }
async function chat({ configuration, apiKey, system, input, capabilities = ['product-translation'], fetchImpl, lookup, timeoutMs, trace, diagnostic }) {
  if (!configuration || !apiKey || !['openai-chat-completions', 'grsai-gemini-generate', 'custom-structured'].includes(configuration.protocol)) throw fail('ai_configuration_unavailable', '所选商品优化配置不可用', 409);
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  const resolvedModels = capabilities.map(capability => modelForCapability(configuration.model, capability));
  if (resolvedModels.some(model => !model)) throw fail('ai_configuration_unavailable', '所选配置没有可用模型', 409);
  const models = Array.from(new Set(resolvedModels));
  if (models.length > 1) throw fail('ai_multiple_models_required', '本次字段需要不同模型，请分开生成候选', 409);
  const model = models[0];
  setChatDiagnostic(diagnostic, { actualModel: model, protocol: configuration.protocol });
  if (configuration.protocol === 'custom-structured') {
    const run = await vendorAdapter.call({ configuration, apiKey, adapter:configuration.model.adapter, vars: { model, system, inputJson: JSON.stringify(input), prompt: String(input?.prompt || ''), image: '', images: [], mask: '', taskId: '' }, requestJson, fetchImpl, lookup });
    const value = vendorAdapter.pathValue(run.data, run.response.textPath);
    if (typeof value !== 'string' || !value.trim()) throw fail('ai_response_invalid', '供应商响应中没有文本结果');
    return value.trim();
  }
  if (configuration.protocol === 'grsai-gemini-generate') {
    const geminiTarget = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const geminiBody = { contents: [{ role: 'user', parts: [{ text: `${system}\n\n${JSON.stringify(input)}` }] }], generationConfig: {} };
    let result;
    try {
      result = await requestJson(geminiTarget, {
        method: 'POST', timeoutMs: Math.min(Number(timeoutMs || configuration.timeout_ms) || 30000, 180000),
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      }, fetchImpl, lookup);
    } catch (error) { setChatDiagnostic(diagnostic, { httpSucceeded: false, httpStatus: 0, providerRequestId: 'unavailable', errorCode: diagnosticError(error) }); throw error; }
    setChatDiagnostic(diagnostic, { httpSucceeded: result.ok === true, httpStatus: Number(result.status) || 0, providerRequestId: providerRequestId(result.payload) });
    traceExchange(trace, { kind: '文字模型请求', method: 'POST', url: geminiTarget, request: redactSecrets(geminiBody, apiKey), status: result.status, response: redactSecrets(result.payload, apiKey) });
    if (!result.ok) throw rejection(result.status);
    const candidate = result.payload?.candidates?.[0];
    if (String(candidate?.finishReason || 'STOP').toUpperCase() !== 'STOP') throw fail('ai_content_rejected', 'AI 请求内容被拒绝');
    const text = (candidate?.content?.parts || []).map(part => String(part?.text || '')).join('').trim();
    if (!text) throw fail('ai_response_invalid', 'AI 未返回候选内容');
    return stripJsonFence(text);
  }
  let result;
  try {
    result = await requestJson(base + '/chat/completions', {
      method: 'POST', timeoutMs: Math.min(Number(timeoutMs || configuration.timeout_ms) || 30000, 30000),
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }], temperature: 0.2, response_format: { type: 'json_object' } })
    }, fetchImpl, lookup);
  } catch (error) { setChatDiagnostic(diagnostic, { httpSucceeded: false, httpStatus: 0, providerRequestId: 'unavailable', errorCode: diagnosticError(error) }); throw error; }
  setChatDiagnostic(diagnostic, { httpSucceeded: result.ok === true, httpStatus: Number(result.status) || 0, providerRequestId: providerRequestId(result.payload) });
  if (!result.ok) throw rejection(result.status);
  if (result.payload?.choices?.[0]?.finish_reason === 'content_filter') throw fail('ai_content_rejected', 'AI 请求内容被拒绝');
  const content = result.payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw fail('ai_response_invalid', 'AI 未返回候选内容');
  return content.trim();
}
function grsaiMessage(payload, apiKey) {
  const raw = String(payload?.msg || payload?.data?.error || '').slice(0, 120).replace(/sk-[A-Za-z0-9]+/g, 'sk-***');
  const key = String(apiKey || '');
  return key ? raw.split(key).join('sk-***') : raw;
}
function grsaiRejected(payload, apiKey, action) {
  const message = grsaiMessage(payload, apiKey);
  return fail('ai_provider_rejected', `GRS AI ${action}未通过${message ? '：' + message : ''}`);
}
async function testConnection({ configuration, apiKey, fetchImpl, lookup }) {
  if (!configuration || !apiKey) throw fail('ai_configuration_unavailable', 'AI 配置不可用', 409);
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  const timeoutMs = configuration.timeout_ms || 10000;
  if (configuration.protocol === 'custom-structured') throw fail('ai_connection_test_unsupported', '可编程适配器无法保证有免费的连接探针；请使用明确确认收费风险的功能测试', 409);
  if (String(configuration.template || '').startsWith('grsai-')) {
    // GRS AI 的 getModelStatus 免密钥，只证明模型存在；密钥是否有效必须再用 getCredits 验证。
    const models = Array.from(new Set((configuration.capabilities || []).map(capability => modelForCapability(configuration.model, capability)).filter(Boolean)));
    if (!models.length) throw fail('ai_configuration_unavailable', '所选配置没有可用模型', 409);
    const origin = new URL(base).origin;
    const credits = await requestJson(origin + '/client/common/getCredits?apikey=' + encodeURIComponent(apiKey), { method: 'GET', timeoutMs, headers: {} }, fetchImpl, lookup);
    if (!credits.ok) throw rejection(credits.status, '密钥校验');
    if (Number(credits.payload?.code) !== 0) throw fail('ai_authentication_failed', `GRS AI 密钥无效：${grsaiMessage(credits.payload, apiKey)}`);
    const checked = [];
    for (const model of models) {
      const status = await requestJson(origin + '/client/common/getModelStatus?model=' + encodeURIComponent(model), { method: 'GET', timeoutMs, headers: { Authorization: 'Bearer ' + apiKey } }, fetchImpl, lookup);
      if (!status.ok) throw rejection(status.status, '模型校验');
      if (Number(status.payload?.code) !== 0 || status.payload?.data?.status !== true) throw fail('ai_model_not_found', `GRS AI 模型 ${model} 不可用：${grsaiMessage(status.payload, apiKey)}`);
      checked.push(model);
    }
    const rawCredits = credits.payload?.data?.credits ?? credits.payload?.data?.balance ?? credits.payload?.credits ?? (typeof credits.payload?.data === 'number' ? credits.payload.data : null);
    return { ok: true, kind: 'connection', models: checked, credits: Number.isFinite(Number(rawCredits)) ? Number(rawCredits) : null };
  }
  let result;
  if (configuration.protocol === 'openai-chat-completions' || configuration.protocol === 'openai-image' || configuration.protocol === 'dashscope-native') {
    result = await requestJson(base + '/models', { method: 'GET', timeoutMs, headers: { Authorization: 'Bearer ' + apiKey } }, fetchImpl, lookup);
  } else {
    throw fail('ai_connection_test_unsupported', '该协议没有可用的免费连接测试', 409);
  }
  if (!result.ok) throw rejection(result.status, '连接测试');
  return { ok: true, kind: 'connection' };
}
async function getCredits({ configuration, apiKey, fetchImpl, lookup }) {
  if (!configuration || !apiKey || !String(configuration.template || '').startsWith('grsai-')) throw fail('ai_configuration_unavailable', 'GRS AI 配置不可用', 409);
  const origin = new URL(String(configuration.base_url || configuration.baseUrl || '')).origin;
  const result = await requestJson(origin + '/client/common/getCredits?apikey=' + encodeURIComponent(apiKey), { method: 'GET', timeoutMs: configuration.timeout_ms || 10000, headers: {} }, fetchImpl, lookup);
  if (!result.ok) throw rejection(result.status, '积分查询');
  if (Number(result.payload?.code) !== 0) throw fail('ai_authentication_failed', `GRS AI 密钥无效：${grsaiMessage(result.payload, apiKey)}`);
  const raw = result.payload?.credits ?? result.payload?.data?.credits ?? result.payload?.data?.balance ?? result.payload?.balance ?? (typeof result.payload?.data === 'number' ? result.payload.data : null);
  if (raw === null || raw === '' || typeof raw === 'boolean') throw fail('ai_response_invalid', 'GRS AI 积分返回格式无效');
  const credits = Number(raw);
  if (!Number.isFinite(credits)) throw fail('ai_response_invalid', 'GRS AI 积分返回格式无效');
  return { credits };
}
async function functionalTest({ configuration, apiKey, confirmed, fetchImpl, lookup, maxWaitMs = 300000, pollIntervalMs = 10000, trace }) {
  if (confirmed !== true) throw fail('ai_paid_test_confirmation_required', '功能测试会向供应商发起真实请求并可能产生费用，请先明确确认', 409);
  if (!configuration || !apiKey) throw fail('ai_configuration_unavailable', 'AI 配置不可用', 409);
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  const timeoutMs = Math.min(Number(configuration.timeout_ms) || 30000, 180000);
  if (configuration.section === 'product') {
    // 用户定义的通过标准：给文字模型发送“你好”，能收到回复即完成。
    const content = await chat({ configuration, apiKey, system: '这是 AI 连通性测试，请用一句简短中文回复，不要输出其他内容。', input: { message: '你好' }, capabilities: [configuration.capabilities?.[0] || 'title-optimization'], fetchImpl, lookup, timeoutMs, trace });
    if (!content.trim()) throw fail('ai_response_invalid', 'AI 文字模型没有返回回复');
    return { ok: true, kind: 'functional', resultType: 'text-reply', model: modelForCapability(configuration.model, configuration.capabilities?.[0] || 'title-optimization'), replyChars: content.trim().length };
  }
  if (configuration.protocol === 'custom-structured') {
    // Paid functional test uses a synthetic one-pixel image, never a customer asset.
    const sample='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxI8AAAAASUVORK5CYII=';
    const submitted=await submitImage({configuration,apiKey,input:{capability:'image-redraw',image:sample,prompt:'检测图片接口：请返回一张简单的测试图'},fetchImpl,lookup,timeoutMs});
    const model=modelForCapability(configuration.model,'image-redraw');
    if (submitted.state === 'succeeded') return {ok:true,kind:'functional',resultType:'image-generated',model,capability:'image-redraw'};
    if(!submitted.taskId||!configuration.model?.adapter?.poll)throw fail('ai_image_result_pending','适配器没有可验证的图片结果或任务轮询协议',409);
    let elapsed=0;
    while(elapsed<maxWaitMs){
      await new Promise(done=>setTimeout(done,pollIntervalMs));
      elapsed+=pollIntervalMs;
      const result=await pollImage({configuration,apiKey,taskId:submitted.taskId,fetchImpl,lookup});
      if(result.state==='succeeded')return {ok:true,kind:'functional',resultType:'image-generated',model,capability:'image-redraw'};
      if(result.state==='failed')throw fail('ai_image_generate_failed','供应商报告生成失败');
    }
    throw fail('ai_image_result_pending','自定义图片供应商超时，无法确认结果',504);
  }
  const model = modelForCapability(configuration.model, 'image-redraw');
  if (!grsaiModel('image', model)) throw fail('invalid_ai_model', 'GRS AI 图片模型不在内置清单中，请重新选择', 400);
  // 用户定义的通过标准：给图片模型一个文生图提示词，能收到生成结果即完成。
  const generateUrl = base + '/v1/api/generate';
  const generateBody = { model, prompt: '功能测试：白色背景上放着一只纯色无图案的方形色块，不含文字与商品', images: [], aspectRatio: '1:1', replyType: 'async' };
  const result = await requestJson(generateUrl, {
    method: 'POST', timeoutMs, headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(generateBody)
  }, fetchImpl, lookup);
  traceExchange(trace, { kind: '图片模型请求', method: 'POST', url: generateUrl, request: redactSecrets(generateBody, apiKey), status: result.status, response: redactSecrets(result.payload, apiKey) });
  if (!result.ok) throw rejection(result.status, '图片功能测试');
  const submitted = grsaiImageResult(result.payload, model, 'image-redraw');
  if (submitted.state === 'succeeded') {
    traceExchange(trace, { kind: '图片结果', method: '-', url: '', request: '无需轮询，直接返回结果', status: 200, response: redactSecrets({ status: 'succeeded', resultUrl: submitted.resultUrl }, apiKey) });
    return { ok: true, kind: 'functional', resultType: 'image-generated', model, capability: 'image-redraw' };
  }
  // 上游生成通常需数十秒：按任务号轮询，每 10 秒一次、最长 5 分钟，拿不到成功状态与图片地址一律不算通过。
  let waited = 0;
  while (waited < maxWaitMs) {
    await new Promise(done => setTimeout(done, pollIntervalMs));
    waited += pollIntervalMs;
    const polled = await pollImage({ configuration, apiKey, taskId: submitted.taskId, fetchImpl, lookup });
    traceExchange(trace, { kind: '异步查询 #' + Math.round(waited / pollIntervalMs), method: 'GET', url: base + '/v1/api/result?id=' + submitted.taskId, request: '任务号 ' + submitted.taskId, status: 200, response: redactSecrets({ status: polled.state, progress: polled.progress || 0, resultUrl: polled.resultUrl || '' }, apiKey) });
    if (polled.state === 'succeeded') return { ok: true, kind: 'functional', resultType: 'image-generated', model, capability: 'image-redraw', progress: polled.progress || 100 };
    if (polled.state === 'failed') throw fail('ai_image_generate_failed', 'AI 图片生成失败，本次没有候选结果');
  }
  throw fail('ai_image_result_pending', '等待 GRS AI 图片结果超时，本次未确认生成成功', 504);
}

function imageData(value, field = '图片') {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ''));
  if (!match) throw fail('invalid_ai_image', `${field}必须为JPEG、PNG或WEBP图片`, 400);
  const body = Buffer.from(match[2], 'base64');
  if (!body.length || body.length > MAX_IMAGE_INPUT_BYTES) throw fail('invalid_ai_image', `${field}大小必须在10 MiB以内`, 400);
  const valid = match[1] === 'png' ? body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'jpeg' ? body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : body.length >= 12 && body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw fail('invalid_ai_image', `${field}文件头与格式不匹配`, 400);
  return { dataUrl: String(value), body, mime: 'image/' + match[1], extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
}
function imageRequest(input) {
  const capability = String(input?.capability || '');
  if (!['image-translation', 'image-redraw', 'image-repair'].includes(capability)) throw fail('invalid_ai_image_capability', '不支持的AI图片能力', 400);
  const source = imageData(input.image, '原图');
  const prompt = String(input.prompt || '').trim();
  if (capability !== 'image-translation' && (!prompt || prompt.length > 8000)) throw fail('invalid_ai_image_prompt', '图片提示词长度必须为1-8000', 400);
  const mask = input.mask ? imageData(input.mask, '蒙版') : null;
  if (capability === 'image-repair' && !mask) throw fail('invalid_ai_image_mask', '局部修复必须提供蒙版', 400);
  const references = capability === 'image-redraw' && Array.isArray(input.referenceImages)
    ? input.referenceImages.slice(0, 7).map((item, index) => imageData(item, '组合参考图' + (index + 1))).filter(item => item.dataUrl !== source.dataUrl)
    : [];
  const sourceLanguage = String(input.sourceLanguage || 'auto').toLowerCase();
  const targetLanguage = String(input.targetLanguage || 'ru').toLowerCase();
  if (!/^[a-z-]{2,12}$/.test(sourceLanguage) || !/^[a-z-]{2,12}$/.test(targetLanguage)) throw fail('invalid_ai_image_language', '图片翻译语言代码不正确', 400);
  const raw = input.options && typeof input.options === 'object' && !Array.isArray(input.options) ? input.options : {};
  const options = {};
  for (const key of ['aspectRatio', 'imageSize', 'quality', 'background']) if (typeof raw[key] === 'string' && raw[key].trim()) options[key] = raw[key].trim();
  return { capability, source, mask, references, prompt, sourceLanguage, targetLanguage, options };
}
const GRS_IMAGE_OPTION_FIELDS = Object.freeze({ aspectRatio: 'aspectRatios', imageSize: 'imageSizes', quality: 'qualities', background: 'backgrounds' });
const GRS_IMAGE_OPTION_LABELS = Object.freeze({ aspectRatio: '比例', imageSize: '分辨率', quality: '质量', background: '背景' });
function grsaiImageParams(model, options) {
  const definition = grsaiModel('image', model);
  if (!definition) throw fail('invalid_ai_model', 'GRS AI 图片模型不在内置清单中，请重新选择模型', 400);
  const params = {};
  for (const [key, field] of Object.entries(GRS_IMAGE_OPTION_FIELDS)) {
    const value = options?.[key];
    if (value === undefined) continue;
    const allowed = key === 'aspectRatio' ? [...(definition.aspectRatios || []), ...(definition.pixelSizes || [])] : definition[field] || [];
    if (!allowed.includes(value)) throw fail('invalid_ai_image_option', `GRS AI 模型 ${model} 不支持该${GRS_IMAGE_OPTION_LABELS[key]}参数`, 400);
    params[key] = value;
  }
  return params;
}
function grsaiImageResult(payload, model, capability) {
  const status = String(payload?.status || '').toLowerCase();
  if (status === 'violation') throw fail('ai_content_rejected', 'AI 图片内容被供应商拒绝，请调整提示词或图片');
  if (status === 'failed') throw fail('ai_image_generate_failed', 'AI 图片生成失败，本次没有候选结果');
  const resultUrl = Array.isArray(payload?.results) ? String(payload.results[0]?.url || '') : '';
  if (resultUrl) return { state: 'succeeded', taskId: payload?.id ? String(payload.id) : null, resultUrl, protocol: 'grsai-generate', model, capability, progress: Number(payload?.progress) || 100 };
  if (payload?.id) return { state: 'submitted', taskId: String(payload.id), resultUrl: null, protocol: 'grsai-generate', model, capability, progress: Number(payload?.progress) || 0 };
  throw fail('ai_response_invalid', 'AI图片服务未返回任务或候选结果');
}
function multipart(fields, files) {
  const boundary = '----wyerp-' + require('node:crypto').randomBytes(12).toString('hex');
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  for (const [name, file] of Object.entries(files)) if (file) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}.${file.extension}"\r\nContent-Type: ${file.mime}\r\n\r\n`), file.body, Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}
async function submitImage({ configuration, apiKey, input, fetchImpl, lookup, timeoutMs, diagnostic }) {
  if (!configuration || configuration.section !== 'image' || !apiKey) throw fail('ai_configuration_unavailable', '所选AI图片配置不可用', 409);
  const checked = imageRequest(input);
  if (!configuration.capabilities?.includes(checked.capability)) throw fail('ai_configuration_unavailable', '配置不支持此图片能力', 409);
  const model = modelForCapability(configuration.model, checked.capability);
  if (!model) throw fail('ai_configuration_unavailable', '所选配置没有对应图片模型', 409);
  setChatDiagnostic(diagnostic, { actualModel: model, protocol: configuration.protocol });
  if (configuration.protocol === 'custom-structured') {
    const images = [checked.source.dataUrl,...(checked.references || []).map(x=>x.dataUrl)].slice(0,8);
    const run = await vendorAdapter.call({configuration,apiKey,adapter:configuration.model.adapter,vars:{model,system:'',inputJson:'',prompt:checked.prompt||'',image:checked.source.dataUrl,images,mask:checked.mask?.dataUrl||'',taskId:''},requestJson,fetchImpl,lookup});
    return {...vendorAdapter.imageResult(run.data,run.response),protocol:configuration.protocol,model,capability:checked.capability};
  }
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  let target; let body; const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
  if (configuration.protocol === 'dashscope-native') {
    target = base + '/services/aigc/image2image/image-synthesis';
    const translation = checked.capability === 'image-translation';
    if (!translation) headers['X-DashScope-Async'] = 'enable';
    body = JSON.stringify({ model, input: translation ? { image_url: checked.source.dataUrl, source_lang: checked.sourceLanguage, target_lang: checked.targetLanguage } : { function: checked.capability === 'image-repair' ? 'description_edit_with_mask' : 'description_edit', prompt: checked.prompt, base_image_url: checked.source.dataUrl, ...(checked.mask ? { mask_image_url: checked.mask.dataUrl } : {}) }, ...(translation ? {} : { parameters: { n: 1 } }) });
  } else if (configuration.protocol === 'grsai-generate') {
    // GRS AI 图片/视频生成接口：POST /v1/api/generate；本阶段用 replyType=json 同步取结果。
    if (!grsaiModel('image', model)) throw fail('invalid_ai_model', 'GRS AI 图片模型不在内置清单中，请重新选择模型', 400);
    target = base + '/v1/api/generate';
    body = JSON.stringify({
      model, prompt: checked.prompt || `将图片中的${checked.sourceLanguage}文字翻译为${checked.targetLanguage}文字，保持版式、颜色、位置和商品主体不变，只替换文字内容。`,
      images: checked.mask ? [checked.source.dataUrl, checked.mask.dataUrl] : [checked.source.dataUrl].concat(checked.references.map(item => item.dataUrl)).slice(0, 8),
      ...grsaiImageParams(model, checked.options), replyType: 'json'
    });
  } else if (configuration.protocol === 'openai-image') {
    target = base + '/images/edits';
    const encoded = multipart({ model, prompt: checked.prompt || `Translate image text from ${checked.sourceLanguage} to ${checked.targetLanguage}`, n: '1' }, { image: checked.source, mask: checked.mask });
    body = encoded.body; headers['Content-Type'] = encoded.contentType;
  } else throw fail('ai_configuration_unavailable', '所选协议不支持AI图片', 409);
  let result;
  try {
    result = await requestJson(target, { method: 'POST', timeoutMs: Math.min(Number(timeoutMs || configuration.timeout_ms || configuration.timeoutMs) || 30000, 180000), headers, body,
      maxResponseBytes: configuration.protocol === 'openai-image' ? 15 * 1024 * 1024 : MAX_RESPONSE_BYTES }, fetchImpl, lookup);
  } catch (error) { setChatDiagnostic(diagnostic, { httpSucceeded: false, httpStatus: 0, providerRequestId: 'unavailable', errorCode: diagnosticError(error) }); throw error; }
  setChatDiagnostic(diagnostic, { httpSucceeded: result.ok === true, httpStatus: Number(result.status) || 0, providerRequestId: providerRequestId(result.payload) });
  if (!result.ok) throw rejection(result.status, '图片功能请求');
  if (configuration.protocol === 'grsai-generate') return grsaiImageResult(result.payload, model, checked.capability);
  const taskId = result.payload?.output?.task_id || result.payload?.task_id || result.payload?.id || null;
  const resultUrl = result.payload?.output?.image_url || result.payload?.data?.[0]?.url || (result.payload?.data?.[0]?.b64_json ? 'data:image/png;base64,' + result.payload.data[0].b64_json : null);
  if (!taskId && !resultUrl) throw fail('ai_response_invalid', 'AI图片服务未返回任务或候选结果');
  return { state: resultUrl ? 'succeeded' : 'submitted', taskId: taskId && String(taskId), resultUrl: resultUrl && String(resultUrl), protocol: configuration.protocol, model, capability: checked.capability };
}
async function generateImage({ configuration, apiKey, input, fetchImpl, lookup }) {
  if (configuration?.protocol === 'custom-structured') {
    if (configuration.section !== 'image' || !apiKey) throw fail('ai_configuration_unavailable', '自定义图片配置不可用', 409);
    const prompt=String(input?.prompt||'').trim();
    if(!prompt||prompt.length>8000)throw fail('invalid_ai_image_prompt','图片提示词长度必须为1-8000',400);
    const capability=String(input.capability||'image-redraw');
    if(!configuration.capabilities?.includes(capability))throw fail('ai_configuration_unavailable','当前图片配置未授权该能力',409);
    const model=modelForCapability(configuration.model,capability);
    if(!model)throw fail('ai_configuration_unavailable','图片模型尚未配置',409);
    const refs=(Array.isArray(input.referenceImages)&&input.referenceImages.length?input.referenceImages:[input.image]).filter(Boolean).slice(0,8).map(x=>imageData(x,'参考图片').dataUrl);
    const run=await vendorAdapter.call({configuration,apiKey,adapter:configuration.model.adapter,vars:{model,system:'',inputJson:'',prompt,image:refs[0]||'',images:refs,mask:'',taskId:''},requestJson,fetchImpl,lookup});
    return {...vendorAdapter.imageResult(run.data,run.response),protocol:configuration.protocol,model,capability};
  }
  if (configuration?.protocol === 'openai-image') return submitImage({ configuration, apiKey, input, fetchImpl, lookup });
  if (!configuration || configuration.section !== 'image' || !apiKey || configuration.protocol !== 'grsai-generate') throw fail('ai_configuration_unavailable', '所选AI图片配置不可用', 409);
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 8000) throw fail('invalid_ai_image_prompt', '图片提示词长度必须为1-8000', 400);
  const sources = Array.isArray(input.referenceImages) && input.referenceImages.length ? input.referenceImages : [input.image];
  const images = sources.slice(0, 8).map(item => imageData(item, '参考图').dataUrl);
  const capability = String(input.capability || 'image-redraw');
  const model = modelForCapability(configuration.model, capability);
  if (!grsaiModel('image', model)) throw fail('invalid_ai_model', 'GRS AI 图片模型不在内置清单中，请重新选择', 400);
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  const body = { model, prompt, images, ...grsaiImageParams(model, input.options), replyType: 'async' };
  const result = await requestJson(base + '/v1/api/generate', { method: 'POST', timeoutMs: Math.min(Number(configuration.timeout_ms) || 30000, 180000), headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, fetchImpl, lookup);
  if (!result.ok) {
    const status = String(result.payload?.status || '').toLowerCase();
    const reason = grsaiMessage(result.payload, apiKey);
    if (status === 'violation') throw fail('ai_content_rejected', 'AI 图片内容被供应商拒绝：' + (reason || '未说明原因'));
    if (status === 'failed') throw fail('ai_image_generate_failed', 'AI 图片生成失败：' + (reason || '未说明原因'));
    throw rejection(result.status, '图片生成请求' + (reason ? '（' + reason + '）' : ''));
  }
  const outcome = grsaiImageResult(result.payload, model, capability);
  return { ...outcome, httpStatus: result.status, references: images.length, sentPrompt: prompt };
}
async function pollImage({ configuration, apiKey, taskId, fetchImpl, lookup, diagnostic }) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(String(taskId || ''))) throw fail('invalid_ai_image_task', 'AI图片任务编号不正确', 400);
  if (configuration?.protocol === 'custom-structured') {
    const run = await vendorAdapter.call({configuration,apiKey,adapter:configuration.model.adapter,vars:{taskId},stage:'poll',requestJson,fetchImpl,lookup});
    return vendorAdapter.imageResult(run.data,run.response,String(taskId));
  }
  const base = String(configuration.base_url || configuration.baseUrl || '').replace(/\/$/, '');
  let target; let options;
  if (configuration.protocol === 'dashscope-native') {
    target = base + '/tasks/' + encodeURIComponent(taskId); options = { method: 'GET', timeoutMs: configuration.timeout_ms || 30000, headers: { Authorization: 'Bearer ' + apiKey } };
  } else if (configuration.protocol === 'grsai-generate') {
    // GRS AI 异步结果查询：GET /v1/api/result?id=<任务号>，响应 {id,status,results[].url,progress,error}。
    target = base + '/v1/api/result?id=' + encodeURIComponent(taskId);
    options = { method: 'GET', timeoutMs: configuration.timeout_ms || 30000, headers: { Authorization: 'Bearer ' + apiKey } };
  } else throw fail('ai_image_poll_unsupported', '该图片协议不需要异步查询', 409);
  let result;
  try { result = await requestJson(target, options, fetchImpl, lookup); }
  catch (error) { setChatDiagnostic(diagnostic, { httpSucceeded: false, httpStatus: 0, providerRequestId: 'unavailable', errorCode: diagnosticError(error) }); throw error; }
  setChatDiagnostic(diagnostic, { httpSucceeded: result.ok === true, httpStatus: Number(result.status) || 0, providerRequestId: providerRequestId(result.payload) });
  if (configuration.protocol === 'grsai-generate') {
    const status = String(result.payload?.status || '').toLowerCase();
    if (status === 'violation') throw fail('ai_content_rejected', 'AI 图片内容被供应商拒绝，请调整提示词或图片');
    if (status === 'failed') throw fail('ai_image_generate_failed', `AI 图片生成失败：${grsaiMessage(result.payload, apiKey)}`);
    if (!result.ok) {
      if (result.status === 404) throw Object.assign(fail('ai_image_result_not_found', 'AI 图片结果不存在或已过期，请勿重复提交'), { retryable: false });
      throw rejection(result.status, '图片结果查询');
    }
    const url = Array.isArray(result.payload?.results) ? String(result.payload.results[0]?.url || '') : '';
    return { state: url ? 'succeeded' : 'pending', resultUrl: url || null, taskId: String(taskId), progress: Number(result.payload?.progress) || 0 };
  }
  if (!result.ok) throw rejection(result.status, '图片结果查询');
  const status = String(result.payload?.output?.task_status || result.payload?.status || '').toLowerCase();
  const resultUrl = result.payload?.output?.results?.[0]?.url || result.payload?.output?.image_url || result.payload?.data?.[0]?.url || null;
  return { state: resultUrl ? 'succeeded' : ['failed', 'canceled', 'cancelled'].includes(status) ? 'failed' : 'pending', resultUrl: resultUrl && String(resultUrl), taskId: String(taskId) };
}

function validImageBuffer(buffer, mime) {
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/bmp') return buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM';
  if (mime === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6));
  if (['image/avif', 'image/heic', 'image/heif'].includes(mime) && buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    return mime === 'image/avif' ? ['avif', 'avis'].includes(brand) : ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
  }
  return false;
}
async function downloadImage(value, { lookup = dns.lookup, requestImpl = https.request, timeoutMs = 30000, allowSourceFormats = false, diagnostic } = {}) {
  if (typeof value === 'string' && value.startsWith('data:image/')) {
    const original = imageData(value, 'AI候选图');
    return { buffer: original.body, mime: original.mime, extension: original.extension };
  }
  let target;
  try { target = new URL(value); } catch (_) { throw fail('invalid_ai_image_url', 'AI候选图片地址无效', 400); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw fail('invalid_ai_image_url', 'AI候选图片必须使用公开HTTPS地址', 400);
  return new Promise((resolve, reject) => {
    const req = requestImpl(target, {
      method: 'GET', timeout: Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 60000),
      lookup(hostname, options, callback) {
        Promise.resolve(resolvePublic(hostname, lookup)).then(addresses => {
          if (diagnostic && typeof diagnostic === 'object') Object.assign(diagnostic, { stage: 'ai_provider_dns', hostname: safeHostname(hostname), addressClasses: Array.from(new Set(addresses.map(item => addressClass(item.address)))) });
          if (options && options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        }, callback);
      }
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400) { response.resume(); return reject(fail('ai_image_redirect_denied', 'AI候选图片重定向已被拒绝')); }
      if (status < 200 || status >= 300) { response.resume(); return reject(rejection(status, '候选图片下载')); }
      const mime = String(response.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      const declared = Number(response.headers?.['content-length'] || 0);
      const types = allowSourceFormats ? SOURCE_IMAGE_TYPES : IMAGE_TYPES;
      if (!types[mime]) { response.resume(); return reject(fail('ai_image_type_invalid', '图片格式不受支持')); }
      if (declared > MAX_IMAGE_INPUT_BYTES) { response.resume(); return reject(fail('ai_image_too_large', 'AI候选图片超过10 MiB限制')); }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > MAX_IMAGE_INPUT_BYTES) req.destroy(fail('ai_image_too_large', 'AI候选图片超过10 MiB限制')); else chunks.push(chunk); });
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (!validImageBuffer(buffer, mime)) return reject(fail('ai_image_type_invalid', 'AI候选图片文件头与格式不匹配'));
        resolve({ buffer, mime, extension: types[mime] });
      });
    });
    req.on('timeout', () => req.destroy(fail('ai_timeout', 'AI候选图片下载超时')));
    req.on('error', error => reject(error.publicCode ? error : fail('ai_provider_unreachable', 'AI候选图片下载失败')));
    req.end();
  });
}

module.exports = { chat, testConnection, getCredits, functionalTest, submitImage, generateImage, pollImage, downloadImage, imageRequest, grsaiImageParams, stripJsonFence, secureJsonRequest, readJson, ensurePublicUrl, resolvePublic, privateIp, MAX_RESPONSE_BYTES, MAX_IMAGE_INPUT_BYTES };