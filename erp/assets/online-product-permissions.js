(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_ONLINE_PRODUCT_PERMISSIONS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function has(account, code) {
    return Boolean(account && Array.isArray(account.permissions) && account.permissions.indexOf(code) >= 0);
  }
  function canWriteProducts(account) {
    if (!account) return false;
    return Boolean(account.isSystemAdmin || account.memberType === 'owner' || has(account, 'products.write'));
  }
  return { has: has, canWriteProducts: canWriteProducts };
});
