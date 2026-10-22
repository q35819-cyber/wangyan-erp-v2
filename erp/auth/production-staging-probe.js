'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

function nativeRequest(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'wyerp-staging-probe/1' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers || {},
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    request.once('timeout', () => request.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    request.once('error', reject);
  });
}

function headerValue(headers, name) {
  const value = headers && headers[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : String(value || '');
}

async function probeStaging(options = {}) {
  const origin = String(options.origin || '').replace(/\/+$/, '');
  const request = options.request || nativeRequest;
  const timeoutMs = Number(options.timeoutMs || 5000);
  const issues = [];
  let parsed;
  try { parsed = new URL(origin); } catch (_) {}
  if (!parsed || parsed.protocol !== 'https:') return { ok:false, issues:[{code:'origin_https',message:'预发布地址必须使用 https://'}] };

  const evidence = { result:'failed', generatedAt:new Date().toISOString(), origin, health:{}, securityHeaders:false, httpRedirect:false };
  try {
    const live = await request(`${origin}/health/live`, timeoutMs);
    evidence.health.live = live.statusCode;
    if (live.statusCode !== 200) issues.push({code:'live_status',message:`/health/live HTTP ${live.statusCode}`});
    else {
      try { if (JSON.parse(live.body).status !== 'ok') issues.push({code:'live_body',message:'/health/live status 不是 ok'}); }
      catch (_) { issues.push({code:'live_json',message:'/health/live 不是有效 JSON'}); }
    }

    const ready = await request(`${origin}/health/ready`, timeoutMs);
    evidence.health.ready = ready.statusCode;
    if (ready.statusCode !== 200) issues.push({code:'ready_status',message:`/health/ready HTTP ${ready.statusCode}`});
    else {
      try { if (JSON.parse(ready.body).status !== 'ready') issues.push({code:'ready_body',message:'/health/ready status 不是 ready'}); }
      catch (_) { issues.push({code:'ready_json',message:'/health/ready 不是有效 JSON'}); }
    }

    const page = await request(`${origin}/login.html`, timeoutMs);
    if (page.statusCode !== 200) issues.push({code:'login_status',message:`/login.html HTTP ${page.statusCode}`});
    const requiredHeaders = [
      ['strict-transport-security', value => /max-age=\d+/i.test(value)],
      ['content-security-policy', value => /default-src\s+'self'/i.test(value) && /object-src\s+'none'/i.test(value)],
      ['x-content-type-options', value => value.toLowerCase() === 'nosniff'],
      ['referrer-policy', value => Boolean(value)],
      ['permissions-policy', value => Boolean(value)]
    ];
    for (const [name, valid] of requiredHeaders) {
      const value = headerValue(page.headers, name);
      if (!valid(value)) issues.push({code:`header_${name}`,message:`缺少或无效安全响应头 ${name}`});
    }
    if (headerValue(page.headers, 'server')) issues.push({code:'server_header',message:'反向代理不应暴露 Server 响应头'});
    evidence.securityHeaders = !issues.some(item => item.code.startsWith('header_') || item.code === 'server_header');

    const insecureOrigin = `http://${parsed.host}`;
    const redirect = await request(`${insecureOrigin}/health/live`, timeoutMs);
    const location = headerValue(redirect.headers, 'location');
    evidence.httpRedirect = [301,302,307,308].includes(redirect.statusCode) && location.startsWith('https://');
    if (!evidence.httpRedirect) issues.push({code:'http_redirect',message:'HTTP 未明确重定向到 HTTPS'});
  } catch (error) {
    issues.push({code:'request_failed',message:error.message});
  }
  evidence.result = issues.length ? 'failed' : 'passed';
  return { ok:issues.length===0, issues, evidence };
}

async function main() {
  const origin = process.env.ERP_STAGING_ORIGIN || process.env.PUBLIC_ORIGIN;
  const output = String(process.env.ERP_STAGING_EVIDENCE_OUTPUT || '').trim();
  const result = await probeStaging({ origin });
  if (output) {
    const file = path.resolve(output);
    fs.mkdirSync(path.dirname(file), { recursive:true });
    fs.writeFileSync(file, JSON.stringify(result.evidence, null, 2) + '\n', 'utf8');
  }
  if (!result.ok) {
    console.error('[production-staging-probe] FAIL');
    for (const issue of result.issues) console.error(`- ${issue.code}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[production-staging-probe] PASS origin=${result.evidence.origin}`);
}

if (require.main === module) main().catch(error => { console.error(`[production-staging-probe] FAIL ${error.message}`); process.exitCode=1; });
module.exports = { nativeRequest, headerValue, probeStaging };
