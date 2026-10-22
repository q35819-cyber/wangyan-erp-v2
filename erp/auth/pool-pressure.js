'use strict';

// The same PostgreSQL pool serves interactive requests and durable workers.
// Defer new low-priority claims if application requests are already waiting
// for a connection. Periodically permit one claim to prevent permanent worker
// starvation under sustained front-end traffic. Running jobs and lease
// renewals are never interrupted by this admission control.
function deferBackgroundClaim(pool, consecutiveDeferrals) {
  const congested = Boolean(pool && Number(pool.waitingCount) > 0 && Number(pool.idleCount) === 0);
  return congested && consecutiveDeferrals < 3;
}

module.exports = { deferBackgroundClaim };
