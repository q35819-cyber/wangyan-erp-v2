'use strict';

function text(value) {
  if (value == null) return '';
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'result')) return text(value.result);
  if (typeof value === 'object' && Array.isArray(value.richText)) return value.richText.map(part => part.text || '').join('').trim();
  return String(value).trim();
}

function rateText(value) {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + '%';
}

function tierText(mode, values) {
  if (!values) return null;
  const tiers = [
    ['不超过1500₽', values.upTo1500Rub],
    ['超过1500₽且不超过5000₽', values.from1500To5000Rub],
    ['超过5000₽', values.above5000Rub]
  ].filter(([, value]) => Number.isFinite(value));
  if (tiers.length !== 3) return null;
  return {
    display: tiers.map(([, value]) => rateText(value)).join(' · '),
    title: mode + '：' + tiers.map(([label, value]) => label + ' ' + rateText(value)).join('；')
  };
}

function createOzonCategoryReference(options = {}) {
  const commissionCatalog = options.commissionCatalog;

  async function enrichProduct(result) {
    const product = result && result.data && result.data.product;
    if (!product || typeof product !== 'object') return result;
    const warnings = Array.isArray(result.warnings) ? result.warnings : (result.warnings = []);
    try {
      const reference = commissionCatalog && await commissionCatalog.getCategoryReference({ product });
      if (!reference) return result;
      if (reference.cnPath.length) {
        const categoryInfo = product.categoryInfo && typeof product.categoryInfo === 'object' ? product.categoryInfo : {};
        if (reference.ruPath.length) categoryInfo.ruTitlePath = reference.ruPath.join(' > ');
        categoryInfo.cnTitlePath = reference.cnPath.join(' > ');
        categoryInfo.titlePath = categoryInfo.cnTitlePath;
        categoryInfo.localDescriptionCategoryId = reference.descriptionCategoryId;
        categoryInfo.localTypeId = reference.typeId;
        product.categoryInfo = categoryInfo;
      }
      product.officialCategoryCommission = reference;
      const selected = tierText(reference.scheme, reference.rates);
      if (selected) {
        product.commissions = [{
          rate: selected.display,
          title: selected.title,
          source: 'ozon_china_system_commission_catalog'
        }];
      }
    } catch (_) {
      warnings.push('Ozon中国卖家佣金目录暂时不可用。');
    }
    return result;
  }

  return { enrichProduct };
}

module.exports = { createOzonCategoryReference };
