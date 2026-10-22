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
    if (isLogin) {
      hide(document.getElementById('emailSuffixHelper'));
      hide(document.getElementById('switchMode'));
      hide(document.getElementById('forgotPassword'));
      hide(document.getElementById('emailCodeWrap'));
      hide(document.getElementById('inviteCodeWrap'));
      hide(document.getElementById('tenantSelectWrap'));
      var identifier = document.getElementById('identifier');
      if (identifier) {
        identifier.placeholder = '管理员账号 admin';
        identifier.setAttribute('aria-label', '管理员账号');
        if (!identifier.value.trim()) identifier.value = 'admin';
      }
      var subtitle = document.getElementById('formSub');
      if (subtitle) subtitle.textContent = '本机管理员 · 密码登录';
      var hint = document.getElementById('formHint');
      if (hint) hint.textContent = '单机版不需要邮箱、注册、会员或合同。请使用安装时创建的管理员密码和图形验证码登录。';
    }
    var excluded = /(?:membership|contract-terms|agent-|agent\/|activation|referral|invite|email\/send|register)/i;
    document.querySelectorAll('a[href], button[data-href], [data-page], [data-route]').forEach(function (node) {
      var destination = node.getAttribute('href') || node.getAttribute('data-href') ||
        node.getAttribute('data-page') || node.getAttribute('data-route') || '';
      if (excluded.test(destination)) hide(node.closest('li') || node);
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