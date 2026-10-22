'use strict';

// Retry only these two read commands. Never replay platform writes here.
const PRODUCT_READS = new Set(['products.getInfo', 'products.getAttributes']);
const TRANSIENT = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function failureCode(error) {
  const code = error && (error.cause && error.cause.code || error.code);
  if (TRANSIENT.has(code)) return code;
  if (error && error.name === 'AbortError') return 'TIMEOUT';
  if (error && error.message === 'fetch failed') return 'FETCH_FAILED';
  return 'UNKNOWN';
}
async function readProduct(command, url, options, settings = {}) {
  if (!PRODUCT_READS.has(command)) throw Object.assign(new Error('该商品读取命令不在服务端允许列表内，请刷新页面后重试。'), { code: 'product_read_command_required' });
  const fetchImpl = settings.fetch || fetch;
  const wait = settings.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs || 8000);
    let retry = false;
    try {
      const upstream = await fetchImpl(url, { ...options, signal: controller.signal });
      if (Number(upstream.headers.get('content-length') || 0) > 10 * 1024 * 1024) {
        if (upstream.body) await upstream.body.cancel();
        throw Object.assign(new Error('Ozon 返回内容超过允许大小，请缩小查询范围后重试。'), { code: 'ozon_response_too_large' });
      }
      const text = await upstream.text();
      if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw Object.assign(new Error('Ozon 返回内容超过允许大小，请缩小查询范围后重试。'), { code: 'ozon_response_too_large' });
      if (attempt === 0 && [502, 503, 504].includes(upstream.status)) retry = true;
      else return { upstream, text };
    } catch (error) {
      if (attempt === 0 && failureCode(error) !== 'UNKNOWN') retry = true;
      else throw error;
    } finally { clearTimeout(timer); }
    if (retry) await wait(250);
  }
}
module.exports = { PRODUCT_READS, readProduct, failureCode };
