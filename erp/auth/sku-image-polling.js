'use strict';

const TOTAL_WAIT_MS = 15 * 60 * 1000;
const INTERVAL_MS = 10 * 1000;
const NOT_FOUND_GRACE_MS = 120 * 1000;

function nextWaitMs(startedAtMs, nowMs, totalWaitMs = TOTAL_WAIT_MS, intervalMs = INTERVAL_MS) {
  const elapsed = Math.max(0, Number(nowMs) - Number(startedAtMs));
  const remaining = Number(totalWaitMs) - elapsed;
  if (remaining <= 0) return null;
  return Math.min(Math.max(1, Number(intervalMs) || INTERVAL_MS), remaining);
}

function resultNotFoundIsPropagating(startedAtMs, nowMs, graceMs = NOT_FOUND_GRACE_MS) {
  return Math.max(0, Number(nowMs) - Number(startedAtMs)) < Math.max(0, Number(graceMs) || 0);
}

module.exports = { TOTAL_WAIT_MS, INTERVAL_MS, NOT_FOUND_GRACE_MS, nextWaitMs, resultNotFoundIsPropagating };
