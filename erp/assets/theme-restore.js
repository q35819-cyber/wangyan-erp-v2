(function () {
  var dark = false;
  try { dark = localStorage.getItem('erp_theme') === 'dark'; } catch (e) {}

  var root = document.documentElement;
  var workspaceEmbedded = window.top !== window && new URLSearchParams(location.search).get('workspace') === '1';

  if (location.hash.indexOf('#wyerp-extension-reload=') === 0) {
    setTimeout(function () {
      if (location.hash.indexOf('#wyerp-extension-reload=') === 0) {
        window.dispatchEvent(new CustomEvent('wyerp:reload-extension'));
      }
    }, 1000);
  }
  root.classList.toggle('theme-dark', dark);
  root.classList.toggle('workspace-embedded-root', workspaceEmbedded);

  function applyToBody() {
    if (!document.body) return false;
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('workspace-embedded', workspaceEmbedded);
    return true;
  }

  function announceWorkspaceFrameReady() {
    if (!workspaceEmbedded || window.top === window) return;
    try {
      window.parent.postMessage({
        type: 'wyerp-workspace-frame-ready',
        route: location.pathname + location.search + location.hash
      }, location.origin);
    } catch (error) {}
  }

  function installGlobalTooltip() {
    if (window.__WYERP_GLOBAL_TOOLTIP_INSTALLED__) return;
    window.__WYERP_GLOBAL_TOOLTIP_INSTALLED__ = true;

    var tip = null;
    var activeTarget = null;
    var hideTimer = null;
    var selector = '[data-wy-tooltip],[data-ana-tip],[data-ai-tip],[data-beans-tip],[data-wy-native-title],[title]';

    function clearWorkspaceChromeTooltips(rootNode) {
      var root = rootNode && rootNode.querySelectorAll ? rootNode : document;
      var nodes = [];
      if (root.matches && root.matches('.workspace-tabs, .workspace-tabs *, .header-left, .header-left *')) nodes.push(root);
      root.querySelectorAll('.workspace-tabs [title], .workspace-tabs [data-wy-tooltip], .workspace-tabs [data-wy-native-title], .workspace-tabs [data-ana-tip], .workspace-tabs [data-ai-tip], .workspace-tabs [data-beans-tip], .header-left [title], .header-left [data-wy-tooltip], .header-left [data-wy-native-title], .header-left [data-ana-tip], .header-left [data-ai-tip], .header-left [data-beans-tip]').forEach(function (node) { nodes.push(node); });
      nodes.forEach(function (node) {
        node.removeAttribute('title');
        node.removeAttribute('data-wy-tooltip');
        node.removeAttribute('data-wy-native-title');
        node.removeAttribute('data-ana-tip');
        node.removeAttribute('data-ai-tip');
        node.removeAttribute('data-beans-tip');
      });
    }

    clearWorkspaceChromeTooltips(document);
    if (typeof MutationObserver !== 'undefined') {
      new MutationObserver(function (records) {
        records.forEach(function (record) {
          record.addedNodes && record.addedNodes.forEach(function (node) {
            if (node && node.nodeType === 1) clearWorkspaceChromeTooltips(node);
          });
        });
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    function ensureTip() {
      if (tip) return tip;
      tip = document.createElement('div');
      tip.className = 'wy-global-tooltip';
      tip.setAttribute('role', 'tooltip');
      tip.tabIndex = 0;
      tip.addEventListener('pointerenter', cancelHide);
      tip.addEventListener('pointerleave', scheduleHide);
      document.body.appendChild(tip);
      return tip;
    }

    function normalizeText(value) {
      var text = String(value == null ? '' : value)
        .replace(/\\n/g, '\n')
        .replace(/\r\n?/g, '\n')
        .trim();
      if (!text) return '';
      if (text.indexOf('\n') < 0 && text.length > 42) {
        text = text.replace(/([。！？；])\s*/g, '$1\n').trim();
      }
      return text.replace(/\n{3,}/g, '\n\n');
    }

    function textFor(target) {
      if (!target) return '';
      var names = ['data-wy-tooltip', 'data-ana-tip', 'data-ai-tip', 'data-beans-tip'];
      for (var i = 0; i < names.length; i += 1) {
        var value = target.getAttribute(names[i]);
        if (value) return normalizeText(value);
      }
      var nativeTitle = target.getAttribute('title');
      if (nativeTitle) {
        target.setAttribute('data-wy-native-title', nativeTitle);
        target.removeAttribute('title');
        return normalizeText(nativeTitle);
      }
      return normalizeText(target.getAttribute('data-wy-native-title') || '');
    }

    function findTarget(node) {
      if (!node || !node.closest) return null;
      if (node.closest('.workspace-tabs') || node.closest('.header-left')) return null;
      // 专用的费用/状态弹层由各自组件管理，避免全局title弹层盖住明细。
      if (node.closest('.fee-tip, .fee-tip-overlay, .status-tooltip')) return null;
      return node.closest(selector);
    }

    function positionFor(target, pointerEvent) {
      var node = ensureTip();
      var gap = 12;
      var anchor = target.getBoundingClientRect();
      node.style.display = 'block';
      node.style.left = '8px';
      node.style.top = '8px';
      var rect = node.getBoundingClientRect();
      var followsPointer = Boolean(pointerEvent && target && target.hasAttribute && target.hasAttribute('data-ana-tip'));
      var x, y;
      if (followsPointer) {
        x = Number(pointerEvent.clientX) + gap;
        y = Number(pointerEvent.clientY) + gap;
        if (x + rect.width > window.innerWidth - 8) x = Number(pointerEvent.clientX) - rect.width - gap;
        if (y + rect.height > window.innerHeight - 8) y = Number(pointerEvent.clientY) - rect.height - gap;
      } else {
        x = anchor.left;
        y = anchor.bottom + 8;
        if (x + rect.width > window.innerWidth - 8) x = Math.max(8, anchor.right - rect.width);
        if (y + rect.height > window.innerHeight - 8) y = Math.max(8, anchor.top - rect.height - 8);
      }
      node.style.left = Math.round(Math.max(8, x)) + 'px';
      node.style.top = Math.round(Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))) + 'px';
    }

    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    }
    function scheduleHide() {
      cancelHide();
      hideTimer = setTimeout(hide, 200);
    }
    function show(target, pointerEvent) {
      var text = textFor(target);
      if (!text) return hide();
      cancelHide();
      activeTarget = target;
      var node = ensureTip();
      node.textContent = text;
      positionFor(target, pointerEvent);
    }

    function hide() {
      cancelHide();
      activeTarget = null;
      if (tip) tip.style.display = 'none';
    }

    document.addEventListener('pointerover', function (event) {
      if (tip && tip.contains(event.target)) { cancelHide(); return; }
      var target = findTarget(event.target);
      if (!target) return;
      if (activeTarget === target && tip && tip.style.display === 'block') return;
      show(target, event);
    }, true);

    document.addEventListener('pointermove', function (event) {
      if (tip && tip.contains(event.target)) return;
      if (!activeTarget || !activeTarget.hasAttribute || !activeTarget.hasAttribute('data-ana-tip')) return;
      if (!tip || tip.style.display !== 'block') return;
      positionFor(activeTarget, event);
    }, true);

    document.addEventListener('pointerout', function (event) {
      if (tip && tip.contains(event.target)) {
        if (!tip.contains(event.relatedTarget) && (!activeTarget || !activeTarget.contains(event.relatedTarget))) scheduleHide();
        return;
      }
      if (!activeTarget) return;
      var related = event.relatedTarget;
      if (related && activeTarget.contains && activeTarget.contains(related)) return;
      if (related && tip && tip.contains(related)) { cancelHide(); return; }
      var source = findTarget(event.target);
      if (source === activeTarget) scheduleHide();
    }, true);

    document.addEventListener('focusin', function (event) {
      if (tip && tip.contains(event.target)) { cancelHide(); return; }
      var target = findTarget(event.target);
      if (!target) return;
      show(target);
    }, true);

    document.addEventListener('focusout', function (event) {
      if (activeTarget && event.target === activeTarget && (!tip || !tip.contains(event.relatedTarget))) scheduleHide();
    }, true);

    window.addEventListener('scroll', function (event) {
      if (tip && tip.contains(event.target)) return;
      hide();
    }, true);
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(); }, true);
    window.addEventListener('blur', hide);
  }

  if (!applyToBody() && typeof MutationObserver !== 'undefined') {
    var observer = new MutationObserver(function () {
      if (applyToBody()) observer.disconnect();
    });
    observer.observe(root, { childList: true });
  }

  if (document.body) installGlobalTooltip();
  document.addEventListener('DOMContentLoaded', function () {
    applyToBody();
    installGlobalTooltip();
    announceWorkspaceFrameReady();
  }, { once: true });
})();
