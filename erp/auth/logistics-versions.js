'use strict';

const UNVERSIONED = '未标注版本';

function detectedVersion(item) {
  const current = String(item && item.version || '').trim();
  if (current && current !== UNVERSIONED) return current;
  const source = String(item && item.originalName || '');
  return (source.match(/(?:20\d{2}[.\-年]?\d{1,2}(?:[.\-月]?\d{1,2})?|V\s*\d+(?:\.\d+)*)/i) || [])[0] || UNVERSIONED;
}

function isVersioned(item) { return detectedVersion(item) !== UNVERSIONED; }

function sourceTime(item) {
  const record = item && typeof item === 'object' ? item : {};
  const value = record.parsedSourceUpdatedAt;
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function shouldPromoteOfficial(current, candidate) {
  const candidateTime = sourceTime(candidate);
  if (candidateTime == null) return false;
  if (!current) return true;
  const currentTime = sourceTime(current);
  if (currentTime == null) return true;
  return candidateTime > currentTime;
}

function promoteOfficialVersion(input, candidate) {
  const items = (Array.isArray(input) ? input : []).filter(Boolean).map(item => ({ ...item }));
  const provider = String(candidate && candidate.provider || '').trim();
  const current = provider ? items.find(item => item.provider === provider && item.active) : null;
  if (!provider || !shouldPromoteOfficial(current, candidate)) return { promoted: false, current: current || null, items };
  const promotedItem = { ...candidate, active: true };
  const next = items
    .filter(item => item.id !== promotedItem.id)
    .map(item => item.provider === provider ? { ...item, active: false } : item);
  return { promoted: true, current: current || null, items: [promotedItem, ...next] };
}

function canDownloadOriginal(account, item) {
  if (!item || !(item.storedRelativePath || item.storedName || item.objectId)) return false;
  if (account && account.isSystemAdmin === true) return true;
  return Boolean(account && item && item.storageTenantId && item.uploadedByUserId
    && (item.storedRelativePath || item.storedName || item.objectId)
    && String(account.tenantId) === String(item.storageTenantId)
    && String(account.userId) === String(item.uploadedByUserId));
}

function selectPreferredVersions(input, preserveActive = false) {
  const items = (Array.isArray(input) ? input : []).filter(Boolean).map(item => ({ ...item, version: detectedVersion(item) }));
  if (preserveActive) return items;
  const providers = new Set(items.map(item => item.provider).filter(Boolean));
  for (const provider of providers) {
    const sameProvider = items.filter(item => item.provider === provider);
    const active = sameProvider.find(item => item.active);
    if (active && (isVersioned(active) || sourceTime(active) != null)) continue;
    const candidates = sameProvider.filter(isVersioned).sort((left, right) => {
      const leftTime = Date.parse(left.sourceUpdatedAt || left.uploadedAt || 0) || 0;
      const rightTime = Date.parse(right.sourceUpdatedAt || right.uploadedAt || 0) || 0;
      return rightTime - leftTime || String(right.version).localeCompare(String(left.version), 'zh-CN', { numeric: true });
    });
    if (!candidates.length) continue;
    const selectedId = candidates[0].id;
    items.forEach(item => { if (item.provider === provider) item.active = item.id === selectedId; });
  }
  return items;
}

module.exports = { UNVERSIONED, detectedVersion, isVersioned, sourceTime, shouldPromoteOfficial, promoteOfficialVersion, canDownloadOriginal, selectPreferredVersions };
