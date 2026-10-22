'use strict';

const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  const { parseLogisticsWorkbook } = require('./logistics-tariff-parser');
  parseLogisticsWorkbook(Buffer.from(workerData.body), workerData.originalName).then(
    result => parentPort.postMessage({ ok: true, result }),
    error => parentPort.postMessage({ ok: false, code: String(error.publicCode || 'logistics_parse_failed'), message: String(error.message || '物流表解析失败').slice(0, 500) })
  );
}

function parseLogisticsWorkbookInWorker(body, originalName, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, options.timeoutMs) : 120000;
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(__filename), { workerData: { body, originalName } });
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      const error = new Error('物流资费表解析超过120秒');
      error.publicCode = 'logistics_parse_timeout';
      reject(error);
    }, timeoutMs);
    timer.unref();
    worker.once('message', message => {
      clearTimeout(timer);
      if (message?.ok) resolve(message.result);
      else {
        const error = new Error(String(message?.message || '物流表解析失败'));
        error.publicCode = String(message?.code || 'logistics_parse_failed');
        reject(error);
      }
    });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error('物流解析工作线程异常退出');
        error.publicCode = 'logistics_parse_worker_failed';
        reject(error);
      }
    });
  });
}

module.exports = { parseLogisticsWorkbookInWorker };
