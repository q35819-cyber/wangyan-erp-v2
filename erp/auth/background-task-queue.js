'use strict';

function createBackgroundTaskQueue(options = {}) {
  const concurrency = Number.isInteger(options.concurrency) ? Math.max(1, options.concurrency) : 1;
  const maximumPending = Number.isInteger(options.maximumPending) ? Math.max(1, options.maximumPending) : 200;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const pending = [];
  const keys = new Set();
  let running = 0;

  function drain() {
    while (running < concurrency && pending.length) {
      const entry = pending.shift();
      running += 1;
      Promise.resolve().then(entry.task).catch(error => onError(error, entry.key)).finally(() => {
        running -= 1;
        keys.delete(entry.key);
        drain();
      });
    }
  }

  function enqueue(key, task) {
    key = String(key || '').trim();
    if (!key || typeof task !== 'function') throw new Error('后台任务参数无效');
    if (keys.has(key)) return { accepted: false, duplicate: true, pending: pending.length, running };
    if (pending.length + running >= maximumPending) return { accepted: false, full: true, pending: pending.length, running };
    keys.add(key);
    pending.push({ key, task });
    drain();
    return { accepted: true, duplicate: false, pending: pending.length, running };
  }

  function state() { return { pending: pending.length, running, size: pending.length + running }; }
  return { enqueue, state };
}

module.exports = { createBackgroundTaskQueue };
