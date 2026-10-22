(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_WATERMARK_TEMPLATES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 九宫格位置：与本机水印引擎 watermark-local.js 的 POSITION_AXES 一一对应，两侧必须同步扩展。
  var POSITIONS = ['top-left', 'top-center', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  var POSITION_LABELS = {
    'top-left': '左上角', 'top-center': '上居中', 'top-right': '右上角',
    'middle-left': '左居中', 'center': '中心', 'middle-right': '右居中',
    'bottom-left': '左下角', 'bottom-center': '下居中', 'bottom-right': '右下角'
  };
  // 字体只存短键，真正的 CSS 字体栈由引擎按同一份清单解析，避免页面与出图各说一套。
  var FONTS = ['yahei', 'simhei', 'simsun', 'kaiti', 'arial', 'georgia'];
  var FONT_LABELS = { yahei: '微软雅黑', simhei: '黑体', simsun: '宋体', kaiti: '楷体', arial: 'Arial', georgia: 'Georgia' };
  var KINDS = ['text', 'image'];
  var KIND_LABELS = { text: '文字水印', image: '图片水印' };
  // 水印图片以 data URL 随模板存进租户文档。2026-09-21 用户直令"水印图片需要支持 2MB 的图片"（原 200KB 太小）；
  // 同日曾提到 6MB，随后由用户本人收回，维持 2MB。这里只定义一份，页面提示与超限拒绝文案都由它换算，不得在页面另写数字。
  // 与 BASE_MAX_BYTES（预览底图 1MB）、引擎 MAX_INPUT_BYTES（商品原图 20MB）是三个互不相关的口径，不得互相放大。
  var LOGO_MAX_BYTES = 2 * 1024 * 1024;
  var LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  var LOGO_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i;
  var EMPTY_LOGO = { logoDataUrl: '', logoContentType: '', logoSizeBytes: 0, logoWidth: 0, logoHeight: 0 };
  // 预览底图单独存一份租户文档：管理员换一次，所有客户预览都在同一张底图上看效果。
  // 页面写入前已按最长边 1200 压缩，这里再兜底校验，避免整份文档被原图撑大。
  var BASE_MAX_SIDE = 1200;
  var BASE_MAX_BYTES = 1024 * 1024;
  var BASE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  var BASE_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i;

  function text(value, max) { return String(value == null ? '' : value).trim().slice(0, max); }
  function number(value, fallback, min, max) {
    value = Number(value);
    if (!Number.isFinite(value)) value = fallback;
    return Math.min(max, Math.max(min, value));
  }
  function kindOf(item) { return item && item.kind === 'image' ? 'image' : 'text'; }
  function base64Bytes(base64) {
    var clean = String(base64 || '').replace(/=+$/, '');
    return Math.floor(clean.length * 3 / 4);
  }
  function blankBase() { return { dataUrl: '', contentType: '', sizeBytes: 0, width: 0, height: 0, updatedAt: '' }; }
  function normalizeBase(raw) {
    var item = raw && typeof raw === 'object' ? raw : {};
    var match = BASE_DATA_URL.exec(String(item.dataUrl || ''));
    if (!match) return blankBase();
    var contentType = match[1].toLowerCase();
    var sizeBytes = base64Bytes(match[2]);
    if (BASE_TYPES.indexOf(contentType) < 0 || !sizeBytes || sizeBytes > BASE_MAX_BYTES) return blankBase();
    return {
      dataUrl: 'data:' + contentType + ';base64,' + match[2],
      contentType: contentType,
      sizeBytes: sizeBytes,
      width: number(item.width, 0, 0, 20000),
      height: number(item.height, 0, 0, 20000),
      updatedAt: text(item.updatedAt, 40)
    };
  }
  function normalizeLogo(item) {
    var match = LOGO_DATA_URL.exec(String(item && item.logoDataUrl || ''));
    if (!match) return Object.assign({}, EMPTY_LOGO);
    var contentType = match[1].toLowerCase();
    var sizeBytes = base64Bytes(match[2]);
    if (LOGO_TYPES.indexOf(contentType) < 0 || !sizeBytes || sizeBytes > LOGO_MAX_BYTES) return Object.assign({}, EMPTY_LOGO);
    return {
      logoDataUrl: 'data:' + contentType + ';base64,' + match[2],
      logoContentType: contentType,
      logoSizeBytes: sizeBytes,
      logoWidth: number(item.logoWidth, 0, 0, 20000),
      logoHeight: number(item.logoHeight, 0, 0, 20000)
    };
  }
  function normalize(item) {
    item = item && typeof item === 'object' ? item : {};
    var position = POSITIONS.indexOf(item.position) >= 0 ? item.position : 'bottom-right';
    return Object.assign({
      id: text(item.id, 80) || ('wm-' + Date.now() + '-' + Math.random().toString(16).slice(2)),
      kind: kindOf(item),
      name: text(item.name, 80) || '未命名模板',
      content: text(item.content, 120),
      position: position,
      opacity: number(item.opacity, 45, 5, 100),
      fontSize: number(item.fontSize, 30, 10, 120),
      fontFamily: FONTS.indexOf(item.fontFamily) >= 0 ? item.fontFamily : 'yahei',
      color: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#ffffff',
      widthRatio: number(item.widthRatio, 15, 3, 90),
      isDefault: Boolean(item.isDefault),
      // 创建时间只在第一次入库时确定（旧数据没有该字段时沿用其最后更新时间），之后编辑不得改写。
      createdAt: text(item.createdAt, 40) || text(item.updatedAt, 40) || new Date().toISOString(),
      updatedAt: text(item.updatedAt, 40) || new Date().toISOString()
    }, normalizeLogo(item));
  }
  function normalizeAll(items) {
    var seen = {};
    return (Array.isArray(items) ? items : []).map(normalize).map(function (item) {
      if (!item.isDefault) return item;
      if (!seen[item.kind]) { seen[item.kind] = true; return item; }
      return Object.assign({}, item, { isDefault: false });
    });
  }
  function byKind(items, kind) {
    return normalizeAll(items).filter(function (item) { return item.kind === (kind === 'image' ? 'image' : 'text'); });
  }
  function upsert(items, input) {
    var list = normalizeAll(items), item = normalize(input), found = false;
    list = list.map(function (current) {
      if (current.id !== item.id) {
        return item.isDefault && current.kind === item.kind ? Object.assign({}, current, { isDefault: false }) : current;
      }
      found = true;
      return current.createdAt ? Object.assign({}, item, { createdAt: current.createdAt }) : item;
    });
    if (!found) list.push(item);
    return normalizeAll(list);
  }
  function remove(items, id) { return normalizeAll(items).filter(function (item) { return item.id !== String(id); }); }
  function setDefault(items, id) {
    var target = null;
    normalizeAll(items).forEach(function (item) { if (item.id === String(id)) target = item.kind; });
    return normalizeAll(items).map(function (item) {
      if (target === null || item.kind !== target) return item;
      return Object.assign({}, item, { isDefault: item.id === String(id) });
    });
  }
  return {
    POSITIONS: POSITIONS.slice(), POSITION_LABELS: Object.assign({}, POSITION_LABELS),
    FONTS: FONTS.slice(), FONT_LABELS: Object.assign({}, FONT_LABELS),
    KINDS: KINDS.slice(), KIND_LABELS: Object.assign({}, KIND_LABELS), LOGO_MAX_BYTES: LOGO_MAX_BYTES, LOGO_TYPES: LOGO_TYPES.slice(),
    BASE_MAX_SIDE: BASE_MAX_SIDE, BASE_MAX_BYTES: BASE_MAX_BYTES, BASE_TYPES: BASE_TYPES.slice(),
    blankBase: blankBase, normalizeBase: normalizeBase,
    normalize: normalize, normalizeAll: normalizeAll, byKind: byKind, upsert: upsert, remove: remove, setDefault: setDefault, kindOf: kindOf
  };
});
