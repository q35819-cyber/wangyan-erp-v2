(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WYERP_TASK_REFRESH_POLICY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function delay(options) {
    options = options || {};
    if (!options.running || options.hidden) return null;
    return 3000;
  }
  return { delay: delay };
});
