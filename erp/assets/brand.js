/* 网研ERP（WangYan ERP / WYERP）— 品牌配置
   接入 Shopee/Temu 时，把 platform 改为 '全平台版'，全站 Logo 与标题同步更新。 */
window.WYERP_BRAND = {
  name: '网研ERP',
  platform: 'OZON版',
  copyrightOwner: '网研ERP',
  copyrightSince: 2026
};
window.WYERP_BRAND.display = window.WYERP_BRAND.name + ' · ' + window.WYERP_BRAND.platform;
(function () {
  var brand = window.WYERP_BRAND;
  var currentYear = new Date().getFullYear();
  var since = Number(brand.copyrightSince) || currentYear;
  var years = currentYear > since ? since + '–' + currentYear : String(since);
  brand.copyrightText = '© ' + years + ' ' + String(brand.copyrightOwner || brand.name) + ' · 保留所有权利';
  function applyCopyright(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('[data-wyerp-copyright]').forEach(function (node) {
      node.textContent = brand.copyrightText;
      node.title = brand.copyrightText;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { applyCopyright(document); }, { once: true });
  else applyCopyright(document);
})();
