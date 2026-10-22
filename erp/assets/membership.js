(function () {
  'use strict';

  var quotaApi = window.WYERP_MEMBERSHIP_QUOTA;

  function text(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }
  function date(value) {
    if (!value) return '--';
    var parsed = new Date(value);
    return isNaN(parsed.getTime()) ? '--' : parsed.toLocaleString('zh-CN', { hour12: false });
  }
  function request(url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error('会员信息读取失败，请稍后重试。');
      return response.json();
    });
  }
  function submitActivation(code, account) {
    var key = window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
    return fetch('/api/membership/activate', {
      method: 'POST', credentials: 'same-origin',
      headers: {
        Accept: 'application/json', 'Content-Type': 'application/json',
        'X-CSRF-Token': account.csrfToken,
        'Idempotency-Key': 'membership-ui-' + key
      },
      body: JSON.stringify({ code: code })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.message || '会员激活提交失败，请稍后重试。');
        return payload;
      });
    });
  }
  function cell(row, value, className) {
    var node = document.createElement('td');
    if (className) node.className = className;
    node.textContent = value;
    row.appendChild(node);
  }
  function dateCell(row, value, fallback) {
    var parsed = value ? new Date(value) : null;
    var node = document.createElement('td');
    node.className = 'date-cell';
    if (!parsed || isNaN(parsed.getTime())) node.textContent = fallback || '--';
    else {
      function pad(number) { return String(number).padStart(2, '0'); }
      [parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()), pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds())].forEach(function (part) {
        var line = document.createElement('span'); line.className = 'date-line'; line.textContent = part; node.appendChild(line);
      });
    }
    row.appendChild(node);
  }
  function empty(tbody, message, span) {
    tbody.replaceChildren();
    var row = document.createElement('tr');
    var node = document.createElement('td');
    node.className = 'membership-empty'; node.colSpan = span || 4; node.textContent = message;
    row.appendChild(node); tbody.appendChild(row);
  }
  var membershipHasPaidHistory = false;
  function updatePlans(items) {
    (Array.isArray(items) ? items : []).forEach(function (plan) {
      var card = document.querySelector('[data-plan-code="' + plan.code + '"]');
      if (!card) return;
      var price = card.querySelector('.plan-price strong');
      if (price) price.textContent = plan.priceMinor === 0 ? '免费体验' : String((plan.priceMinor / 100).toFixed(0));
      card.dataset.planVersion = String(plan.version || '');
      var activity = plan.activity || {}; var first = Number(activity.firstPaidBeans && activity.firstPaidBeans[plan.code]); var renewal = Number(activity.renewalBeans && activity.renewalBeans[plan.code]);
      var note = card.querySelector('.plan-activity');
      if (Number.isFinite(first) && Number.isFinite(renewal)) {
        if (!note) { note = document.createElement('p'); note.className = 'plan-activity'; card.appendChild(note); }
        note.textContent = membershipHasPaidHistory
          ? '活动赠豆：续费会员或升级会员赠' + renewal + '豆。'
          : '活动赠豆：客户空间首开正式付费赠' + first + '豆。';
      } else if (note) note.remove();
    });
  }
  var activationAvailable = false;
  function updateCurrent(payload) {
    var membership = payload && payload.membership || {};
    var settings = payload && payload.settings || {};
    var quotaGrid = document.getElementById('membershipQuotaGrid');
    if (quotaGrid && quotaApi) quotaApi.renderGroup(quotaGrid, payload);
    membershipHasPaidHistory = membership.hasPaidMembershipHistory === true;
    text('currentMembershipLevel', membership.label || '尚未开通会员');
    text('membershipModeBadge', settings.chargingEnabled || settings.activationCodesEnabled ? '功能灰度中' : '只读·交易关闭');
    text('membershipAvailability', settings.chargingEnabled
      ? '收费功能正在服务端灰度，以服务端实时状态为准。'
      : (settings.activationCodesEnabled
        ? '激活码兑换已开启；收费功能仍关闭。'
        : '方案与价格由服务端只读返回；收费和激活码开关当前关闭。'));
    var agent = document.getElementById('agentCenterLink');
    var admin = document.getElementById('membershipAdminLink');
    if (agent) agent.hidden = !(membership.isOwner && membership.agent);
    if (admin) admin.hidden = !membership.isSystemAdmin;
    var activationCard = document.getElementById('membershipActivateCard');
    var activationInput = document.getElementById('membershipActivationCode');
    var activationButton = document.getElementById('membershipActivateButton');
    if (activationCard) activationCard.hidden = !membership.isOwner;
    activationAvailable = Boolean(membership.isOwner && settings.activationCodesEnabled);
    if (activationInput) activationInput.disabled = !activationAvailable;
    if (activationButton) activationButton.disabled = !activationAvailable;
    if (membership.isOwner) text('membershipActivateStatus', settings.activationCodesEnabled ? '请输入激活码。' : '激活码功能尚未开放。');
  }
  function updateMembershipAvatar(profile, account) {
    profile = profile || {};
    account = account || {};
    var image = document.getElementById('membershipAvatarImage');
    var fallback = document.getElementById('membershipAvatarFallback');
    if (!image || !fallback) return;
    var url = String(profile.avatarUrl || '').trim();
    if (url) {
      fallback.textContent = '';
      fallback.hidden = true;
      image.src = url;
      image.hidden = false;
      return;
    }
    image.removeAttribute('src');
    image.hidden = true;
    fallback.hidden = false;
    var letter = String(profile.avatarLetter || profile.profileFullName || profile.fullName || profile.email || '用').trim();
    fallback.textContent = letter ? letter.slice(0, 2) : '用';
  }

  function updateDevices(items) {
    var tbody = document.getElementById('membershipDeviceRows');
    if (!tbody) return;
    items = Array.isArray(items) ? items : [];
    text('membershipDeviceSummary', items.filter(function (item) { return !item.revokedAt; }).length + ' 个有效会话');
    if (!items.length) return empty(tbody, '暂无设备会话', 9);
    tbody.replaceChildren();
    items.forEach(function (item) {
      var row = document.createElement('tr');
      cell(row, item.current ? '当前会话' : '其他会话');
      cell(row, item.ipAddress || '登录时未记录');
      cell(row, item.deviceId ? '浏览器设备 · ' + item.deviceId.slice(0, 8) : '登录时未记录');
      var deviceCell = document.createElement('td');
      if (item.deviceId) {
        deviceCell.textContent = item.deviceId.slice(0, 8) + '…' + item.deviceId.slice(-8);
        deviceCell.title = item.deviceId;
      } else {
        deviceCell.textContent = '登录时未记录';
      }
      row.appendChild(deviceCell);
      dateCell(row, item.createdAt);
      dateCell(row, item.revokedAt, '仍在线');
      dateCell(row, item.lastSeenAt);
      dateCell(row, item.absoluteExpiresAt);
      cell(row, item.revokedAt ? (item.revokeReason === 'replaced_by_new_login' ? '已被新登录替换' : '已退出') : (item.current ? '当前使用' : '有效'));
      tbody.appendChild(row);
    });
  }
  function updateActivations(items) {
    var tbody = document.getElementById('membershipActivationRows');
    if (!tbody) return;
    items = Array.isArray(items) ? items : [];
    var temporaryHint = document.getElementById('membershipTemporaryEntitlementHint');
    if (temporaryHint) temporaryHint.hidden = !items.some(function (item) { return ['used_temporary', 'payment_review', 'frozen'].includes(item.state); });
    if (!items.length) return empty(tbody, '暂无激活码使用记录', 5);
    tbody.replaceChildren();
    var stateLabels = { issued: '已申请', used_temporary: '已激活', payment_review: '已激活', paid: '已激活', used: '已激活', voided: '已作废', expired: '已过期', frozen: '已激活', refunded: '已激活', reversed: '已激活' };
    items.forEach(function (item) {
      var row = document.createElement('tr');
      var bean = item.benefitType === 'bean_recharge' || item.benefitType === 'ai_beans';
      var benefit = bean ? 'AI豆·' + item.beanAmount + '豆' : (item.planName || '会员权益');
      cell(row, item.codeMask || '****'); cell(row, benefit); dateCell(row, item.usedAt); dateCell(row, bean ? null : item.benefitExpiresAt, bean ? '无到期时间' : '--'); cell(row, stateLabels[item.state] || '已激活');
      tbody.appendChild(row);
    });
  }

  function updateReferral(payload) {
    var card = document.getElementById('membershipReferralCard');
    var referral = payload && payload.referral || {};
    if (!card) return;
    if (referral.eligible !== true || !referral.code) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    card.dataset.code = String(referral.code);
    card.dataset.inviteUrl = location.origin + '/login.html?invite=' + encodeURIComponent(String(referral.code));
    text('membershipReferralCode', referral.code);
    text('membershipReferralInvitedCount', String(Number(referral.invitedCount || 0)));
    text('membershipReferralPaidCount', String(Number(referral.paidRewardCount || 0)));
    text('membershipReferralStatus', '邀请码长期有效；一个普通账号终身只能绑定一个邀请人。新人邀请奖励 ' + Number(referral.signupRewardBean || 1000) + ' AI豆，首次付费会员奖励邀请人 ' + Number(referral.paidRewardBean || 3000) + ' AI豆。');
  }

  function copyReferralValue(kind) {
    var card = document.getElementById('membershipReferralCard');
    var value = card && (kind === 'link' ? card.dataset.inviteUrl : card.dataset.code);
    if (!value) return;
    function done() { text('membershipReferralStatus', kind === 'link' ? '邀请链接已复制。' : '邀请码已复制。'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var area = document.createElement('textarea');
      area.value = value; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.appendChild(area); area.select();
      try { document.execCommand('copy'); done(); } catch (error) { text('membershipReferralStatus', '复制失败，请手动复制邀请码。'); }
      area.remove();
    }
  }

  function updateAgentApplication(payload) {
    payload = payload || {};
    var button = document.getElementById('agentApplicationButton');
    var gates = payload.gates || {};
    document.querySelectorAll('[data-application-gate]').forEach(function (item) {
      item.classList.toggle('is-ready', gates[item.dataset.applicationGate] === true);
    });
    if (payload.existingAgent) {
      text('agentApplicationStatus', '当前客户空间已有代理商记录，请前往代理商中心查看资格。');
      if (button) button.textContent = '已有代理商记录';
      return;
    }
    if (!payload.featureEnabled) {
      text('agentApplicationStatus', '当前仅展示申请流程。管理员开关、正式合同、材料入口和人工审核尚未全部就绪。');
      if (button) button.textContent = '申请入口未开放';
      return;
    }
    text('agentApplicationStatus', '服务器入口已打开，但正式合同仍未完成人工和法律复核，暂不能提交或签署。');
    if (button) button.textContent = '等待正式合同复核';
  }

  var referralCopyCode = document.getElementById('membershipReferralCopyCode');
  var referralCopyLink = document.getElementById('membershipReferralCopyLink');
  if (referralCopyCode) referralCopyCode.addEventListener('click', function () { copyReferralValue('code'); });
  if (referralCopyLink) referralCopyLink.addEventListener('click', function () { copyReferralValue('link'); });

  var currentAccount = null;
  var activateForm = document.getElementById('membershipActivateForm');
  if (activateForm) activateForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var input = document.getElementById('membershipActivationCode');
    var button = document.getElementById('membershipActivateButton');
    var code = String(input && input.value || '').trim();
    if (!currentAccount || !code) return text('membershipActivateStatus', '请输入激活码。');
    if (!/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){5}$/.test(code.toUpperCase())) return text('membershipActivateStatus', '请输入六组四位的激活码。');
    button.disabled = true;
    text('membershipActivateStatus', '正在激活…');
    submitActivation(code, currentAccount).then(function (payload) {
      var successMessage = payload.beans
        ? 'AI豆充值已到账：本次入账' + payload.beans.addedBean + '豆，当前余额' + payload.beans.balanceAfter + '豆。'
        : (payload.warning || '激活成功。');
      return Promise.all([request('/api/membership/current'), request('/api/membership/activation-records')])
        .then(function (values) { return { values: values, successMessage: successMessage }; });
    }).then(function (result) {
      updateCurrent(result.values[0]); updateActivations(result.values[1].items);
      text('membershipActivateStatus', result.successMessage);
    }).catch(function (error) {
      text('membershipActivateStatus', error.message || '激活失败。');
    }).finally(function () {
      if (input) input.value = '';
      if (button) button.disabled = !activationAvailable;
    });
  });

  Promise.all([request('/api/membership/current'), request('/api/membership/plans'), request('/api/membership/devices'), request('/api/auth/me'), request('/api/auth/profile')]).then(function (values) {
    currentAccount = values[3];
    var profile = values[4] && values[4].profile || {};
    var identity = window.WYERP_IDENTITY_DISPLAY.displayIdentity({
      profileFullName: profile.profileFullName,
      email: profile.email,
      isSystemAdmin: profile.isSystemAdmin || (currentAccount && currentAccount.isSystemAdmin)
    });
    var greeting = document.getElementById('membershipGreeting');
    text('membershipGreeting', identity.raw ? '您好，' + identity.masked : '您好，登录账号读取失败');
    if (greeting) greeting.title = identity.raw || '';
    updateMembershipAvatar(profile, currentAccount);
    updateCurrent(values[0]); updatePlans(values[1].items); updateDevices(values[2].items);
    request('/api/membership/referral').then(updateReferral).catch(function () {
      var card = document.getElementById('membershipReferralCard'); if (card) card.hidden = true;
    });
    var applicationCard = document.getElementById('agentApplicationCard');
    if (applicationCard) applicationCard.hidden = true;
    text('agentApplicationStatus', '前期暂未开放');
    if (values[0].membership && (values[0].membership.isOwner || values[0].membership.isSystemAdmin)) {
      request('/api/membership/activation-records').then(function (payload) { updateActivations(payload.items); }).catch(function () {
        empty(document.getElementById('membershipActivationRows'), '脱敏激活记录读取失败', 5);
      });
    } else empty(document.getElementById('membershipActivationRows'), '子账号不显示激活码记录', 5);
  }).catch(function () {
    text('membershipGreeting', '您好，登录账号读取失败');
    text('currentMembershipLevel', '会员状态读取失败');
    text('membershipModeBadge', '服务异常');
    text('membershipDeviceSummary', '读取失败');
    text('agentApplicationStatus', '代理商申请状态读取失败');
    empty(document.getElementById('membershipDeviceRows'), '设备会话读取失败');
    empty(document.getElementById('membershipActivationRows'), '脱敏激活记录读取失败', 5);
  });
  if (window.BroadcastChannel) {
    var membershipChannel = new BroadcastChannel('wyerp-membership-status');
    membershipChannel.addEventListener('message', function (event) {
      if (!event.data || event.data.type !== 'membership-payment-confirmed') return;
      Promise.all([request('/api/membership/current'), request('/api/membership/plans'), request('/api/membership/activation-records')]).then(function (values) {
        updateCurrent(values[0]); updatePlans(values[1].items); updateActivations(values[2].items);
      }).catch(function () { text('membershipAvailability', '会员状态刷新失败，请稍后重试。'); });
    });
  }
})();
