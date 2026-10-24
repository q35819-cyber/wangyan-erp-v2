'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const quota = require('./assets/membership-quota');
function mockRequest(fn) {
  const original = globalThis.erpStorage;
  globalThis.erpStorage = { request: fn, getSelectedTenantId: () => '' };
  return () => { if (original === undefined) delete globalThis.erpStorage; else globalThis.erpStorage = original; };
}
test('standalone quota resolves without calling disabled SaaS membership endpoints', async () => {
  const requested = [];
  const restore = mockRequest(async url => { requested.push(url); return { ok: true, json: async () => ({ standalone: true, membership: false }) }; });
  try {
    const info = await quota.load();
    assert.deepEqual(requested, ['/api/local/standalone-mode']);
    for (const key of ['collectionBox', 'shops', 'dailySku', 'favorites']) {
      assert.equal(info.quotas[key].unlimited, true);
      assert.equal(info.quotas[key].localOnly, true);
    }
    assert.match(quota.metaText(info.quotas.collectionBox), /单机版不限额度/);
  } finally { restore(); }
});
test('SaaS still fetches real membership quotas', async () => {
  const requested = [];
  const restore = mockRequest(async url => {
    requested.push(url);
    if (url === '/api/local/standalone-mode') return { ok: true, json: async () => ({ standalone: false }) };
    return { ok: true, json: async () => ({ quotas: { collectionBox: { limit: 3, usage: 1 } } }) };
  });
  try {
    const info = await quota.load();
    assert.deepEqual(requested, ['/api/local/standalone-mode', '/api/membership/current']);
    assert.equal(info.quotas.collectionBox.limit, 3);
  } finally { restore(); }
});
test('failed standalone probe does not grant unlimited SaaS quota', async () => {
  const requested = [];
  const restore = mockRequest(async url => {
    requested.push(url);
    if (url === '/api/local/standalone-mode') throw new Error('temporarily unavailable');
    return { ok: false, json: async () => ({ message: '会员服务不可用' }) };
  });
  try {
    await assert.rejects(quota.load(), /会员服务不可用/);
    assert.deepEqual(requested, ['/api/local/standalone-mode', '/api/membership/current']);
  } finally { restore(); }
});