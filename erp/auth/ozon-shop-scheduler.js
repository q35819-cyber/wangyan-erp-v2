'use strict';

function createOzonShopScheduler(options = {}) {
  const maxConcurrent = Number.isInteger(options.maxConcurrent) ? Math.max(1, options.maxConcurrent) : 2;
  const shopTails = new Map();
  const permits = [];
  let active = 0;

  function acquire() {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => permits.push(resolve));
  }

  function release() {
    const next = permits.shift();
    if (next) next();
    else active = Math.max(0, active - 1);
  }

  function run(shopId, task) {
    const key = String(shopId || '').trim();
    if (!key) return Promise.reject(new Error('Ozon店铺调度缺少店铺编号'));
    const previous = shopTails.get(key) || Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      await acquire();
      try { return await task(); }
      finally { release(); }
    });
    shopTails.set(key, operation);
    operation.finally(() => {
      if (shopTails.get(key) === operation) shopTails.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  return { run, state: () => ({ active, waiting: permits.length, shops: shopTails.size, maxConcurrent }) };
}

module.exports = { createOzonShopScheduler };
