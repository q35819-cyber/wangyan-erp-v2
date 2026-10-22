'use strict';

const VALID_ROLES = Object.freeze(['all', 'api', 'worker']);

function nodeRole(environment = process.env) {
  const role = String(environment.ERP_NODE_ROLE || 'all').trim().toLowerCase();
  if (!VALID_ROLES.includes(role)) throw new Error('ERP_NODE_ROLE 必须是 all、api 或 worker。');
  return role;
}

function runsBackgroundJobs(role) { return role !== 'api'; }
function servesBusinessRequests(role) { return role !== 'worker'; }

module.exports = { VALID_ROLES, nodeRole, runsBackgroundJobs, servesBusinessRequests };
