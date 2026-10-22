(function () {
  'use strict';
  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var node = byId(id); if (node) node.textContent = value; }
  function dateParts(value) {
    var parsed = value ? new Date(value) : null;
    if (!parsed || isNaN(parsed.getTime())) return null;
    function pad(number) { return String(number).padStart(2, '0'); }
    return [parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()), pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds())];
  }
  function request(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) { var error = new Error(payload.message || '会员管理操作未完成，请稍后重试。'); error.code = payload.error; throw error; }
        return payload;
      });
    });
  }
  function cell(row, value, className) { var node = document.createElement('td'); node.textContent = value; if (className) node.className = className; row.appendChild(node); return node; }
  function dateCell(row, value, fallback) {
    var node = document.createElement('td'); var parts = dateParts(value);
    if (!parts) node.textContent = fallback || '--';
    else parts.forEach(function (part) { var line = document.createElement('span'); line.className = 'date-line'; line.textContent = part; node.appendChild(line); });
    node.className = 'date-cell'; row.appendChild(node);
  }
  function selectedText(id) { var select = byId(id); return select && select.selectedIndex >= 0 ? select.options[select.selectedIndex].textContent : '--'; }

  var account = null;
  var intent = null;
  var oneTimeCode = '';
  var membershipPlans = [];
  var recordsPage = 1;
  var recordsPageSize = 10;

  function renderAdminAvatar(profile) {
    var image = byId('adminMembershipAvatarImage');
    var fallback = byId('adminMembershipAvatarFallback');
    var label = String(profile && (profile.avatarLetter || profile.fullName || profile.username) || '管').trim();
    fallback.textContent = label ? label.slice(0, 2) : '管';
    fallback.hidden = false;
    image.hidden = true;
    var url = String(profile && (profile.displayAvatarUrl || profile.avatarUrl) || '').trim();
    if (!url) { image.src = ''; return; }
    image.onload = function () { image.hidden = false; fallback.hidden = true; };
    image.onerror = function () { image.hidden = true; fallback.hidden = false; };
    image.src = url;
  }

  function intentKey(body) {
    var fingerprint = JSON.stringify(body);
    if (!intent || intent.fingerprint !== fingerprint) {
      var id = crypto.randomUUID ? crypto.randomUUID() : Date.now() + ':' + Math.random().toString(16).slice(2);
      intent = { fingerprint: fingerprint, key: 'system-activation-ui-' + id };
    }
    return intent.key;
  }
  function renderOptions(tenants, plans) {
    membershipPlans = plans.filter(function (plan) { return plan.code !== 'trial'; });
    var tenantSelect = byId('systemActivationTenant'); tenantSelect.replaceChildren();
    var first = document.createElement('option'); first.value = ''; first.textContent = '请选择客户空间'; tenantSelect.appendChild(first);
    tenants.filter(function (tenant) { return tenant.status === 'active' && tenant.ownerUserId; }).forEach(function (tenant) {
      var option = document.createElement('option'); option.value = String(tenant.tenantId); option.textContent = tenant.name + ' / ' + tenant.ownerUsername; tenantSelect.appendChild(option);
    });
    var planSelect = byId('systemActivationPlan'); planSelect.replaceChildren();
    membershipPlans.forEach(function (plan) { var option = document.createElement('option'); option.value = plan.code; option.textContent = (plan.name || plan.code) + (plan.version ? '（版本' + plan.version + '）' : ''); planSelect.appendChild(option); });
    updateBenefitFilter();
    updateFields();
  }
  function updateFields() {
    var beanMode = byId('systemActivationBenefit').value === 'bean_recharge';
    document.querySelector('[data-membership-plan]').hidden = beanMode;
    document.querySelector('[data-bean-amount]').hidden = !beanMode;
    text('systemActivationSummary', selectedText('systemActivationTenant') + ' · ' + (beanMode ? 'AI豆·' + byId('systemActivationBeanAmount').value + '豆' : selectedText('systemActivationPlan')) + ' · 一次生成一张');
  }
  function showCode(payload) {
    var status = byId('systemActivationStatus'); status.replaceChildren(); oneTimeCode = String(payload.code || '');
    var item = payload.item || {}; var label = document.createElement('span');
    label.textContent = item.benefitType === 'bean_recharge' || item.benefitType === 'ai_beans' ? '已生成AI豆激活码（' + item.beanAmount + '豆）：' : '已生成会员激活码：'; status.appendChild(label);
    var code = document.createElement('strong'); code.textContent = oneTimeCode; status.appendChild(code);
    var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-ghost payment-evidence-link'; copy.textContent = '复制本次完整码';
    copy.addEventListener('click', function () { if (!oneTimeCode) return; navigator.clipboard.writeText(oneTimeCode).then(function () { copy.textContent = '已复制'; }).catch(function () { copy.textContent = '复制失败，请手动复制'; }); }); status.appendChild(copy);
    var warning = document.createElement('span'); warning.textContent = '完整码已加密保存，可在系统管理员记录中再次查看；请勿转发给无关人员。'; status.appendChild(warning);
  }
  function adminCodeCell(row, item, className) {
    var node = cell(row, '', className);
    var code = String(item && item.code || '');
    if (!code) {
      var legacy = document.createElement('span'); legacy.textContent = item && item.codeAvailability === 'encryption_unavailable' ? '完整码暂不可读' : '历史旧码不可恢复'; node.appendChild(legacy); return node;
    }
    var value = document.createElement('span'); value.className = 'list-ellipsis'; value.title = code; value.textContent = code; node.appendChild(value);
    var copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn btn-ghost payment-evidence-link'; copy.textContent = '复制';
    copy.addEventListener('click', function () { navigator.clipboard.writeText(code).then(function () { copy.textContent = '已复制'; }).catch(function () { copy.textContent = '复制失败'; }); });
    node.appendChild(copy); return node;
  }
  function renderRecords(items) {
    var tbody = byId('systemActivationRecordRows'); tbody.replaceChildren(); items = Array.isArray(items) ? items : [];
    if (!items.length) { var row = document.createElement('tr'); var empty = document.createElement('td'); empty.className = 'membership-empty'; empty.colSpan = 11; empty.textContent = '暂无符合当前筛选条件的统一激活码记录'; row.appendChild(empty); tbody.appendChild(row); return; }
    items.forEach(function (item) {
      var row = document.createElement('tr'); var bean = item.benefitType === 'ai_beans' || item.benefitType === 'bean_recharge';
      cell(row, String(item.applicationId || '--')); cell(row, String(item.id || '--')); adminCodeCell(row, item); cell(row, (item.targetTenantName || '未命名客户') + ' / ' + (item.targetOwnerUsername || '--'));
      cell(row, bean ? 'AI豆' : '会员'); cell(row, bean ? String(item.beanAmount || '--') + '豆' : ((item.plan && item.plan.name || '--') + (item.plan && item.plan.version ? ' / 版本' + item.plan.version : '')));
      var state = item.businessState || ({ issued: '已申请', expired: '已过期', voided: '已作废' })[item.state] || '已激活';
      cell(row, state, item.state === 'voided' ? 'activation-status-voided' : '');
      dateCell(row, item.requestedAt);
      if (bean) dateCell(row, null, '无到期时间'); else dateCell(row, item.activatedAt ? item.benefitExpiresAt : null);
      dateCell(row, item.activatedAt);
      var action = document.createElement('td');
      if (item.state === 'issued' && new Date(item.expiresAt).getTime() > Date.now()) { var button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-ghost'; button.textContent = '作废'; button.addEventListener('click', function () { voidCode(item, button); }); action.appendChild(button); } else action.textContent = '--';
      row.appendChild(action); tbody.appendChild(row);
    });
  }
  function updateBenefitFilter() {
    var type = byId('systemActivationTypeFilter').value;
    var select = byId('systemActivationBenefitFilter'); select.replaceChildren();
    var first = document.createElement('option'); first.value = '';
    if (!type) { first.textContent = '请先选择类型'; select.disabled = true; }
    else {
      first.textContent = type === 'membership' ? '全部会员方案' : '全部AI豆额度'; select.disabled = false;
    }
    select.appendChild(first);
    if (type === 'membership') membershipPlans.forEach(function (plan) { var option = document.createElement('option'); option.value = plan.code; option.textContent = plan.name || plan.code; select.appendChild(option); });
    if (type === 'ai_beans') [1000, 2000, 5000, 10000, 50000].forEach(function (amount) { var option = document.createElement('option'); option.value = String(amount); option.textContent = amount + '豆'; select.appendChild(option); });
  }
  function recordQuery() {
    var query = ['page=' + recordsPage, 'pageSize=' + recordsPageSize];
    var tenantId = byId('systemActivationTenant').value; var type = byId('systemActivationTypeFilter').value; var status = byId('systemActivationStatusFilter').value; var benefit = byId('systemActivationBenefitFilter').value;
    if (tenantId) query.push('targetTenantId=' + encodeURIComponent(tenantId));
    if (type) query.push('benefitType=' + encodeURIComponent(type));
    if (status) query.push('status=' + encodeURIComponent(status));
    if (benefit && type === 'membership') query.push('planCode=' + encodeURIComponent(benefit));
    if (benefit && type === 'ai_beans') query.push('beanAmount=' + encodeURIComponent(benefit));
    return query.join('&');
  }
  function pageRange(page, totalPages) {
    if (totalPages <= 7) return Array.from({ length: totalPages }, function (_, index) { return index + 1; });
    var pages = [1]; var start = Math.max(2, page - 1); var end = Math.min(totalPages - 1, page + 1);
    if (start > 2) pages.push('…');
    for (var current = start; current <= end; current += 1) pages.push(current);
    if (end < totalPages - 1) pages.push('…');
    pages.push(totalPages); return pages;
  }
  function renderPagination(payload) {
    var total = Number(payload.total || 0); var totalPages = Math.max(0, Number(payload.totalPages || 0));
    recordsPage = Math.max(1, Number(payload.page || recordsPage)); recordsPageSize = Number(payload.pageSize || recordsPageSize);
    byId('systemActivationPageSize').value = String(recordsPageSize); text('systemActivationRecordTotal', '共' + total + '条记录');
    var buttons = byId('systemActivationPageButtons'); buttons.replaceChildren();
    function button(label, page, disabled, current) {
      var node = document.createElement('button'); node.type = 'button'; node.className = 'page' + (label === '上一页' || label === '下一页' ? ' page-nav' : '') + (disabled ? ' disabled' : '') + (current ? ' on' : ''); node.textContent = label; node.disabled = disabled;
      if (!disabled && !current) node.addEventListener('click', function () { recordsPage = page; loadRecords().catch(function () {}); });
      buttons.appendChild(node);
    }
    button('上一页', recordsPage - 1, recordsPage <= 1, false);
    pageRange(recordsPage, totalPages).forEach(function (page) { if (page === '…') { var ellipsis = document.createElement('span'); ellipsis.className = 'page-ellipsis'; ellipsis.textContent = page; buttons.appendChild(ellipsis); } else button(String(page), page, false, page === recordsPage); });
    button('下一页', recordsPage + 1, totalPages === 0 || recordsPage >= totalPages, false);
  }
  function loadRecords(fallbackPrevious) {
    text('systemActivationRecordStatus', '正在读取管理员记录…');
    return request('/api/system/activation-codes?' + recordQuery()).then(function (payload) {
      var items = Array.isArray(payload.items) ? payload.items : [];
      if (fallbackPrevious && !items.length && recordsPage > 1) { recordsPage -= 1; return loadRecords(false); }
      renderRecords(items); renderPagination(payload); text('systemActivationRecordStatus', items.length ? '已读取当前页' + items.length + '条管理员记录。' : '暂无符合当前筛选条件的记录。');
    }).catch(function (error) { text('systemActivationRecordStatus', error.message || '管理员记录读取失败。'); throw error; });
  }
  function voidCode(item, button) {
    if (!window.confirm('确定作废激活码 ' + String(item.code || '该历史激活码') + '？作废后不能恢复或兑换。')) return;
    button.disabled = true; text('systemActivationRecordStatus', '正在作废…');
    request('/api/system/activation-codes/' + encodeURIComponent(item.id) + '/void', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': 'system-activation-void-ui-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now()) }, body: '{}' })
      .then(function () { return loadRecords(true); }).then(function () { text('systemActivationRecordStatus', '已作废。'); }).catch(function (error) { text('systemActivationRecordStatus', error.message || '作废失败。'); button.disabled = false; });
  }
  function ellipsisCell(row, value, className) {
    var node = cell(row, '', className); var content = String(value || '--'); var span = document.createElement('span');
    span.className = 'list-ellipsis'; span.title = content; span.textContent = content; node.appendChild(span);
  }
  function money(value) { var amount = Number(value); return Number.isFinite(amount) ? (amount / 100).toFixed(2) + '元' : '--'; }
  function agentState(item) { return item.businessState || ({ issued: '未激活', paid: '已确认付款', expired: '已过期', voided: '已作废' })[item.state] || '已激活待确认付款'; }
  function emptyAgentActivationRecords(message) {
    var tbody = byId('agentActivationRecordRows'); tbody.replaceChildren(); var row = document.createElement('tr'); var node = document.createElement('td');
    node.className = 'membership-empty'; node.colSpan = 11; node.textContent = message; row.appendChild(node); tbody.appendChild(row);
  }
  function renderAgentActivationRecords(items) {
    var tbody = byId('agentActivationRecordRows'); tbody.replaceChildren(); items = Array.isArray(items) ? items : [];
    if (!items.length) return emptyAgentActivationRecords('暂无符合当前状态的代理商激活码记录');
    items.sort(function (left, right) { return Number(right.canConfirmPayment) - Number(left.canConfirmPayment); }).forEach(function (item) {
      var row = document.createElement('tr');
      adminCodeCell(row, item, 'agent-activation-code'); ellipsisCell(row, item.agent && item.agent.account || '--'); ellipsisCell(row, item.customerAccount || '--');
      var benefitLabel = item.benefitType === 'ai_beans'
        ? ('AI豆·' + Number(item.beanAmount || 0) + '豆' + (item.purpose === 'self' ? ' / 本人使用不奖励' : ' / 奖励' + Number(item.rewardBean || 0) + '豆'))
        : (item.planName || item.plan && item.plan.name || item.planCode || '--');
      ellipsisCell(row, benefitLabel); cell(row, money(item.lockedAgentPriceMinor));
      dateCell(row, item.requestedAt); dateCell(row, item.activatedAt); dateCell(row, item.paymentConfirmedAt); dateCell(row, item.benefitExpiresAt);
      cell(row, agentState(item), item.canConfirmPayment === true ? 'agent-activation-pending' : '');
      var action = document.createElement('td');
      if (item.canConfirmPayment === true) { var button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-primary'; button.textContent = '确认付款'; button.addEventListener('click', function () { confirmAgentActivationPayment(item, button); }); action.appendChild(button); }
      if (!action.childNodes.length) action.textContent = '--';
      row.appendChild(action); tbody.appendChild(row);
    });
  }
  function loadAgentActivationRecords() {
    var status = byId('agentActivationStatusFilter').value; text('agentActivationRecordStatus', '正在读取代理商激活码记录…');
    return request('/api/system/agent-activation-codes' + (status ? '?status=' + encodeURIComponent(status) : '')).then(function (payload) {
      var items = Array.isArray(payload.items) ? payload.items : []; renderAgentActivationRecords(items);
      text('agentActivationRecordStatus', items.length ? '已读取' + items.length + '条管理员记录；待处理记录优先显示。' : '暂无符合当前状态的记录。');
    }).catch(function (error) { emptyAgentActivationRecords(error.message || '代理商激活码记录读取失败。'); text('agentActivationRecordStatus', error.message || '代理商激活码记录读取失败。'); throw error; });
  }
  function notifyMembershipViews() {
    if (!window.BroadcastChannel) return;
    var channel = new BroadcastChannel('wyerp-membership-status'); channel.postMessage({ type: 'membership-payment-confirmed' }); channel.close();
  }
  function confirmAgentActivationPayment(item, button) {
    if (!window.confirm('确认代理商会员码 ' + String(item.code || '该历史激活码') + ' 已付款吗？确认后将由服务端发放正式会员权益并按规则赠送AI豆，此操作不能由前端撤销。')) return;
    button.disabled = true; text('agentActivationRecordStatus', '正在提交付款确认…');
    var key = 'system-agent-payment-ui-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
    request('/api/system/agent-activation-codes/' + encodeURIComponent(item.id) + '/confirm-payment', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': key }, body: '{}' })
      .then(function () { return Promise.all([loadAgentActivationRecords(), loadRecords(true)]); }).then(function () { notifyMembershipViews(); text('agentActivationRecordStatus', '付款已由服务端确认，列表和会员状态已刷新。'); })
      .catch(function (error) { text('agentActivationRecordStatus', error.message || '付款确认失败。'); button.disabled = false; });
  }

  function campaignTypeLabel(value) {
    return ({ spring_festival: '春节', labour_day: '劳动节', mid_autumn_national_day: '中秋国庆' })[value] || value || '--';
  }
  function campaignStateLabel(value) {
    return ({ draft: '草稿', published: '已发布', ended: '已结束', cancelled: '已取消' })[value] || value || '--';
  }
  function renderCampaigns(items) {
    var tbody = byId('membershipCampaignRows'); tbody.replaceChildren(); items = Array.isArray(items) ? items : [];
    if (!items.length) { var emptyRow = document.createElement('tr'); var emptyCell = document.createElement('td'); emptyCell.className = 'membership-empty'; emptyCell.colSpan = 9; emptyCell.textContent = '暂无会员活动'; emptyRow.appendChild(emptyCell); tbody.appendChild(emptyRow); return; }
    items.forEach(function (item) {
      var row = document.createElement('tr');
      cell(row, item.calendarYear || '--'); cell(row, campaignTypeLabel(item.campaignType)); cell(row, item.name || '--');
      dateCell(row, item.startsAt); dateCell(row, item.endsAt);
      var bonus = item.bonusDays || {}; cell(row, '月' + (bonus.month || 0) + ' / 季' + (bonus.quarter || 0) + ' / 年' + (bonus.year || 0) + '天');
      cell(row, campaignStateLabel(item.state)); cell(row, String(item.awardCount || 0));
      var action = document.createElement('td');
      if (item.state === 'draft') {
        var publish = document.createElement('button'); publish.type = 'button'; publish.className = 'btn btn-primary'; publish.textContent = '发布';
        publish.addEventListener('click', function () { campaignAction(item, 'publish', publish); }); action.appendChild(publish);
      }
      if ((item.state === 'draft' || item.state === 'published') && Number(item.awardCount || 0) === 0) {
        var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-ghost'; cancel.textContent = '取消';
        cancel.addEventListener('click', function () { campaignAction(item, 'cancel', cancel); }); action.appendChild(cancel);
      }
      if (!action.childNodes.length) action.textContent = '--';
      row.appendChild(action); tbody.appendChild(row);
    });
  }
  function loadCampaigns() {
    text('membershipCampaignStatus', '正在读取会员活动…');
    return request('/api/system/membership-campaigns').then(function (payload) {
      var items = Array.isArray(payload.items) ? payload.items : []; renderCampaigns(items);
      text('membershipCampaignStatus', items.length ? '已读取' + items.length + '个会员活动。' : '暂无会员活动，可先保存草稿。');
    }).catch(function (error) { text('membershipCampaignStatus', error.message || '会员活动读取失败。'); throw error; });
  }
  function campaignAction(item, action, button) {
    var verb = action === 'publish' ? '发布' : '取消';
    if (!window.confirm('确定' + verb + '活动“' + String(item.name || '') + '”吗？')) return;
    button.disabled = true; text('membershipCampaignStatus', '正在' + verb + '活动…');
    request('/api/system/membership-campaigns/' + encodeURIComponent(item.id) + '/' + action, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken }, body: '{}' })
      .then(function () { return loadCampaigns(); }).then(function () { text('membershipCampaignStatus', '活动已' + verb + '。'); })
      .catch(function (error) { text('membershipCampaignStatus', error.message || ('活动' + verb + '失败。')); button.disabled = false; });
  }

  byId('systemActivationTenant').addEventListener('change', function () { updateFields(); recordsPage = 1; loadRecords().catch(function () {}); });
  byId('systemActivationPlan').addEventListener('change', updateFields);
  byId('systemActivationBenefit').addEventListener('change', updateFields);
  byId('systemActivationBeanAmount').addEventListener('input', updateFields);
  byId('systemActivationRecordsRefresh').addEventListener('click', function () { loadRecords().catch(function () {}); });
  byId('agentActivationRecordsRefresh').addEventListener('click', function () { loadAgentActivationRecords().catch(function () {}); });
  byId('agentActivationStatusFilter').addEventListener('change', function () { loadAgentActivationRecords().catch(function () {}); });
  byId('systemActivationTypeFilter').addEventListener('change', function () { updateBenefitFilter(); recordsPage = 1; loadRecords().catch(function () {}); });
  byId('systemActivationStatusFilter').addEventListener('change', function () { recordsPage = 1; loadRecords().catch(function () {}); });
  byId('systemActivationBenefitFilter').addEventListener('change', function () { recordsPage = 1; loadRecords().catch(function () {}); });
  byId('systemActivationPageSize').addEventListener('change', function () { recordsPageSize = Number(byId('systemActivationPageSize').value); recordsPage = 1; loadRecords().catch(function () {}); });
  byId('membershipCampaignRefresh').addEventListener('click', function () { loadCampaigns().catch(function () {}); });
  byId('membershipCampaignForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var body = {
      calendarYear: Number(byId('membershipCampaignYear').value),
      campaignType: byId('membershipCampaignType').value,
      name: byId('membershipCampaignName').value.trim(),
      startsAtBeijing: byId('membershipCampaignStartsAt').value,
      endsAtBeijing: byId('membershipCampaignEndsAt').value
    };
    var button = byId('membershipCampaignSave'); button.disabled = true; text('membershipCampaignStatus', '正在保存活动草稿…');
    request('/api/system/membership-campaigns', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken }, body: JSON.stringify(body) })
      .then(function () { return loadCampaigns(); }).then(function () { text('membershipCampaignStatus', '活动草稿已保存，确认起止时间后可发布。'); })
      .catch(function (error) { text('membershipCampaignStatus', error.message || '活动草稿保存失败。'); })
      .finally(function () { button.disabled = false; });
  });

  byId('systemActivationForm').addEventListener('submit', function (event) {
    event.preventDefault(); if (!account) return text('systemActivationStatus', '账号状态尚未读取完成。'); oneTimeCode = '';
    var benefitType = byId('systemActivationBenefit').value; var body = { targetTenantId: byId('systemActivationTenant').value, benefitType: benefitType, reason: byId('systemActivationReason').value };
    if (benefitType === 'membership') body.planCode = byId('systemActivationPlan').value; else body.beanAmount = Number(byId('systemActivationBeanAmount').value);
    if (!body.targetTenantId) return text('systemActivationStatus', '请选择客户空间。');
    var button = byId('systemActivationButton'); button.disabled = true; text('systemActivationStatus', '正在生成一张激活码…');
    request('/api/system/activation-codes', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': intentKey(body) }, body: JSON.stringify(body) })
      .then(function (payload) { if (payload.code) showCode(payload); else text('systemActivationStatus', '申请已成功，请在管理员记录中查看完整码。'); intent = null; byId('systemActivationReason').value = ''; return loadRecords().catch(function () {}); })
      .catch(function (error) { text('systemActivationStatus', error.message || '管理员生成激活码失败。'); }).finally(function () { button.disabled = false; });
  });

  Promise.all([request('/api/auth/me'), request('/api/system/tenants'), request('/api/membership/plans')]).then(function (values) {
    if (!values[0].isSystemAdmin) throw new Error('仅系统管理员可访问。'); account = values[0]; renderOptions(Array.isArray(values[1].items) ? values[1].items : [], Array.isArray(values[2].items) ? values[2].items : []); byId('membershipCampaignYear').value = String(new Date().getFullYear()); request('/api/auth/profile').then(function (payload) { renderAdminAvatar(payload.profile); }).catch(function () { renderAdminAvatar(null); }); return Promise.all([loadRecords(), loadAgentActivationRecords(), loadCampaigns()]);
  }).catch(function (error) { text('agentAdminModeBadge', '服务异常'); text('systemActivationStatus', error.message || '统一激活码数据读取失败。'); });
  window.addEventListener('pagehide', function () { oneTimeCode = ''; byId('systemActivationStatus').replaceChildren(); });
}());
