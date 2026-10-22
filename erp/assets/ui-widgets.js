/* ============================================================
 * 网研ERP — 统一组件自动装配（ui-widgets · 2026-09-17）
 * 无依赖、无内联脚本；只做渐进增强：
 *   select[data-ui-combobox]
 *     → 原生 <select> 自动升级为“可输入、模糊匹配”的下拉框
 *       （实现来自 searchable-select.js 的 mountSelect）
 *     原生 select 仅被隐藏并保持 value/options 同步，
 *     原有 change 事件与业务逻辑不受影响。
 * 可选：data-ui-placeholder 指定未选择时的提示语。
 * ============================================================ */
(function () {
  'use strict';

  function enhanceSelect(select, api) {
    if (select.tagName !== 'SELECT' || select.dataset.uiComboboxMounted === '1') return;
    select.dataset.uiComboboxMounted = '1';
    var label = select.getAttribute('aria-label') ||
      select.dataset.uiCombobox || '选项';
    var config = {};
    if (select.dataset.uiPlaceholder) config.placeholder = select.dataset.uiPlaceholder;
    api.mountSelect(select, label, config);
  }

  function init() {
    var api = window.WYERP_SEARCHABLE_SELECT;
    if (!api || typeof api.mountSelect !== 'function') return;
    document.querySelectorAll('select[data-ui-combobox]').forEach(function (select) {
      enhanceSelect(select, api);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
