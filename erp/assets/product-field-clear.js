(function (root) {
  'use strict';
  var ownedContainers = '#productForm,#richContentEditorDialog,#skuVideoEditorDialog,#combinationPickerDialog,#combinationReferenceDialog,#skuImageEditor,#skuImageSelectionDialog,#skuImageZoomDialog,#skuImageDeleteConfirmDialog,#skuImageCopyDialog,#skuImageWatermarkDialog,#skuImageProcessDialog,#skuImageAiDialog,.product-translation-dialog';
  function eligible(input) {
    return input && input.closest(ownedContainers) && !(input.getClientRects && !input.getClientRects().length) && !(input.ownerDocument && input.ownerDocument.defaultView && /^(hidden|collapse)$/.test(input.ownerDocument.defaultView.getComputedStyle(input).visibility)) && /^(INPUT|TEXTAREA|SELECT)$/.test(input.tagName) && !input.hidden && !input.disabled && !input.readOnly && !/^(hidden|file|checkbox|radio|password|button|submit|reset|image|range|color)$/.test(input.type || '') && !input.closest('.searchable-select,.searchable-select-popup') && !input.dataset.searchableSource;
  }
  function clearValue(input) {
    if (!eligible(input)) return false;
    if (input.tagName === 'SELECT') { Array.from(input.options).forEach(function (option) { option.selected = false; }); input.selectedIndex = -1; }
    else input.value = '';
    input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); input.focus(); return true;
  }
  function mount(doc) {
    var mounted = new WeakMap();
    function scan() {
      doc.querySelectorAll(ownedContainers.split(',').map(function (selector) { return selector + ' input,' + selector + ' textarea,' + selector + ' select'; }).join(',')).forEach(function (input) {
        var entry = mounted.get(input);
        if (!eligible(input)) { if (entry) { entry.button.remove(); while (entry.wrapper.firstChild) entry.wrapper.before(entry.wrapper.firstChild); entry.wrapper.remove(); mounted.delete(input); } return; }
        if (entry) return;
        var wrapper = doc.createElement('span'), button = doc.createElement('button'); wrapper.className = 'product-clear-control';
        button.type = 'button'; button.className = 'product-field-clear'; button.textContent = '×';
        var label = input.getAttribute('aria-label') || input.labels && input.labels[0] && input.labels[0].textContent.trim() || input.placeholder || '当前内容';
        button.setAttribute('aria-label', '清空' + label); button.title = '清空' + label;
        input.before(wrapper); wrapper.append(input, button); mounted.set(input, {wrapper:wrapper,button:button});
        button.addEventListener('click', function () { clearValue(input); });
      });
    }
    var scheduled = false;
    new MutationObserver(function () { if (scheduled) return; scheduled = true; queueMicrotask(function () { scheduled = false; scan(); }); }).observe(doc.body, {childList:true,subtree:true,attributes:true,attributeFilter:['disabled','readonly','hidden','type','open','class','style']});
    scan(); return {refresh:scan};
  }
  var api = {eligible:eligible,clearValue:clearValue,mount:mount};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.WYERP_PRODUCT_FIELD_CLEAR = api; mount(document); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
