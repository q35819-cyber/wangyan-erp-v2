'use strict';

const LOGISTICS_PLAN_PROFILE_IDS = ['plan-1', 'plan-2', 'plan-3'];

function normalizeLogisticsPlanProfiles(payload) {
  const source = Array.isArray(payload) ? payload : [];
  return LOGISTICS_PLAN_PROFILE_IDS.map((id, index) => {
    const found = source.find(item => item && item.id === id) || {};
    return {
      id,
      name: `方案${index + 1}`,
      userIds: [...new Set((Array.isArray(found.userIds) ? found.userIds : []).map(String).filter(value => /^\d+$/.test(value)))],
      defaultScheme: String(found.defaultScheme || ''),
      defaults: Array.isArray(found.defaults) ? found.defaults : [],
      updatedAt: found.updatedAt || null,
      updatedBy: String(found.updatedBy || '')
    };
  });
}

function assignLogisticsPlanProfile(payload, profile) {
  const profiles = normalizeLogisticsPlanProfiles(payload);
  const userIds = new Set((profile.userIds || []).map(String));
  return profiles.map(item => {
    if (item.id === profile.id) return { ...item, ...profile, name: item.name, userIds: [...userIds] };
    return { ...item, userIds: item.userIds.filter(userId => !userIds.has(userId)) };
  });
}

module.exports = { LOGISTICS_PLAN_PROFILE_IDS, normalizeLogisticsPlanProfiles, assignLogisticsPlanProfile };
