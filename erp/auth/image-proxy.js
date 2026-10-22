'use strict';
/*
 * 同源图片代理：只负责"取回远程图片字节 + 缓存头"，不加水印、不改图、不覆盖原图。
 * 安全边界：HTTPS + 域名白名单 + 禁内网/localhost/file: + 限制类型/大小/超时 + 重定向逐跳复验。
 */
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns').promises;
const url = require('node:url');

const ALLOWED_HOSTS = [
  'ir.ozone.ru', 'ir-2.ozone.ru', 'multi-mkt-01.s3.nl-ams.spb.yandexcloud.net', 'cdn1.ozone.ru', 'cdn2.ozone.ru', 'cdn-rt.ozone.ru',
  'cbu01.alicdn.com', 'gw.alicdn.com', 'img.alicdn.com', 'tbs.img.oss-cn-shanghai.aliyuncs.com',
  'avatars.mux.com', 'picasso.alicdn.com'
];
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 15000;
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/avif', 'image/heif', 'image/heic'];

function problem(code, text, status) { return Object.assign(new Error(text || '服务端未给出中文提示，请按页面提示重试；仍未成功请联系管理员。'), { publicCode: code, status }); }

function isPrivateAddress(address) {
  if (!address || typeof address !== 'string') return true;
  const value = address.replace(/^::ffff:/i, '');
  if (net.isIPv4(value)) {
    const parts = value.split('.').map(Number);
    const first = parts[0], second = parts[1];
    if (first === 0 || first === 10 || first === 127) return true;
    if (first === 100 && second >= 64 && second <= 127) return true;      // CGNAT
    if (first === 169 && second === 254) return true;                      // 链路本地
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 198 && (second === 18 || second === 19)) return true;
    if (first >= 224) return true;                                         // 组播/保留
    return false;
  }
  const lower = value.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (/^fe80/.test(lower) || /^fc/.test(lower) || /^fd/.test(lower)) return true;
  if (/^::ffff:127/.test(lower)) return true;
  if (/^2001:db8/.test(lower)) return false;                                // 文档前缀，非内网
  return /^[f8-9a-f]/i.test(lower) ? false : false;
}

// 校验并解析目标地址；返回 { href, host }
async function assertAllowedImageUrl(raw, options) {
  const settings = options || {};
  let parsed;
  try { parsed = new url.URL(String(raw || '')); } catch (error) { throw problem('image_proxy_url_invalid', '图片地址格式不正确，请重新填写完整的图片链接。', 400); }
  if (parsed.protocol !== 'https:') throw problem('image_proxy_protocol_forbidden', '图片地址必须使用HTTPS，请更换为HTTPS图片链接。', 403);
  const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) throw problem('image_proxy_url_invalid', '图片地址格式不正确，请重新填写完整的图片链接。', 400);
  if (host === 'localhost' || host.endsWith('.localhost') || !net.isIP(host) && /\.(local|internal|intranet|lan)$/i.test(host)) throw problem('image_proxy_host_forbidden', '不允许读取内网或本机地址，请改用外网可访问的图片链接。', 403);
  if (net.isIP(host)) throw problem('image_proxy_host_forbidden', '不允许读取内网或本机地址，请改用外网可访问的图片链接。', 403);      // 不允许直接用 IP 访问
  const allowed = (settings.allowedHosts || ALLOWED_HOSTS).map(item => String(item).toLowerCase());
  const hit = allowed.some(item => host === item || (item.startsWith('.') && host.endsWith(item)) || host.endsWith('.' + item));
  if (!hit) throw problem('image_proxy_host_not_allowed', '该图片域名不在允许列表内，请换成Ozon或1688等受信任域名的图片链接。', 403);
  if (!settings.skipDns) {
    let records;
    try { records = await dns.lookup(host, { all: true, verbatim: true }); } catch (error) { throw problem('image_proxy_host_unresolved', '无法解析该图片域名，请检查链接是否拼写正确，或稍后重试。', 400); }
    if (!records.length) throw problem('image_proxy_host_unresolved', '无法解析该图片域名，请检查链接是否拼写正确，或稍后重试。', 400);
    if (records.some(record => isPrivateAddress(record.address))) throw problem('image_proxy_host_forbidden', '不允许读取内网或本机地址，请改用外网可访问的图片链接。', 403);
  }
  return { href: parsed.toString(), host: host };
}

function fetchImage(raw, options) {
  const settings = options || {};
  const maxBytes = Number(settings.maxBytes) || MAX_BYTES;
  let hops = 0;
  async function once(target) {
    const checked = await assertAllowedImageUrl(target, settings);
    return new Promise((resolve, reject) => {
      const request = https.get(checked.href, { timeout: settings.timeoutMs || TIMEOUT_MS, headers: { 'User-Agent': 'wyerp-image-proxy/1.0', Accept: 'image/*' } }, response => {
        const status = Number(response.statusCode || 0);
        if (status >= 300 && status < 400) {
          const location = response.headers.location;
          response.resume();
          if (!location) { reject(problem('image_proxy_redirect_missing', '图片服务器返回跳转但缺少跳转地址，请稍后重试或更换图片链接。', 400)); return; }
          hops += 1;
          if (hops > (settings.maxRedirects || MAX_REDIRECTS)) { reject(problem('image_proxy_too_many_redirects', '图片地址跳转次数过多，请更换为可直接访问的图片链接。', 400)); return; }
          let next;
          try { next = new url.URL(location, checked.href).toString(); } catch (error) { reject(problem('image_proxy_url_invalid', '图片地址格式不正确，请重新填写完整的图片链接。', 400)); return; }
          once(next).then(resolve).catch(reject);
          return;
        }
        if (status !== 200) { response.resume(); reject(problem('image_proxy_upstream_status', '图片源站没有正常返回该图片，请确认链接能打开后重试。', 404)); return; }
        const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ALLOWED_CONTENT_TYPES.indexOf(type) < 0) { response.resume(); reject(problem('image_proxy_content_type', '该地址返回的不是图片文件，请更换为JPG、PNG或WebP图片链接。', 415)); return; }
        const declared = Number(response.headers['content-length'] || 0);
        if (declared && declared > maxBytes) { response.resume(); reject(problem('image_proxy_too_large', '图片超过允许的大小上限，请压缩图片或改用更小的图片链接。', 413)); return; }
        const chunks = [];
        let total = 0;
        response.on('data', chunk => {
          total += chunk.length;
          if (total > maxBytes) { response.destroy(); reject(problem('image_proxy_too_large', '图片超过允许的大小上限，请压缩图片或改用更小的图片链接。', 413)); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ buffer: Buffer.concat(chunks), type: type, cacheControl: String(response.headers['cache-control'] || ''), etag: String(response.headers.etag || '') }));
        response.on('error', () => reject(problem('image_proxy_fetch_failed', '图片下载失败，请检查网络或稍后重试。', 404)));
      });
      request.on('timeout', () => { request.destroy(); reject(problem('image_proxy_timeout', '图片下载超时，请稍后重试或更换图片链接。', 504)); });
      request.on('error', () => reject(problem('image_proxy_fetch_failed', '图片下载失败，请检查网络或稍后重试。', 404)));
    });
  }
  return once(raw);
}

module.exports = { ALLOWED_HOSTS: ALLOWED_HOSTS.slice(), MAX_BYTES, TIMEOUT_MS, isPrivateAddress, assertAllowedImageUrl, fetchImage };
