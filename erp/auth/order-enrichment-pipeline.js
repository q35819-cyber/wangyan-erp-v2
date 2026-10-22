'use strict';

function createOrderEnrichmentPipeline(options = {}) {
  const fees = options.fees;
  const images = options.images;
  if (typeof fees !== 'function' || typeof images !== 'function') throw Object.assign(new Error('订单补算流程未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'order_enrichment_pipeline_invalid' });
  return async function enrich(rows, postings, shop) {
    const withFees = await fees(rows, postings, shop);
    if (!Array.isArray(withFees) || withFees.length !== rows.length) throw Object.assign(new Error('订单费用补算返回的条数与订单条数不一致，本轮已停止入库，请稍后重试。'), { code: 'order_fee_enrichment_incomplete' });
    const imageResult = await images(withFees, postings, shop);
    const completed = imageResult && Array.isArray(imageResult.rows) ? imageResult.rows : null;
    if (!completed || completed.length !== rows.length) throw Object.assign(new Error('订单图片补算返回的条数与订单条数不一致，本轮已停止入库，请稍后重试。'), { code: 'order_image_enrichment_incomplete' });
    return completed;
  };
}

module.exports = { createOrderEnrichmentPipeline };
