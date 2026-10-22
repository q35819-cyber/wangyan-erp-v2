'use strict';

const crypto = require('crypto');

function utcTimestamp(now = new Date()) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.getTime())) throw Object.assign(new Error('图片任务的时间戳无效，请重新提交生图任务。'), { code: 'sku_image_job_time_invalid' });
  return value.toISOString().replace(/[-:.Z]/g, '').replace(/(\d{8}T\d{6})(\d{3})$/, '$1$2');
}

function createSkuImageJobId(now, randomBytes = crypto.randomBytes) {
  const suffix = randomBytes(4).toString('hex');
  if (!/^[0-9a-f]{8}$/.test(suffix)) throw Object.assign(new Error('图片任务的随机编号无效，请重新提交生图任务。'), { code: 'sku_image_job_random_invalid' });
  return `sku-image-ai-${utcTimestamp(now)}-${suffix}`;
}

module.exports = { utcTimestamp, createSkuImageJobId };
