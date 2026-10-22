(function (root) {
  'use strict';
  function split(value) { return String(value || '').split(/[\s,，;；]+/).filter(Boolean); }
  function mount(source) {
    var tags = [], emitting = false, composing = false;
    function node(tag, className) { var el = document.createElement(tag); el.className = className; return el; }
    var wrapper = node('span', 'searchable-select product-hashtags');
    var field = node('span', 'searchable-select-field'), content = node('span', 'searchable-select-content');
    var list = node('span', 'searchable-select-tags'), input = node('input', 'searchable-select-input');
    input.type = 'text'; input.id = 'hashtagsTagEntry'; input.setAttribute('aria-label', '主题标签');
    input.placeholder = '输入标签，按空格或回车添加';
    input.autocomplete = 'off';
    content.append(list, input); field.append(content); wrapper.append(field); source.before(wrapper);
    source.hidden = true;
    var clear = null;
    if (document.body.dataset.productFieldClear === 'true') {
      clear = node('button', 'searchable-select-clear'); clear.type = 'button'; clear.textContent = '×'; clear.title = '清空主题标签'; clear.setAttribute('aria-label', '清空主题标签'); field.append(clear);
      clear.addEventListener('mousedown', function (event) { event.preventDefault(); });
      clear.addEventListener('click', function () { if (source.disabled || source.readOnly) return; tags = []; input.value = ''; write(); source.dispatchEvent(new Event('change', {bubbles:true})); render(); input.focus(); });
    }
    function updateClear() { if (clear) { clear.hidden = !tags.length && !input.value; clear.disabled = source.disabled || source.readOnly; } }

    function write() {
      source.value = tags.concat(input.value ? [input.value] : []).join(' ');
      emitting = true;
      try { source.dispatchEvent(new Event('input', { bubbles: true })); }
      finally { emitting = false; }
      updateClear();
    }
    function render() {
      list.replaceChildren(); updateClear();
      tags.forEach(function (text, index) {
        var tag = node('span', 'searchable-select-tag'), label = node('span', 'searchable-select-tag-text');
        label.textContent = text; label.title = text; tag.append(label);
        if (!source.disabled && !source.readOnly) {
          var remove = node('button', 'searchable-select-tag-remove'); remove.type = 'button'; remove.textContent = '×';
          remove.setAttribute('aria-label', '移除主题标签：' + text);
          remove.addEventListener('mousedown', function (event) { event.preventDefault(); });
          remove.addEventListener('click', function () { tags.splice(index, 1); write(); render(); input.focus(); });
          tag.append(remove);
        }
        list.append(tag);
      });
      input.disabled = source.disabled; input.readOnly = source.readOnly;
      input.setAttribute('aria-required', source.getAttribute('aria-required') || 'false');
    }
    function refresh() { if (emitting) return; tags = split(source.value); input.value = ''; render(); }
    function commit() {
      if (composing || source.disabled || source.readOnly || !input.value) return;
      tags = tags.concat(split(input.value)); input.value = ''; write(); render();
    }
    input.addEventListener('input', function () { write(); if (!composing && /[\s,，;；]/.test(input.value)) commit(); });
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; write(); if (/[\s,，;；]/.test(input.value)) commit(); });
    input.addEventListener('keydown', function (event) {
      if (composing || event.isComposing || source.disabled || source.readOnly) return;
      if (event.key === 'Enter') { event.preventDefault(); commit(); }
      else if ((event.key === 'Backspace' || event.key === 'Delete') && !input.value && tags.length) { event.preventDefault(); tags.pop(); write(); render(); }
    });
    input.addEventListener('blur', commit);
    source.addEventListener('input', refresh); source.addEventListener('change', refresh);
    new MutationObserver(render).observe(source, { attributes: true, attributeFilter: ['disabled', 'readonly', 'aria-required'] });
    refresh(); return { refresh: refresh };
  }
  root.WYERP_PRODUCT_HASHTAGS = { mount: mount };
})(window);
