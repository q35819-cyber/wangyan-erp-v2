'use strict';

function quotaText(limit, usage) {
  if (limit == null || Number(limit) < 0) return '-';
  const total = Number(limit);
  const used = usage == null || Number(usage) < 0 ? 0 : Number(usage);
  return String(Math.max(0, total - used)) + '/' + String(total);
}

function formatExpires(expiresAt, now = new Date()) {
  if (!expiresAt) return { keyExp: '永久', keyTime: '' };
  const date = new Date(expiresAt);
  if (isNaN(date.getTime())) return { keyExp: '永久', keyTime: '' };
  const pad = value => String(value).padStart(2, '0');
  const keyTime = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  if (date < now) return { keyExp: '已过期', keyTime };
  return { keyExp: (date - now) / 86400000 <= 30 ? '即将过期' : '未过期', keyTime };
}

function limitFields(limitPayload, rolesPayload, now) {
  const dailyCreate = limitPayload && limitPayload.daily_create || {};
  const dailyUpdate = limitPayload && limitPayload.daily_update || {};
  const total = limitPayload && limitPayload.total || {};
  return {
    create: quotaText(total.limit, total.usage),
    c24: quotaText(dailyCreate.limit, dailyCreate.usage),
    m24: quotaText(dailyUpdate.limit, dailyUpdate.usage),
    ...formatExpires(rolesPayload && rolesPayload.expires_at, now)
  };
}

function warehouseFields(payload, current = {}) {
  const rows = payload && (payload.warehouses || payload.result) || [];
  const bad = new Set(['archived', 'frozen', 'deleted', 'paused', 'inactive', 'disabled']);
  const usable = (Array.isArray(rows) ? rows : []).filter(item => item && !bad.has(String(item.status || 'active').toLowerCase()) && !item.pause_at);
  const rfbs = usable.filter(item => item.is_rfbs === true);
  const selected = rfbs.length ? rfbs : usable;
  const options = selected.map(item => ({
    id: String(item.warehouse_id != null ? item.warehouse_id : item.id != null ? item.id : ''),
    name: String(item.name || item.warehouse_name || '').trim(),
    isRfbs: item.is_rfbs === true,
    status: String(item.status || 'active')
  })).filter(item => item.id || item.name);
  const keepDefault = options.some(item => String(item.id) === String(current.defaultWarehouseId || ''));
  return {
    fulfillmentSchema: rfbs.length ? 'rFBS' : usable.length ? 'FBS' : (current.fulfillmentSchema || 'rFBS'),
    warehouseOptions: options,
    fulfillmentWarehouseNames: options.map(item => item.name).filter(Boolean),
    warehouse: options.length,
    defaultWarehouseId: keepDefault ? current.defaultWarehouseId : '',
    defaultWarehouseName: keepDefault ? current.defaultWarehouseName : ''
  };
}

module.exports = { quotaText, formatExpires, limitFields, warehouseFields };
