(function (root, factory) {
  'use strict';
  const api = factory(root.WyCapture);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.WySellerBinding = api; if (root.document && root.chrome?.runtime?.id) api.mount(root.document, root.location.href, root.chrome); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';
  function detectStoreId(doc) {
    if (!doc || !doc.documentElement) return '';
    try {
      const html = String(doc.documentElement.innerHTML || '');
      const ids = new Set();
      const patterns = [
        /["']userCompanyId["']\s*:\s*["']?([1-9]\d{2,19})["']?/g,
        /&quot;userCompanyId&quot;\s*:\s*(?:&quot;)?([1-9]\d{2,19})(?:&quot;)?/g
      ];
      for (const pattern of patterns) for (const match of html.matchAll(pattern)) ids.add(match[1]);
      if (ids.size === 1) return Array.from(ids)[0];
    } catch (_) {}
    try {
      const rootNode = doc.body || doc.documentElement;
      if (!rootNode || !doc.createTreeWalker) return '';
      for (const field of Array.from(doc.querySelectorAll('input')).slice(0, 500)) {
        if (field.closest?.('#wyerp-seller-binder')) continue;
        const ownLabel = [field.getAttribute?.('aria-label'), field.getAttribute?.('placeholder'), field.name].filter(Boolean).join(' ');
        const linked = field.id ? doc.querySelector('label[for="' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(field.id) : field.id.replace(/[^a-zA-Z0-9_-]/g, '')) + '"]') : null;
        const context = C.cleanText([ownLabel, linked?.textContent, field.parentElement?.textContent].filter(Boolean).join(' '), 300);
        const value = String(field.value || '').trim();
        if (/(?:Client[\s-]*ID|ID\s*клиента)/i.test(context) && /^[1-9]\d{2,19}$/.test(value)) return value;
      }
      const walker = doc.createTreeWalker(rootNode, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      for (let node = walker.nextNode(), seen = 0; node && seen < 30000; node = walker.nextNode(), seen += 1) {
        const labelText = C.cleanText(node.nodeValue, 80);
        if (!/^(?:Client[\s-]*ID|ID\s*клиента|店铺\s*Client[\s-]*Id)$/i.test(labelText)) continue;
        let parent = node.parentElement;
        for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
          if (parent.closest?.('#wyerp-seller-binder')) break;
          const context = C.cleanText(parent.textContent, 500);
          const value = context.match(/(?:Client[\s-]*ID|ID\s*клиента|店铺\s*Client[\s-]*Id)\s*[:№#]?\s*([1-9]\d{2,19})/i)?.[1];
          if (value) return value;
        }
      }
    } catch (_) {}
    return '';
  }

  function mount(doc, pageUrl, extension) {
    let page; try { page = new URL(pageUrl); } catch (_) { return null; }
    if (page.protocol !== 'https:' || !['seller.ozonru.cn','seller.ozon.ru'].includes(page.hostname) || doc.getElementById('wyerp-seller-binder')) return doc.getElementById('wyerp-seller-binder');
    const container = doc.createElement('div'); container.id = 'wyerp-seller-binder';
    const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = '网研ERP 绑定Ozon店铺'; toggle.title = '展开或收起Ozon卖家店铺绑定'; toggle.setAttribute('aria-expanded', 'false'); toggle.hidden = true;
    const panel = doc.createElement('div'); panel.hidden = true;
    const note = doc.createElement('p'); note.textContent = '一键识别当前Seller登录店铺，并与网研ERP店铺列表核对；Cookie仅加密保存到网研ERP，不在扩展中持久化。';
    const choice = doc.createElement('label'); choice.textContent = '选择当前登录店铺'; choice.hidden = true;
    const select = doc.createElement('select'); select.setAttribute('aria-label', '选择当前登录的Ozon店铺'); choice.append(select);
    const confirm = doc.createElement('button'); confirm.type = 'button'; confirm.textContent = '一键绑定当前登录店铺';
    const status = doc.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    panel.append(note, choice, confirm, status); container.append(toggle, panel); (doc.body || doc.documentElement).append(container);

    let visibleStoreId = '';
    const embeddedCompanyId = () => {
      const html = String(doc.documentElement?.innerHTML || '');
      const ids = new Set();
      const patterns = [
        /["']userCompanyId["']\s*:\s*["']?([1-9]\d{2,19})["']?/g,
        /&quot;userCompanyId&quot;\s*:\s*(?:&quot;)?([1-9]\d{2,19})(?:&quot;)?/g
      ];
      for (const pattern of patterns) for (const match of html.matchAll(pattern)) ids.add(match[1]);
      return ids.size === 1 ? Array.from(ids)[0] : '';
    };
    const visibleClientId = () => {
      const rootNode = doc.body || doc.documentElement;
      if (!rootNode || !doc.createTreeWalker) return '';
      for (const field of Array.from(doc.querySelectorAll('input')).slice(0, 500)) {
        if (field.closest?.('#wyerp-seller-binder')) continue;
        const ownLabel = [field.getAttribute?.('aria-label'), field.getAttribute?.('placeholder'), field.name].filter(Boolean).join(' ');
        const linked = field.id ? doc.querySelector('label[for="' + (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(field.id) : field.id.replace(/[^a-zA-Z0-9_-]/g, '')) + '"]') : null;
        const context = C.cleanText([ownLabel, linked?.textContent, field.parentElement?.textContent].filter(Boolean).join(' '), 300);
        const value = String(field.value || '').trim();
        if (/(?:Client[\s-]*ID|ID\s*клиента)/i.test(context) && /^[1-9]\d{2,19}$/.test(value)) return value;
      }
      const walker = doc.createTreeWalker(rootNode, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      for (let node = walker.nextNode(), seen = 0; node && seen < 30000; node = walker.nextNode(), seen += 1) {
        const labelText = C.cleanText(node.nodeValue, 80);
        if (!/^(?:Client[\s-]*ID|ID\s*клиента|店铺\s*Client[\s-]*Id)$/i.test(labelText)) continue;
        let parent = node.parentElement;
        for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) {
          if (parent.closest?.('#wyerp-seller-binder')) break;
          const context = C.cleanText(parent.textContent, 500);
          const value = context.match(/(?:Client[\s-]*ID|ID\s*клиента|店铺\s*Client[\s-]*Id)\s*[:№#]?\s*([1-9]\d{2,19})/i)?.[1];
          if (value) return value;
        }
      }
      return '';
    };
    const refreshVisibleId = () => { visibleStoreId = embeddedCompanyId() || visibleClientId(); return visibleStoreId; };
    // 性能：不再在所有 Seller 页面启动30秒全页观察；仅在用户实际绑定时识别店铺。

    const showChoices = shops => {
      select.replaceChildren();
      for (const shop of Array.isArray(shops) ? shops : []) {
        const option = doc.createElement('option'); option.value = String(shop.clientId || ''); option.textContent = C.cleanText(shop.name || 'Ozon店铺', 120) + ' · ' + option.value; select.append(option);
      }
      if (visibleStoreId && Array.from(select.options).some(option => option.value === visibleStoreId)) select.value = visibleStoreId;
      choice.hidden = select.options.length < 2;
    };
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) {
        refreshVisibleId();
        const analytics = doc.getElementById('wyerp-seller-analytics'); const analyticsPanel = analytics?.querySelector('.wyerp-analysis-panel'); const analyticsButton = analytics?.querySelector('.wyerp-analysis-launcher');
        if (analyticsPanel) analyticsPanel.hidden = true; if (analyticsButton) analyticsButton.setAttribute('aria-expanded', 'false'); confirm.focus();
      }
    });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true; status.textContent = '正在识别当前Seller登录店铺并核对网研ERP店铺列表…'; container.dataset.state = 'busy';
      try {
        const response = await extension.runtime.sendMessage({ type: 'bind-seller-store', storeId: choice.hidden ? refreshVisibleId() : select.value });
        if (!response?.ok) {
          if (response?.code === 'shop_selection_required' && Array.isArray(response.shops) && response.shops.length) { showChoices(response.shops); choice.hidden = false; panel.hidden = false; }
          throw new Error(response?.message || '绑定失败。');
        }
        status.textContent = '已绑定当前登录店铺：' + response.storeId + '；Cookie已加密保存到网研ERP。'; container.dataset.state = 'success'; choice.hidden = true; panel.hidden = true;
        const view = doc.defaultView;
        if (view?.CustomEvent) view.dispatchEvent(new view.CustomEvent('wyerp-seller-store-bound'));
        if (view?.CustomEvent) view.dispatchEvent(new view.CustomEvent('wyerp-seller-binding-result', { detail: { ok: true, message: status.textContent } }));
      } catch (error) {
        const errorMessage = C.cleanText(error?.message || '绑定失败。', 240);
        if (/Extension context invalidated/i.test(errorMessage)) {
          status.textContent = '插件刚完成更新，正在重新载入当前页面…'; container.dataset.state = 'busy';
          const view = doc.defaultView;
          if (view?.CustomEvent) view.dispatchEvent(new view.CustomEvent('wyerp-seller-binding-result', { detail: { ok: false, reloading: true, message: status.textContent } }));
          if (view?.location) view.setTimeout(() => view.location.reload(), 120);
          return;
        }
        status.textContent = errorMessage; container.dataset.state = 'error';
        if (choice.hidden) panel.hidden = true;
        const view = doc.defaultView;
        if (view?.CustomEvent) view.dispatchEvent(new view.CustomEvent('wyerp-seller-binding-result', { detail: { ok: false, message: status.textContent, selectionRequired: !choice.hidden } }));
      }
      finally { confirm.disabled = false; }
    });
    doc.defaultView?.addEventListener('wyerp-request-seller-binding', () => {
      if (!confirm.disabled) confirm.click();
    });
    return container;
  }
  return { mount, detectStoreId };
});
