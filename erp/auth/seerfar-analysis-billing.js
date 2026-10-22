'use strict';

const crypto = require('crypto');

const SEERFAR_ANALYSIS_BATCH_SIZE = 100;
const SEERFAR_ANALYSIS_BEAN_PER_BATCH = 10;

function pricing(beanPerBatch = SEERFAR_ANALYSIS_BEAN_PER_BATCH) {
  return {
    batchSize: SEERFAR_ANALYSIS_BATCH_SIZE,
    beanPerBatch: Number(beanPerBatch)
  };
}

function shopIdOf(value) {
  const id = String(value == null ? '' : value).trim();
  if (!/^\d{1,24}$/.test(id)) throw Object.assign(new Error('店铺编号不正确，请重新选择店铺后再试。'), { publicCode: 'seerfar_invalid_shop', status: 400 });
  return id;
}

function pageOf(value) {
  const page = Number(value == null ? 1 : value);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw Object.assign(new Error('店铺数据页码不正确，请重新获取。'), { publicCode: 'seerfar_invalid_page', status: 400 });
  return page;
}

function requestKeyOf(value) {
  const key = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(key)) throw Object.assign(new Error('缺少本次获取数据的请求编号，请重新点击获取。'), { publicCode: 'idempotency_key_required', status: 400 });
  return key;
}

function billingKeys(requestKey, shopId, pageNumber) {
  const digest = crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 24);
  const base = `seerfar-analysis:${shopId}:p${pageNumber}:${digest}`;
  return {
    freeze: base + ':freeze',
    settle: base + ':settle',
    release: base + ':release',
    businessRef: `seerfar-shop:${shopId}:page:${pageNumber}:${digest}`
  };
}

async function fetchShopPage(options = {}) {
  const tenantId = String(options.tenantId || '').trim();
  const actorUserId = options.actorUserId == null ? null : String(options.actorUserId);
  const shopId = shopIdOf(options.shopId);
  const pageNumber = pageOf(options.pageNumber);
  const requestKey = requestKeyOf(options.idempotencyKey);
  const marketCache = options.marketCache;
  const aiBeanStore = options.aiBeanStore;
  if (!/^\d+$/.test(tenantId) || !marketCache || typeof marketCache.getShop !== 'function' || !aiBeanStore) {
    throw Object.assign(new Error('Seerfar分析服务当前不可用，请稍后重试。'), { publicCode: 'seerfar_analysis_unavailable', status: 503 });
  }

  const chargeBean = Number(options.chargeBean == null ? SEERFAR_ANALYSIS_BEAN_PER_BATCH : options.chargeBean);
  if (!Number.isSafeInteger(chargeBean) || chargeBean <= 0) throw Object.assign(new Error('数据分析AI豆价格配置无效，请联系系统管理员检查价格设置。'), { publicCode: 'ai_pricing_invalid', status: 503 });
  const keys = billingKeys(requestKey, shopId, pageNumber);

  // 只做余额预检，不产生冻结流水。用户主动获取成功后才进入实际扣豆流程。
  if (typeof aiBeanStore.balance === 'function') {
    const before = await aiBeanStore.balance(tenantId);
    if (Number(before && before.balanceBean) < chargeBean) {
      throw Object.assign(new Error('AI豆余额不足，请先充值后再使用该功能。'), { publicCode: 'insufficient_ai_beans', status: 402 });
    }
  }

  // 无论数据来自上游还是服务器缓存，都必须先确认本次获取成功；成功后才扣豆。
  const result = await marketCache.getShop({ shopId, pageNumber, forceRefresh: false });
  const products = Array.isArray(result && result.data && result.data.products) ? result.data.products : [];

  let frozen = false;
  let settled = false;
  try {
    await aiBeanStore.freeze(tenantId, {
      amount: chargeBean,
      idempotencyKey: keys.freeze,
      businessRef: keys.businessRef,
      reason: 'Seerfar店铺分析数据已获取，第' + pageNumber + '批（' + products.length + '条），准备结算',
      actorUserId
    });
    frozen = true;

    const settlement = await aiBeanStore.settle(tenantId, {
      amount: chargeBean,
      idempotencyKey: keys.settle,
      businessRef: keys.businessRef,
      reason: 'Seerfar店铺分析成功扣费，第' + pageNumber + '批（' + products.length + '条）',
      actorUserId
    });
    settled = true;
    const wallet = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(tenantId) : null;
    return {
      result,
      billing: {
        ...pricing(chargeBean),
        chargedBean: chargeBean,
        pageNumber,
        rowCount: products.length,
        replayed: Boolean(settlement && settlement.replayed),
        balanceBean: wallet && Number.isFinite(Number(wallet.balanceBean)) ? Number(wallet.balanceBean) : null,
        frozenBean: wallet && Number.isFinite(Number(wallet.frozenBean)) ? Number(wallet.frozenBean) : null
      }
    };
  } catch (error) {
    if (frozen && !settled) {
      try {
        await aiBeanStore.release(tenantId, {
          amount: chargeBean,
          idempotencyKey: keys.release,
          businessRef: keys.businessRef,
          reason: 'Seerfar店铺分析结算失败退回，第' + pageNumber + '批',
          actorUserId
        });
        error.billingReleased = true;
      } catch (releaseError) {
        error.billingReleaseError = releaseError;
      }
    }
    throw error;
  }
}

module.exports = {
  SEERFAR_ANALYSIS_BATCH_SIZE,
  SEERFAR_ANALYSIS_BEAN_PER_BATCH,
  pricing,
  billingKeys,
  fetchShopPage
};
