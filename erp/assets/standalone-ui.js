/* Desktop-only presentation layer. Not activated in multi-tenant SaaS mode. */
(function () {
  'use strict';
  function hide(node) {
    if (!node || node.dataset.standaloneHidden === '1') return;
    node.dataset.standaloneHidden = '1';
    node.style.setProperty('display', 'none', 'important');
  }
  function simplify() {
    var isLogin = /\/login\.html$/.test(location.pathname);
    // The workspace uses direct onclick bindings, not <a href>, for these SaaS controls.
    hide(document.getElementById('headerMemberBtn'));
    hide(document.getElementById('headerBeanBtn'));
    if (isLogin) {
      hide(document.getElementById('emailSuffixHelper'));
      hide(document.getElementById('switchMode'));
      hide(document.getElementById('forgotPassword'));
      hide(document.getElementById('emailCodeWrap'));
      hide(document.getElementById('inviteCodeWrap'));
      hide(document.getElementById('tenantSelectWrap'));
      // The legacy login page only requests CAPTCHA after a failed admin login.
      // Desktop mode must show and request it on first load instead.
      var challenge = document.getElementById('captchaWrap');
      if (challenge) {
        challenge.classList.remove('auth-hidden');
        if (challenge.dataset.standaloneCaptchaInit !== '1') {
          challenge.dataset.standaloneCaptchaInit = '1';
          var refreshChallenge = document.getElementById('refreshCaptcha');
          if (refreshChallenge) refreshChallenge.click();
        }
      }
      var identifier = document.getElementById('identifier');
      if (identifier) {
        identifier.placeholder = '管理员账号 admin';
        identifier.setAttribute('aria-label', '管理员账号');
        if (!identifier.value.trim()) identifier.value = 'admin';
      }
      var subtitle = document.getElementById('formSub');
      if (subtitle) subtitle.textContent = '本机管理员 · 密码登录';
      var hint = document.getElementById('formHint');
      if (hint) hint.textContent = '单机版不需要邮箱、会员、代理或合同。全新安装初始账号 admin、密码 123456；修改过密码请使用修改后的密码，并填写图形验证码。';
    }
    var excluded = /(?:membership|ai-beans|contract-terms|agent-|agent\/|activation|referral|invite|email\/send|register|\/accounts\.html|user-monitor)/i;
    document.querySelectorAll('a[href], button[data-href], [data-page], [data-route]').forEach(function (node) {
      var destination = node.getAttribute('href') || node.getAttribute('data-href') ||
        node.getAttribute('data-page') || node.getAttribute('data-route') || '';
      if (excluded.test(destination)) hide(node.closest('li') || node);
    });
    // Hide now-empty recharge/SaaS sidebar groups, not just their links.
    document.querySelectorAll('.menu-group').forEach(function (group) {
      var links = Array.prototype.slice.call(group.querySelectorAll('a.menu-item'));
      if (links.length && links.every(function (link) { return link.dataset.standaloneHidden === '1'; })) hide(group);
    });
  }
  fetch('/api/local/standalone-mode', {credentials: 'same-origin', cache: 'no-store'})
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (mode) {
      if (!mode || mode.standalone !== true) return;
      document.documentElement.classList.add('wyerp-standalone');
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', simplify, {once:true});
      } else simplify();
      // Navigation can be generated after the page loads; hide SaaS links as they appear.
      var queued = false;
      var observer = new MutationObserver(function () {
        if (queued) return;
        queued = true;
        requestAnimationFrame(function () { queued = false; simplify(); });
      });
      observer.observe(document.documentElement, {childList:true,subtree:true});
    }).catch(function () { /* Keep original UI available if mode probe fails. */ });
})();