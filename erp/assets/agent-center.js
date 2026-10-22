(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var node = byId(id); if (node) node.textContent = value; }
  function date(value) {
    var parsed = value ? new Date(value) : null;
    return parsed && !isNaN(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : '--';
  }
  function money(value) { return '¥' + (Number(value || 0) / 100).toFixed(0); }
  function request(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { Accept: 'application/json' } }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) {
          var error = new Error(payload.message || '代理商功能请求未完成，请稍后重试。'); error.code = payload.error || '';
          throw error;
        }
        return payload;
      });
    });
  }
  // 中文提示由服务端在拦截点当场给出，页面不再维护错误码对照表。
  function requestError(error) {
    var message = String((error && error.message) || '');
    return /[\u3400-\u9fff]/.test(message) ? message : '代理商功能操作未完成，请稍后重试。';
  }
  function cell(row, value) {
    var node = document.createElement('td'); node.textContent = value; row.appendChild(node);
  }
  function dateLines(value) {
    var parsed = value ? new Date(value) : null;
    if (!parsed || isNaN(parsed.getTime())) return ['--'];
    var pad = function (number) { return String(number).padStart(2, '0'); };
    return [parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()), pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds())];
  }
  function dateCell(row, value) {
    var node = document.createElement('td'); node.className = 'agent-date-cell';
    dateLines(value).forEach(function (part) { var line = document.createElement('span'); line.className = 'date-line'; line.textContent = part; node.appendChild(line); });
    row.appendChild(node);
  }
  function empty(message) {
    var tbody = byId('agentCodeRows'); tbody.replaceChildren();
    var row = document.createElement('tr'); var node = document.createElement('td');
    node.className = 'membership-empty'; node.colSpan = 7; node.textContent = message;
    row.appendChild(node); tbody.appendChild(row);
  }
  function renderCodes(items) {
    var tbody = byId('agentCodeRows'); items = Array.isArray(items) ? items : [];
    if (!items.length) return empty('暂无激活码记录');
    tbody.replaceChildren();
    items.forEach(function (item) {
      var row = document.createElement('tr');
      cell(row, item.codeMask || '****');
      var benefitText = item.benefitType === 'ai_beans'
        ? ((item.planName || 'AI豆充值') + (item.purpose === 'self' ? ' / 本人使用不奖励' : ' / 奖励' + Number(item.rewardBean || 0) + '豆'))
        : (item.planName || '--');
      cell(row, benefitText);
      cell(row, item.purpose === 'self' ? '本人使用' : '客户使用');
      dateCell(row, item.requestedAt);
      dateCell(row, item.expiresAt);
      var states = { issued: '未使用', used_temporary: '临时会员', payment_review: '付款审核中', paid: '已付款', voided: '已作废', expired: '已过期', frozen: '已冻结', refunded: '已退款', reversed: '已冲正' };
      var stateText = item.benefitType === 'ai_beans' && item.state === 'paid' ? '已核销' : (states[item.state] || item.state || '--');
      cell(row, stateText);
      var action = document.createElement('td');
      if (item.canVoid) {
        var button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline agent-code-void';
        button.dataset.action = 'void-code'; button.dataset.codeId = item.id; button.textContent = '作废'; action.appendChild(button);
      } else action.textContent = '--';
      row.appendChild(action);
      tbody.appendChild(row);
    });
  }
  function clearOneTimeCode() {
    text('agentOneTimeCode', '');
    byId('agentOneTimeCodeBox').hidden = true;
  }
  var requestEnabled = false;
  var agentReferralCode = '';
  function renderReferral(referral, active) {
    referral = referral || {};
    var eligible = active && referral.eligible === true && /^WY[A-F0-9]{10}$/.test(String(referral.code || ''));
    agentReferralCode = eligible ? String(referral.code) : '';
    text('agentReferralState', eligible ? '可邀请' : '当前不可邀请');
    text('agentReferralCode', agentReferralCode || '--');
    text('agentReferralInvited', String(Number(referral.validInvitedCount || 0)));
    text('agentReferralGroupCredits', String(Number(referral.groupCreditCount || 0)));
    text('agentReferralPaidCredits', String(Number(referral.paidCreditCount || 0)));
    text('agentReferralUsedCredits', String(Number(referral.usedCreditCount || 0)));
    text('agentReferralRemainingCredits', String(Number(referral.remainingCreditCount || 0)));
    byId('agentReferralCopyCode').disabled = !eligible;
    byId('agentReferralCopyLink').disabled = !eligible;
    text('agentReferralStatus', eligible
      ? '邀请码长期绑定代理商主账号；普通用户完成邮箱验证注册后计入有效邀请。'
      : '只有有效代理商主账号可以继续邀请；资格暂停或取消后邀请码不可用于新注册。');
  }
  function copyAgentReferral(kind) {
    if (!agentReferralCode) return text('agentReferralStatus', '当前没有可用的代理邀请码。');
    var value = kind === 'link' ? location.origin + '/login.html?invite=' + encodeURIComponent(agentReferralCode) : agentReferralCode;
    function done() { text('agentReferralStatus', kind === 'link' ? '代理邀请链接已复制。' : '代理邀请码已复制。'); }
    function fallback() {
      var area = document.createElement('textarea'); area.value = value; document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); done(); } catch (error) { text('agentReferralStatus', '复制失败，请手动复制代理邀请码。'); }
      area.remove ? area.remove() : document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(done, fallback); else fallback();
  }
  function renderOverview(payload) {
    var agent = payload.agent || {}; var settings = payload.settings || {};
    var sales = agent.sales || {}; var qualification = sales.qualification || {}; var financial = agent.financial || {};
    var active = agent.status === 'active';
    renderReferral(agent.referral, active);
    var depositReady = agent.depositMode !== 'required' || Number(financial.depositBalanceMinor || 0) >= Number(financial.depositRequiredMinor || 0);
    var enabled = settings.activationCodesEnabled === true && active && depositReady;
    requestEnabled = enabled;
    text('agentModeBadge', settings.activationCodesEnabled === true ? (enabled ? '激活码灰度开启' : '当前不可申请') : '申请功能关闭');
    var agentStates = { active: '有效代理商', pending: '待确认保证金', suspended: '资格已暂停', cancelled: '资格已取消', permanently_banned: '永久取消资格' };
    text('agentQualification', agentStates[agent.status] || '资格状态待核对');
    text('agentExpiry', '资格到期：' + date(agent.expiresAt));
    text('agentMonthPrice', money(agent.prices && agent.prices.month));
    text('agentPriceBasis', '价格周期：' + String(sales.priceCycleMonth || '--') + '起；上月客户当量：' + String(agent.previousMonthEquivalents || 0));
    text('agentCredit', String(agent.creditScore == null ? '--' : agent.creditScore) + '分 / ' + (agent.depositMode === 'required'
      ? '保证金' + money(financial.depositBalanceMinor) + ' / 应有' + money(financial.depositRequiredMinor)
      : '免押金') + ' / 欠款' + money(financial.payableMinor));
    var current = sales.currentMonth || {};
    text('agentMonthCodes', String(current.validCustomerOrders || 0) + ' 客户 / ' + String(current.validSelfOrders || 0) + ' 自购');
    var states = { newcomer_monitoring: '新人首单观察期', transition: '第46—60天过渡期', settlement_pending: '等待每月4日结算', met: '本期已达标', pending_review_protected: '有效凭证待审，资格受保护', shortfall_grace: '7天补单期', monthly_shortfall: '本期未达标', first_order_shortfall: '45天内未完成首单', cancelled: '资格已取消', restored_after_correction: '更正后已恢复资格' };
    text('agentSalesStatus', states[qualification.state] || '资格规则由服务端核对。');
    ['agentBenefitType', 'agentCodeRequestButton'].forEach(function (id) { byId(id).disabled = !enabled; });
    syncBenefitType();
    var blockedReason = settings.activationCodesEnabled !== true ? '激活码功能尚未开放。'
      : !active ? '当前资格不是有效状态，暂不能申请激活码。'
        : !depositReady ? '保证金尚未由管理员确认或未补足1000元，暂不能申请激活码。'
          : '请选择方案和用途。';
    text('agentCodeRequestStatus', blockedReason);
  }

  function renderAgentAvatar(profile) {
    profile = profile || {};
    var image = byId('agentAvatarImage'), fallback = byId('agentAvatarFallback');
    var url = String(profile.displayAvatarUrl || profile.avatarUrl || '').trim();
    var letter = String(profile.avatarLetter || profile.fullName || (account && (account.displayName || account.username)) || '代').trim().slice(0,1);
    if (image) {
      image.hidden = !url;
      if (url) { image.src = url; image.onerror = function () { image.hidden = true; if (fallback) fallback.hidden = false; }; }
      else image.removeAttribute('src');
    }
    if (fallback) { fallback.textContent = letter || '代'; fallback.hidden = Boolean(url); }
  }
  var account = null;
  function rewardForBeans(amount) { var value = Number(amount); return Number.isSafeInteger(value) && value > 0 ? Math.floor(value * 30 / 100) : 0; }
  function syncBenefitType() {
    var beanMode = byId('agentBenefitType').value === 'bean_recharge';
    byId('agentMembershipPlanField').hidden = beanMode;
    byId('agentBeanAmountField').hidden = !beanMode;
    byId('agentPlanCode').disabled = !requestEnabled || beanMode;
    byId('agentBeanAmount').disabled = !requestEnabled || !beanMode;
    byId('agentCodePurpose').disabled = !requestEnabled;
    syncPurpose();
  }
  function syncPurpose() {
    var customer = byId('agentCodePurpose').value === 'customer'; var input = byId('agentCustomerAccount');
    byId('agentCustomerAccountField').hidden = !customer;
    input.disabled = !requestEnabled || !customer;
    if (!customer) input.value = '';
    if (byId('agentBenefitType').value === 'bean_recharge') {
      text('agentBeanRewardHint', customer
        ? '客户使用：代理奖励按购买豆数30%取整数，本档奖励' + rewardForBeans(byId('agentBeanAmount').value) + '豆。'
        : '本人使用：可正常充值AI豆，但不额外发放代理奖励。');
    }
  }
  Promise.all([request('/api/agent/overview'), request('/api/agent/activation-codes'), request('/api/auth/me'), request('/api/auth/profile')]).then(function (values) {
    account = values[2]; renderAgentAvatar(values[3] && values[3].profile); renderOverview(values[0]); renderCodes(values[1].items);
  }).catch(function (error) {
    text('agentModeBadge', '服务异常'); text('agentCodeRequestStatus', error.message || '代理商数据读取失败'); empty('代理商数据读取失败');
  });

  byId('agentReferralCopyCode').addEventListener('click', function () { copyAgentReferral('code'); });
  byId('agentReferralCopyLink').addEventListener('click', function () { copyAgentReferral('link'); });

  byId('agentCodeRequestForm').addEventListener('submit', function (event) {
    event.preventDefault(); clearOneTimeCode();
    if (!account) return text('agentCodeRequestStatus', '账号状态尚未读取完成。');
    var purpose = byId('agentCodePurpose').value; var customerAccount = byId('agentCustomerAccount').value.trim();
    if (purpose === 'customer' && !customerAccount) return text('agentCodeRequestStatus', '请输入客户登录邮箱或手机号。');
    var button = byId('agentCodeRequestButton'); button.disabled = true;
    var key = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    text('agentCodeRequestStatus', '正在申请…');
    var benefitType = byId('agentBenefitType').value;
    var body = { benefitType: benefitType, purpose: purpose };
    if (benefitType === 'membership') body.planCode = byId('agentPlanCode').value;
    else body.beanAmount = Number(byId('agentBeanAmount').value);
    if (purpose === 'customer') body.customerAccount = customerAccount;
    request('/api/agent/activation-codes', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': 'agent-code-ui-' + key },
      body: JSON.stringify(body)
    }).then(function (payload) {
      if (payload.code) {
        text('agentOneTimeCode', payload.code); byId('agentOneTimeCodeBox').hidden = false;
        var rewardText = payload.item && payload.item.benefitType === 'bean_recharge'
          ? (payload.item.purpose === 'self' ? '，本人使用不额外奖励' : '，代理奖励' + Number(payload.item.rewardBean || 0) + '豆已入账') : '';
        text('agentCodeRequestStatus', '申请成功' + rewardText + '。请立即保存完整代码，离开页面后无法再次查看。');
      } else text('agentCodeRequestStatus', '请求已处理；为保护安全，完整代码不会再次显示。');
      return request('/api/agent/activation-codes');
    }).then(function (payload) { renderCodes(payload.items); }).catch(function (error) {
      text('agentCodeRequestStatus', requestError(error));
    }).finally(function () { button.disabled = !requestEnabled; });
  });
  byId('agentBenefitType').addEventListener('change', syncBenefitType);
  byId('agentBeanAmount').addEventListener('change', syncBenefitType);
  byId('agentCodePurpose').addEventListener('change', syncPurpose);
  syncBenefitType();

  byId('agentCopyCode').addEventListener('click', function () {
    var code = byId('agentOneTimeCode').textContent;
    if (!code || !navigator.clipboard) return text('agentCodeRequestStatus', '请手动复制完整激活码。');
    navigator.clipboard.writeText(code).then(function () { text('agentCodeRequestStatus', '完整激活码已复制，请妥善保存。'); }).catch(function () { text('agentCodeRequestStatus', '复制失败，请手动复制。'); });
  });
  byId('agentClearCode').addEventListener('click', clearOneTimeCode);
  byId('agentCodeRows').addEventListener('click', function (event) {
    var button = event.target.closest('[data-action="void-code"]');
    if (!button || !account || !window.confirm('作废后无法恢复，确定作废这张未使用激活码吗？')) return;
    button.disabled = true;
    var key = window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    request('/api/agent/activation-codes/' + encodeURIComponent(button.dataset.codeId) + '/void', {
      method: 'POST', headers: { Accept: 'application/json', 'X-CSRF-Token': account.csrfToken, 'Idempotency-Key': 'agent-void-ui-' + key }
    }).then(function () {
      clearOneTimeCode(); text('agentCodeRequestStatus', '激活码已作废。'); return request('/api/agent/activation-codes');
    }).then(function (payload) { renderCodes(payload.items); }).catch(function (error) {
      text('agentCodeRequestStatus', error.message || '作废失败。'); button.disabled = false;
    });
  });
  window.addEventListener('pagehide', clearOneTimeCode);
}());
