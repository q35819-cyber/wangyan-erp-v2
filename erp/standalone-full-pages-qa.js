'use strict';
const assert = require('node:assert/strict');
async function runPageAudit({ context, base }) {
  // Explicit allowlist: isolated synthetic QA instances only, never customer ERP.
  if (!['http://127.0.0.1:18787', 'http://127.0.0.1:18792'].includes(base)) throw Error('Refusing non-isolated QA');
  const pages = ['shops','shop-groups','goods','goods-online','goods-onlist','goods-relist',
    'product-detail','orders','order-statistics','dashboard','profit','pricing',
    'pricing-settings','logistics-config','category','tag-search','goods-favorites',
    'source-auth','source-pick','task-center','template-config','watermark',
    'bug-feedback','audit-log','shop-analysis','analytics','ranking',
    'promo-ozon','promo-auto','msg-templates','msg-sendlog','api-monitor'];
  const results = [];
  for (const [index, name] of pages.entries()) {
    if (process.env.WYERP_QA_PAGE_BATCH === '1' && index >= 16) continue;
    if (process.env.WYERP_QA_PAGE_BATCH === '2' && index < 16) continue;
    // A fresh browser tab per page prevents the prior workspace iframe navigation
    // from racing against the next top-level navigation.
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e).slice(0, 250)));
    try {
      const path = '/pages/' + name + '.html';
      const response = await page.goto(base + '/workspace.html?open=' +
        encodeURIComponent(path), { waitUntil: 'domcontentloaded', timeout: 15000 });
      assert.equal(response.status(), 200, 'Workspace HTTP status');
      await page.waitForFunction(expected => [...document.querySelectorAll('iframe.workspace-frame')]
        .some(f => {
          if (f.hidden || !f.contentDocument) return false;
          return f.contentWindow?.location?.pathname === expected &&
            f.contentDocument.readyState !== 'loading';
        }), path, { timeout: 17000 });
      await page.waitForTimeout(250);
      if (errors.length) throw Error('Unhandled JS exceptions: ' + errors.join(' || '));
      results.push({ page: name, status: 'PASS' });
      console.log('PASS UI ' + name);
    } catch (e) {
      results.push({ page: name, status: 'FAIL', detail: String(e.message).slice(0, 300) });
      console.error('FAIL UI ' + name + ' ' + String(e.message).slice(0, 220));
    } finally {
      await page.close().catch(() => {});
    }
  }
  console.log('FULL_PAGE_AUDIT ' +
    JSON.stringify({ pass: results.filter(x => x.status === 'PASS').length, total: results.length }));
  return results;
}
module.exports = { runPageAudit };