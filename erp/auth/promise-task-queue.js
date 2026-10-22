'use strict';

function createPromiseTaskQueue(options = {}) {
  const concurrency = Number.isInteger(options.concurrency) ? Math.max(1, options.concurrency) : 1;
  const maximumSize = Number.isInteger(options.maximumSize) ? Math.max(concurrency, options.maximumSize) : 20;
  const pending = [];
  const keyed = new Map();
  let running = 0;

  function drain() {
    while (running < concurrency && pending.length) {
      const entry = pending.shift();
      running += 1;
      Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
        running -= 1;
        if (keyed.get(entry.key) === entry.promise) keyed.delete(entry.key);
        drain();
      });
    }
  }

  function run(key, task) {
    key = String(key || '').trim();
    if (!key || typeof task !== 'function') throw new Error('任务队列参数无效');
    const existing = keyed.get(key);
    if (existing) return { accepted: false, duplicate: true, promise: existing };
    if (pending.length + running >= maximumSize) {
      const error = new Error('任务队列已满');
      error.publicCode = 'task_queue_full';
      throw error;
    }
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
    const entry = { key, task, promise, resolve: resolveTask, reject: rejectTask };
    keyed.set(key, promise);
    pending.push(entry);
    drain();
    return { accepted: true, duplicate: false, promise };
  }

  return { run, state: () => ({ running, pending: pending.length, size: running + pending.length }) };
}

module.exports = { createPromiseTaskQueue };
