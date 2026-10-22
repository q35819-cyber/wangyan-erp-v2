'use strict';

function createSingleFlightTask(execute) {
  if (typeof execute !== 'function') throw new Error('single-flight task requires an executor');
  let current = null;

  function start() {
    if (current) return { started: false, promise: current };
    const operation = Promise.resolve().then(execute);
    const wrapped = operation.finally(() => {
      if (current === wrapped) current = null;
    });
    current = wrapped;
    return { started: true, promise: current };
  }

  return { start, isRunning: () => Boolean(current) };
}

module.exports = { createSingleFlightTask };
