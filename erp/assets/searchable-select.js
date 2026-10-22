(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_SEARCHABLE_SELECT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var sequence = 0;
  function normalize(value) { return String(value == null ? '' : value).normalize('NFKC').trim().toLocaleLowerCase(); }
  function matches(item, query) { var value = normalize([item.label || '', item.value || '', item.info || ''].join(' ')); return normalize(query).split(/\s+/).every(function (word) { return value.indexOf(word) >= 0; }); }
  function key(item) { return item.id ? 'id:' + item.id : 'value:' + item.value; }
  function mount(source, config) {
    var doc = source.ownerDocument, win = doc.defaultView, uid = 'product-combo-' + (++sequence), disposed = false, opened = false, composing = false, query = '', limit = 80, active = -1;
    var state = { items: [], selected: [], disabled: false }, current = [], hidden = source.hidden, showAllTags = false, moreTag = null;
    function node(tag, cls, text) { var n = doc.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; }
    function button(cls, label, text) { var b = node('button', cls, text); b.type = 'button'; b.setAttribute('aria-label', label); return b; }
    var wrapper = node('span', 'searchable-select'), field = node('span', 'searchable-select-field'), content = node('span', 'searchable-select-content'), tags = node('span', 'searchable-select-tags'), input = node('input', 'searchable-select-input');
    if (config.compactSelection) wrapper.classList.add('searchable-select-compact');
    var tagNodes = new Map();
    var clear = button('searchable-select-clear', '清空' + config.label, '×'), arrow = button('searchable-select-arrow', '展开' + config.label + '选项', '⌄');
    var popup = node('div', 'searchable-select-popup'), listbox = node('div', 'searchable-select-list'), status = node('div', 'searchable-select-status'), retry = button('btn searchable-select-retry', '重试读取选项', '重试');
    input.type = 'text'; input.id = uid; input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', config.label); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', uid + '-list'); input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-required', source.getAttribute('aria-required') || 'false');
    input.placeholder = config.placeholder || '输入搜索或下拉选择';
    popup.hidden = true; popup.id = uid + '-popup'; listbox.id = uid + '-list'; listbox.setAttribute('role', 'listbox'); listbox.setAttribute('aria-label', config.label + '选项'); status.setAttribute('role', 'status');
    if (config.multiple) listbox.setAttribute('aria-multiselectable', 'true');
    content.append(tags, input); field.append(content, clear, arrow); wrapper.append(field); popup.append(listbox, status, retry); source.before(wrapper); source.hidden = true; source.dataset.searchableSource = 'true'; doc.body.appendChild(popup);
    var label = source.id && doc.querySelector('label[for="' + source.id + '"]'); if (label) label.htmlFor = input.id;
    function display(item) { return item.label || item.value; }
    function selectionText() { return state.selected.map(display).join('; '); }
    function restore() { input.value = ''; }
    function removeTag(token) {
      if (disposed || state.disabled) return;
      var index = state.selected.findIndex(function (item) { return key(item) === token; });
      if (index < 0) return;
      if (config.multiple) config.onRemove(index); else config.onClear();
      input.focus();
    }
    function renderTags() {
      var keep = new Set(), maxVisibleTags = Math.max(0, Number(config.maxVisibleTags || 0));
      if (moreTag && moreTag.parentNode) moreTag.remove();
      state.selected.forEach(function (item, selectedIndex) {
        var token = key(item), entry = tagNodes.get(token); keep.add(token);
        if (!entry) {
          var tag = node('span', 'searchable-select-tag'), text = node('span', 'searchable-select-tag-text');
          var remove = button('searchable-select-tag-remove', '', '×');
          remove.addEventListener('mousedown', function (event) { event.preventDefault(); });
          remove.addEventListener('click', function () { removeTag(token); });
          tag.append(text, remove); entry = { tag: tag, text: text, remove: remove }; tagNodes.set(token, entry);
        }
        entry.text.textContent = display(item); entry.tag.title = display(item);
        entry.tag.dataset.choiceId = String(item.id == null ? '' : item.id);
        entry.tag.dataset.choiceValue = String(item.value == null ? '' : item.value);
        entry.tag.dataset.choiceLabel = String(item.label == null ? '' : item.label);
        entry.remove.setAttribute('aria-label', '移除' + config.label + '：' + display(item));
        entry.remove.disabled = Boolean(state.disabled); entry.remove.hidden = Boolean(state.disabled);
        entry.tag.hidden = Boolean(maxVisibleTags && !showAllTags && selectedIndex >= maxVisibleTags);
        // Keep existing focused buttons alive when asynchronous labels refresh.
        var position = tags.children[Array.from(keep).length - 1];
        if (position !== entry.tag) tags.insertBefore(entry.tag, position || null);
      });
      tagNodes.forEach(function (entry, token) { if (!keep.has(token)) { entry.tag.remove(); tagNodes.delete(token); } });
      if (maxVisibleTags && state.selected.length > maxVisibleTags) {
        if (!moreTag) { moreTag = button('searchable-select-more', '展开更多已选项', ''); moreTag.addEventListener('mousedown', function (event) { event.preventDefault(); }); moreTag.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); showAllTags = !showAllTags; renderTags(); }); }
        moreTag.textContent = showAllTags ? '收起' : '+' + (state.selected.length - maxVisibleTags) + '…';
        moreTag.setAttribute('aria-label', showAllTags ? '收起更多已选项' : '展开另外' + (state.selected.length - maxVisibleTags) + '个已选项');
        tags.appendChild(moreTag);
      } else showAllTags = false;
      input.placeholder = state.selected.length ? '搜索' : (config.placeholder || '输入搜索或下拉选择');
      wrapper.classList.toggle('has-selection', Boolean(state.selected.length));
    }
    function position() {
      if (!opened) return;
      var rect = field.getBoundingClientRect(), width = Math.min(Math.max(rect.width, 240), win.innerWidth - 16), below = win.innerHeight - rect.bottom - 8, above = rect.top - 8;
      popup.style.width = width + 'px'; popup.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)) + 'px';
      popup.style.maxHeight = Math.min(320, Math.max(below, above)) + 'px';
      popup.style.top = (below >= 200 || below >= above ? rect.bottom + 4 : Math.max(8, rect.top - Math.min(320, above) - 4)) + 'px';
    }
    function render() {
      if (disposed) return;
      var pageClear = doc.body.dataset.productFieldClear === 'true', locked = Boolean(state.disabled || pageClear && (source.disabled || source.readOnly));
      input.disabled = locked; arrow.disabled = locked; clear.disabled = locked;
      input.setAttribute('aria-busy', String(Boolean(state.busy)));
      clear.hidden = !state.selected.length && !(pageClear && query); input.title = selectionText(); wrapper.title = selectionText(); field.title = selectionText();
      renderTags();
      if (config.compactSelection) wrapper.classList.toggle('selection-overflow', content.scrollHeight > content.clientHeight + 1);
      if (config.onSelectionRendered) config.onSelectionRendered(state.selected.slice());
      if (!opened) { restore(); return; }
      var available = state.items.slice();
      // Legacy selections remain removable even when they are outside the current dictionary page.
      if (config.multiple) state.selected.forEach(function (chosen) { if (!available.some(function (item) { return key(item) === key(chosen); })) available.unshift(chosen); });
      if (config.selectedFirst !== false && state.selected.length) {
        var selectedKeys = new Set(state.selected.map(key));
        available = available.map(function (item, index) { return { item: item, index: index }; }).sort(function (left, right) {
          var leftSelected = selectedKeys.has(key(left.item)), rightSelected = selectedKeys.has(key(right.item));
          return leftSelected === rightSelected ? left.index - right.index : rightSelected - leftSelected;
        }).map(function (entry) { return entry.item; });
      }
      current = available.filter(function (item) { return matches(item, query); });
      listbox.replaceChildren(); current.slice(0, limit).forEach(function (item, index) {
        var option = node('div', 'searchable-select-option', display(item)); option.id = uid + '-option-' + index; option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(state.selected.some(function (chosen) { return key(chosen) === key(item); }))); option.setAttribute('aria-disabled', String(Boolean(item.disabled))); option.title = item.info || display(item);
        if (config.multiple && option.getAttribute('aria-selected') === 'true') { var mark = node('span', 'searchable-select-selected-mark', '✓'); mark.setAttribute('aria-hidden', 'true'); option.appendChild(mark); option.title = display(item) + '（已选，点击移除）'; }
        option.classList.toggle('active', active === index); option.addEventListener('click', function () { pick(item); }); listbox.appendChild(option);
      });
      status.textContent = state.error || (state.busy ? '正在读取选项…' : (!current.length ? '没有匹配的选项' : (current.length > limit || state.hasNext ? '向下滚动继续显示选项' : '')));
      status.hidden = !status.textContent; retry.hidden = !state.error || !config.onRetry; retry.disabled = Boolean(state.busy);
      input.setAttribute('aria-busy', String(Boolean(state.busy))); input.removeAttribute('aria-activedescendant');
      if (active >= 0 && active < Math.min(limit, current.length)) input.setAttribute('aria-activedescendant', uid + '-option-' + active);
      position();
    }
    function open() { if (disposed || state.disabled) return; if (!opened) { opened = true; query = ''; active = -1; limit = 80; popup.hidden = false; input.setAttribute('aria-expanded', 'true'); render(); if (config.onOpen) config.onOpen(); } }
    function close() { if (!opened) return; opened = false; popup.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); restore(); if (config.onClose) config.onClose(); }
    function pick(item) {
      if (item.disabled) return;
      var index = state.selected.findIndex(function (chosen) { return key(chosen) === key(item); });
      if (config.multiple && index >= 0) config.onRemove(index); else config.onPick(item);
      query = ''; active = -1;
      if (!config.multiple) close(); else { restore(); render(); input.focus(); input.select(); }
    }
    function search() { if (composing) return; open(); query = input.value; active = -1; limit = 80; popup.scrollTop = 0; render(); if (config.onQuery) config.onQuery(query); }
    input.addEventListener('focus', function () { open(); input.select(); }); input.addEventListener('click', open); input.addEventListener('input', search);
    input.addEventListener('compositionstart', function () { composing = true; }); input.addEventListener('compositionend', function () { composing = false; search(); });
    input.addEventListener('keydown', function (event) {
      if (composing || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab') { close(); return; }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !input.value && state.selected.length) {
        event.preventDefault(); removeTag(key(state.selected[state.selected.length - 1])); return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); open(); active = Math.max(0, Math.min(current.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1))); limit = Math.max(limit, active + 1); render(); var selected = doc.getElementById(uid + '-option-' + active); if (selected) selected.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && opened) { event.preventDefault(); if (current.length) pick(current[active < 0 ? 0 : active]); }
    });
    arrow.addEventListener('mousedown', function (event) { event.preventDefault(); }); arrow.addEventListener('click', function () { if (opened) close(); else { input.focus(); open(); } });
    function clearSelection() {
      var pageClear = doc.body.dataset.productFieldClear === 'true';
      if (pageClear && (source.disabled || source.readOnly || state.disabled)) return;
      var emitted = {}, record = function (event) { emitted[event.type] = true; };
      if (pageClear) { source.addEventListener('input', record); source.addEventListener('change', record); }
      try { config.onClear(); query = ''; restore(); render(); }
      finally { if (pageClear) { source.removeEventListener('input', record); source.removeEventListener('change', record); } }
      if (pageClear) ['input','change'].forEach(function (type) { if (!emitted[type]) source.dispatchEvent(new Event(type, {bubbles:true})); });
    }
    clear.addEventListener('mousedown', function (event) { event.preventDefault(); }); clear.addEventListener('click', clearSelection);
    popup.addEventListener('mousedown', function (event) { if (event.target.closest('[role="option"]')) event.preventDefault(); });
    popup.addEventListener('scroll', function () { if (popup.scrollTop + popup.clientHeight < popup.scrollHeight - 45) return; if (limit < current.length) { limit += 80; render(); } else if (state.hasNext && !state.busy && config.onMore) config.onMore(); });
    retry.addEventListener('click', function () { config.onRetry(); });
    function outside(event) { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(); }
    function scroll(event) {
      if (!opened || popup.contains(event.target) || wrapper.contains(event.target)) return;
      var rect = field.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > win.innerHeight || rect.right < 0 || rect.left > win.innerWidth) close();
      else position();
    }
    doc.addEventListener('pointerdown', outside); doc.addEventListener('scroll', scroll, true); win.addEventListener('resize', close);
    return { input: input, update: function (next) { state = Object.assign({}, state, next); render(); }, isOpen: function () { return opened; },
      selectedItems: function () { return state.selected.slice(); },
      destroy: function () { disposed = true; close(); wrapper.remove(); popup.remove(); source.hidden = hidden; delete source.dataset.searchableSource; if (label) label.htmlFor = source.id; doc.removeEventListener('pointerdown', outside); doc.removeEventListener('scroll', scroll, true); win.removeEventListener('resize', close); } };
  }
  function mountSelect(select, label, options) {
    var control = mount(select, Object.assign({ label: label }, options || {}, {
      onPick: function (item) { select.value = item.id; select.dispatchEvent(new Event('change', { bubbles: true })); refresh(); },
      onClear: function () { select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); refresh(); }
    }));
    function refresh() { var options = Array.from(select.options).filter(function (item) { return item.value; }).map(function (item) { return { id: item.value, value: item.textContent, info: item.value, disabled: item.disabled }; }); control.update({ items: options, selected: options.filter(function (item) { return item.id === select.value; }), disabled: select.disabled }); }
    select.addEventListener('change', refresh); var observer = new MutationObserver(refresh); observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] }); refresh();
    return { refresh: refresh, destroy: function () { observer.disconnect(); select.removeEventListener('change', refresh); control.destroy(); } };
  }
  return { normalize: normalize, matches: matches, mount: mount, mountSelect: mountSelect };
});
