/* 列表行内复制、编辑图标（浏览器 / Node 共用）。 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_INLINE_ACTION_ICONS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function copy() {
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.25" y="2.75" width="7.5" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M10.75 12.25v.25A1.5 1.5 0 0 1 9.25 14h-6A1.5 1.5 0 0 1 1.75 12.5v-7A1.5 1.5 0 0 1 3.25 4h.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  }
  function edit() {
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m10.9 2.35 2.75 2.75-7.7 7.7-3.45.7.7-3.45 7.7-7.7Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="m9.35 3.9 2.75 2.75M2.85 10.35l2.8 2.8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>';
  }
  return { copy: copy, edit: edit };
});
