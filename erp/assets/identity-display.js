/* 网研ERP — 用户身份展示与脱敏（仅展示层，不参与登录/权限判断） */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_IDENTITY_DISPLAY = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function maskName(value) {
    var raw = clean(value);
    var chars = Array.from(raw);
    if (!chars.length) return '';
    if (chars.length === 1) return '*';
    if (chars.length === 2) return chars[0] + '*';
    return chars.map(function (char, index) {
      return index === 0 || index === 2 ? char : '*';
    }).join('');
  }

  function maskEmail(value) {
    var raw = clean(value);
    var at = raw.lastIndexOf('@');
    if (at <= 0 || at >= raw.length - 1) return '';
    var local = Array.from(raw.slice(0, at));
    var domain = raw.slice(at + 1);
    if (!local.length || !domain) return '';
    if (local.length === 1) return '*@' + domain;
    var visible = Math.max(1, Math.ceil(local.length / 2));
    var prefix = Math.max(1, Math.ceil(visible / 2));
    var suffix = Math.max(0, Math.floor(visible / 2));
    if (prefix + suffix >= local.length) suffix = Math.max(0, local.length - prefix - 1);
    var hidden = Math.max(1, local.length - prefix - suffix);
    return local.slice(0, prefix).join('') + '*'.repeat(hidden) +
      (suffix ? local.slice(local.length - suffix).join('') : '') + '@' + domain;
  }

  function maskAccount(value) {
    var raw = clean(value);
    if (!raw) return '';
    if (raw.indexOf('@') > 0) return maskEmail(raw);
    var chars = Array.from(raw);
    if (chars.length === 1) return '*';
    if (chars.length === 2) return chars[0] + '*';
    if (chars.length <= 4) return chars[0] + '*'.repeat(chars.length - 1);
    var prefix = Math.min(2, Math.ceil(chars.length / 4));
    var suffix = Math.min(2, Math.floor(chars.length / 4));
    return chars.slice(0, prefix).join('') + '*'.repeat(Math.max(1, chars.length - prefix - suffix)) +
      chars.slice(chars.length - suffix).join('');
  }

  function displayIdentity(source) {
    if (typeof source === 'string') source = { email: source.indexOf('@') > 0 ? source : '' };
    source = source || {};
    if (source.isSystemAdmin === true) return { kind: 'system_admin', raw: '系统管理员', masked: '系统管理员' };
    var profileFullName = clean(source.profileFullName || source.realName);
    var email = clean(source.verifiedEmail || source.email);
    if (profileFullName) return { kind: 'name', raw: profileFullName, masked: maskName(profileFullName) };
    if (email) return { kind: 'email', raw: email, masked: maskEmail(email) };
    // 普通用户禁止再以 username / displayName 作为展示身份兜底。
    // 调用方可根据场景把 unknown 显示为“当前账号”或“历史未记录”。
    return { kind: 'unknown', raw: '', masked: '当前账号' };
  }

  return {
    maskName: maskName,
    maskEmail: maskEmail,
    maskAccount: maskAccount,
    displayIdentity: displayIdentity
  };
});
