'use strict';
/*
 * 浏览器本地图片加水印（第一版：File API + Canvas + toBlob + 批量任务队列）
 * 不依赖任何浏览器插件，也不依赖 Python/PS 等本地软件。
 * 结构对应规格里的 services/imageProcessor、services/batchProcessor、utils/watermarkPosition、utils/imageFormat。
 * 同时给浏览器（window.WYERP_WATERMARK_LOCAL）与 node 测试（module.exports）使用。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_WATERMARK_LOCAL = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var MAX_CONCURRENT = 3;               // 批量并发：同时最多 3 张，避免几十张大图一次性解码
  var PREVIEW_MAX_SIDE = 1200;          // 预览最长边，最终输出仍用原图尺寸
  var JPEG_QUALITY = 0.92;              // 规格建议 0.9~0.95
  var MAX_SIDE = 12000;                 // 与原图安全上限一致（单边）
  var MAX_PIXELS = 40000000;            // 总像素上限
  var MAX_INPUT_BYTES = 20 * 1024 * 1024;
  var ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  // 九宫格：横向 left/center/right × 纵向 top/middle/bottom，与 watermark-templates.js 的 POSITIONS 保持同一份清单。
  var POSITION_AXES = {
    'top-left': ['left', 'top'], 'top-center': ['center', 'top'], 'top-right': ['right', 'top'],
    'middle-left': ['left', 'center'], 'center': ['center', 'center'], 'middle-right': ['right', 'center'],
    'bottom-left': ['left', 'bottom'], 'bottom-center': ['center', 'bottom'], 'bottom-right': ['right', 'bottom']
  };
  var POSITIONS = Object.keys(POSITION_AXES);
  // 字体只按短键解析成 CSS 字体栈：模板里存短键，出图时两侧用同一份映射，页面预览与实际结果才不会不一致。
  var FONT_STACKS = {
    yahei: '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
    simhei: '"SimHei", "Microsoft YaHei", sans-serif',
    simsun: '"SimSun", "Songti SC", serif',
    kaiti: '"KaiTi", "STKaiti", serif',
    arial: 'Arial, "Helvetica Neue", sans-serif',
    georgia: 'Georgia, "Times New Roman", serif'
  };
  var DEFAULT_FONT = 'yahei';
  var DEFAULT_FONT_STACK = FONT_STACKS[DEFAULT_FONT];

  function fail(code, message, detail) {
    var error = new Error(message);
    error.code = code;
    if (detail) error.detail = detail;
    return error;
  }

  /* ───────── utils/imageFormat：按原图格式决定输出，不无脑转 JPG（PNG 透明会丢） ───────── */
  function detectFormat(fileOrName) {
    var name = typeof fileOrName === 'string' ? fileOrName : String((fileOrName && (fileOrName.name || fileOrName.type)) || '');
    var mime = typeof fileOrName === 'object' && fileOrName ? String(fileOrName.type || '').toLowerCase() : '';
    if (mime === 'image/png' || /\.png$/i.test(name)) return 'png';
    if (mime === 'image/webp' || /\.webp$/i.test(name)) return 'webp';
    if (mime === 'image/jpeg' || /\.(jpe?g)$/i.test(name)) return 'jpeg';
    return null;
  }
  function outputFor(format) {
    // PNG 保持 PNG（保留透明），WebP 保持 WebP，JPG 保持 JPG；未知格式拒绝
    if (format === 'png') return { mime: 'image/png', extension: '.png', quality: null };
    if (format === 'webp') return { mime: 'image/webp', extension: '.webp', quality: JPEG_QUALITY };
    if (format === 'jpeg') return { mime: 'image/jpeg', extension: '.jpg', quality: JPEG_QUALITY };
    throw fail('watermark_format_unsupported', '只支持 JPG、PNG、WebP 图片');
  }
  function outputName(name, output) {
    var base = String(name || 'image').replace(/\.[^.]*$/, '');
    return base + '_wm' + output.extension;
  }

  /* ───────── utils/watermarkPosition：位置计算只写一处 ───────── */
  function getWatermarkPosition(input) {
    var canvasWidth = Number(input.canvasWidth), canvasHeight = Number(input.canvasHeight);
    var boxWidth = Number(input.watermarkWidth), boxHeight = Number(input.watermarkHeight);
    var margin = Number(input.margin) || 0;
    var position = POSITIONS.indexOf(input.position) >= 0 ? input.position : 'bottom-right';
    var maxLeft = Math.max(0, canvasWidth - boxWidth), maxTop = Math.max(0, canvasHeight - boxHeight);
    function clampX(x) { return Math.min(maxLeft, Math.max(0, x)); }
    function clampY(y) { return Math.min(maxTop, Math.max(0, y)); }
    var axes = POSITION_AXES[position];
    var x = axes[0] === 'left' ? margin : axes[0] === 'right' ? canvasWidth - boxWidth - margin : (canvasWidth - boxWidth) / 2;
    var y = axes[1] === 'top' ? margin : axes[1] === 'bottom' ? canvasHeight - boxHeight - margin : (canvasHeight - boxHeight) / 2;
    return { x: clampX(x), y: clampY(y) };
  }

  /* ───────── utils/imageResize：一律用比例，不用固定像素 ───────── */
  function textMetrics(config, canvasWidth, canvasHeight) {
    var fontSizeRatio = Number(config.textStyle && config.textStyle.fontSizeRatio) || 0.04;
    var marginRatio = Number(config.marginRatio) || 0.02;
    var fontSize = Math.max(8, Math.min(400, Math.round(canvasWidth * fontSizeRatio)));
    var side = Math.min(canvasWidth, canvasHeight);
    return {
      fontSize: fontSize,
      margin: Math.max(4, Math.round(side * marginRatio)),
      color: (config.textStyle && config.textStyle.color) || '#ffffff',
      fontStack: FONT_STACKS[config.textStyle && config.textStyle.fontFamily] || DEFAULT_FONT_STACK,
      lineHeight: Math.round(fontSize * 1.3)
    };
  }
  function logoMetrics(config, canvasWidth, canvasHeight, naturalWidth, naturalHeight) {
    var widthRatio = Number(config.watermarkWidthRatio) || 0.15;
    var marginRatio = Number(config.marginRatio) || 0.02;
    var logoWidth = Math.max(8, Math.round(canvasWidth * widthRatio));
    var ratio = naturalWidth > 0 ? (naturalHeight / naturalWidth) : 1;
    return {
      width: logoWidth,
      height: Math.max(1, Math.round(logoWidth * ratio)),
      margin: Math.max(4, Math.round(Math.min(canvasWidth, canvasHeight) * marginRatio))
    };
  }
  function previewScale(width, height, maxSide) {
    var longest = Math.max(width, height);
    if (!longest) return 1;
    // 调用方（如水印页按弹窗实际显示宽度）可以要求更小的预览档位，但不得放宽到超过引擎上限
    var cap = Number(maxSide) > 0 ? Math.min(Number(maxSide), PREVIEW_MAX_SIDE) : PREVIEW_MAX_SIDE;
    return longest <= cap ? 1 : cap / longest;
  }

  /* ───────── 校验：格式错误、损坏、超大都要报错并带信息 ───────── */
  function validateFile(file) {
    var name = String((file && file.name) || '未命名文件');
    var type = String((file && file.type) || '');
    var size = Number((file && file.size) || 0);
    if (!size) throw fail('watermark_file_empty', '图片内容为空', { fileName: name });
    if (size > MAX_INPUT_BYTES) throw fail('watermark_file_too_large', '单张图片超过 20 MiB', { fileName: name, size: size });
    if (type && ACCEPTED_TYPES.indexOf(type) < 0) throw fail('watermark_format_unsupported', '只支持 JPG、PNG、WebP 图片', { fileName: name, type: type });
    if (!detectFormat(file)) throw fail('watermark_format_unsupported', '无法识别图片格式', { fileName: name });
    return { name: name, format: detectFormat(file) };
  }
  function validateDimensions(width, height, fileName) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw fail('watermark_image_broken', '图片损坏或无法解码', { fileName: fileName });
    }
    if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
      throw fail('watermark_image_dimensions', '图片尺寸或总像素超过上限（单边 12000、总像素 4000 万）', { fileName: fileName, width: width, height: height });
    }
    return true;
  }

  /* ───────── 配置校验与默认值 ───────── */
  function normalizeConfig(input) {
    var config = input || {};
    var type = config.type === 'image' ? 'image' : 'text';
    var position = POSITIONS.indexOf(config.position) >= 0 ? config.position : 'bottom-right';
    var opacity = Number(config.opacity);
    if (!Number.isFinite(opacity)) opacity = 0.5;
    opacity = Math.min(1, Math.max(0.05, opacity));
    var marginRatio = Number(config.marginRatio);
    if (!Number.isFinite(marginRatio) || marginRatio <= 0) marginRatio = 0.02;
    if (type === 'text') {
      var text = String(config.text == null ? '' : config.text).replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!text) throw fail('watermark_text_required', '请填写水印文字');
      if (text.length > 60) throw fail('watermark_text_too_long', '水印文字最多 60 个字符');
      var textStyle = config.textStyle || {};
      var fontSizeRatio = Number(textStyle.fontSizeRatio);
      if (!Number.isFinite(fontSizeRatio) || fontSizeRatio <= 0) fontSizeRatio = 0.04;
      var color = /^#[0-9a-f]{6}$/i.test(String(textStyle.color || '')) ? String(textStyle.color) : '#ffffff';
      var fontFamily = FONT_STACKS[textStyle.fontFamily] ? String(textStyle.fontFamily) : DEFAULT_FONT;
      return { type: 'text', text: text, position: position, opacity: opacity, marginRatio: Math.min(0.5, marginRatio), textStyle: { fontSizeRatio: Math.min(0.5, fontSizeRatio), color: color, fontFamily: fontFamily } };
    }
    if (!config.watermarkImage) throw fail('watermark_logo_required', '请选择 Logo 图片');
    var widthRatio = Number(config.watermarkWidthRatio);
    if (!Number.isFinite(widthRatio) || widthRatio <= 0) widthRatio = 0.15;
    return { type: 'image', position: position, opacity: opacity, marginRatio: Math.min(0.5, marginRatio), watermarkImage: config.watermarkImage, watermarkWidthRatio: Math.min(0.9, widthRatio) };
  }

  /* ───────── services/imageProcessor ───────── */
  // loadImage：URL/Blob → HTMLImageElement；用完必须 revokeObjectURL
  function loadImage(source) {
    return new Promise(function (resolve, reject) {
      if (typeof Image !== 'function' || typeof document === 'undefined') { reject(fail('watermark_no_dom', '当前环境没有浏览器画布能力')); return; }
      var url = typeof source === 'string' ? source : null;
      var objectUrl = null;
      if (!url) {
        if (typeof URL === 'undefined' || !URL.createObjectURL) { reject(fail('watermark_no_objecturl', '当前浏览器不支持 Object URL')); return; }
        try { objectUrl = URL.createObjectURL(source); } catch (error) { reject(fail('watermark_objecturl_failed', '创建本地图片地址失败：' + error.message)); return; }
        url = objectUrl;
      }
      var image = new Image();
      // 远程图必须显式声明按 CORS 取：否则即使图床允许跨域，画布也会被判定污染，toBlob 直接失败。
      if (/^https?:/i.test(String(url))) image.crossOrigin = 'anonymous';
      function cleanup() { if (objectUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) { try { URL.revokeObjectURL(objectUrl); } catch (error) { void error; } } }
      image.onload = function () { cleanup(); resolve(image); };
      image.onerror = function () { cleanup(); reject(fail('watermark_image_broken', '图片损坏或格式不支持，无法解码')); };
      image.src = url;
    });
  }

  function createCanvas(width, height) {
    if (typeof document === 'undefined' || !document.createElement) throw fail('watermark_no_dom', '当前环境没有浏览器画布能力');
    var canvas = document.createElement('canvas');
    var context = canvas.getContext ? canvas.getContext('2d') : null;
    if (!context) throw fail('watermark_canvas_failed', '浏览器无法创建画布（可能内存不足）');
    canvas.width = width;
    canvas.height = height;
    return { canvas: canvas, context: context };
  }

  // drawWatermark：只往画布上画，绝不回写原图；save/restore 成对，避免状态污染
  function drawWatermark(context, metrics, config, size, logo) {
    context.save();
    context.globalAlpha = config.opacity;
    if (config.type === 'text') {
      context.font = metrics.fontSize + 'px ' + metrics.fontStack;
      context.fillStyle = metrics.color;
      context.textBaseline = 'top';
      var lines = String(config.text).split('\n');
      var boxHeight = metrics.lineHeight * lines.length;
      var spot = getWatermarkPosition({
        canvasWidth: size.width, canvasHeight: size.height,
        watermarkWidth: Math.round(context.measureText ? Math.max.apply(null, lines.map(function (line) { return context.measureText(line).width; })) : metrics.fontSize * String(config.text).length * 0.6),
        watermarkHeight: boxHeight, position: config.position, margin: metrics.margin
      });
      lines.forEach(function (line, index) { context.fillText(line, spot.x, spot.y + index * metrics.lineHeight); });
    } else {
      var logoSpot = getWatermarkPosition({
        canvasWidth: size.width, canvasHeight: size.height,
        watermarkWidth: metrics.width, watermarkHeight: metrics.height, position: config.position, margin: metrics.margin
      });
      context.drawImage(logo, logoSpot.x, logoSpot.y, metrics.width, metrics.height);
    }
    context.restore();
  }

  function canvasToBlob(canvas, output) {
    return new Promise(function (resolve, reject) {
      if (!canvas || typeof canvas.toBlob !== 'function') { reject(fail('watermark_toblob_unsupported', '当前浏览器不支持 canvas.toBlob')); return; }
      var settled = false;
      function done(blob) {
        if (settled) return;
        settled = true;
        if (!blob || !blob.size) { reject(fail('watermark_toblob_failed', '生成图片失败（画布导出为空）')); return; }
        resolve(blob);
      }
      try {
        if (output.quality == null) canvas.toBlob(function (blob) { done(blob); }, output.mime);
        else canvas.toBlob(function (blob) { done(blob); }, output.mime, output.quality);
      } catch (error) { if (!settled) { settled = true; reject(fail('watermark_toblob_failed', '生成图片失败：' + error.message)); } }
      // 某些浏览器在页面隐藏时不回调，给一个明确的超时失败，不让任务永远卡住
      setTimeout(function () { if (!settled) { settled = true; reject(fail('watermark_toblob_timeout', '生成图片超时，请重试或减少并发')); } }, 60000);
    });
  }

  /*
   * processImage：原图 + 水印配置 → 新图片 Blob
   * preview=true 时按最长边缩小（默认 1200，可用 previewMaxSide 要求更小档位），只用于预览；最终输出必须用原图尺寸
   */
  async function processImage(source, configInput, options) {
    var settings = options || {};
    var fileName = settings.fileName || (typeof source === 'string' ? '图片' : String((source && source.name) || '未命名文件'));
    var info = typeof source === 'string' || settings.skipValidate ? { name: fileName, format: settings.format || detectFormat(source) || 'jpeg' } : validateFile(source);
    var config = normalizeConfig(configInput);
    var image = await loadImage(source);
    var width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    validateDimensions(width, height, info.name);
    var scale = settings.preview ? previewScale(width, height, settings.previewMaxSide) : 1;
    var targetWidth = Math.max(1, Math.round(width * scale)), targetHeight = Math.max(1, Math.round(height * scale));
    var output = outputFor(settings.outputFormat || info.format);
    var surface = createCanvas(targetWidth, targetHeight);
    surface.context.drawImage(image, 0, 0, targetWidth, targetHeight);
    if (config.type === 'text') {
      drawWatermark(surface.context, textMetrics(config, targetWidth, targetHeight), config, { width: targetWidth, height: targetHeight }, null);
    } else {
      var logo = await loadImage(config.watermarkImage);
      drawWatermark(surface.context, logoMetrics(config, targetWidth, targetHeight, logo.naturalWidth || logo.width, logo.naturalHeight || logo.height), config, { width: targetWidth, height: targetHeight }, logo);
    }
    var blob = await canvasToBlob(surface.canvas, output);
    return { blob: blob, fileName: outputName(info.name, output), width: targetWidth, height: targetHeight, originalWidth: width, originalHeight: height, mime: output.mime, format: info.format, scale: scale };
  }

  /* ───────── services/batchProcessor：任务队列 + 并发上限 + 失败隔离 ───────── */
  function createTask(file, id) {
    return { id: id, file: file, name: String((file && file.name) || '未命名文件'), status: 'pending', progress: 0, outputBlob: null, outputName: null, error: null };
  }
  function runBatchQueue(files, config, options) {
    var settings = options || {};
    var limit = Math.max(1, Math.min(4, Number(settings.maxConcurrent) || MAX_CONCURRENT));
    var tasks = (files || []).map(function (file, index) { return createTask(file, settings.prefix ? settings.prefix + '-' + index : String(index)); });
    var cursor = 0;
    async function worker() {
      while (cursor < tasks.length) {
        var task = tasks[cursor++];
        task.status = 'processing';
        if (settings.onTask) { try { settings.onTask(task); } catch (error) { void error; } }
        try {
          var result = await processImage(task.file, config, { fileName: task.name, preview: settings.preview });
          task.outputBlob = result.blob;
          task.outputName = result.fileName;
          task.width = result.width;
          task.height = result.height;
          task.status = 'success';
          task.progress = 100;
        } catch (error) {
          task.status = 'failed';
          // 失败必须留信息，且绝不吞掉整批
          task.error = { fileName: task.name, errorCode: (error && error.code) || 'watermark_failed', message: (error && error.message) || '未知错误' };
        }
        if (settings.onTask) { try { settings.onTask(task); } catch (error) { void error; } }
        if (settings.onProgress) { try { settings.onProgress(tasks.filter(function (item) { return item.status === 'success' || item.status === 'failed'; }).length, tasks.length); } catch (error) { void error; } }
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(limit, tasks.length); i += 1) workers.push(worker());
    return Promise.all(workers).then(function () { return tasks; });
  }

  return {
    MAX_CONCURRENT: MAX_CONCURRENT, PREVIEW_MAX_SIDE: PREVIEW_MAX_SIDE, JPEG_QUALITY: JPEG_QUALITY, POSITIONS: POSITIONS.slice(), ACCEPTED_TYPES: ACCEPTED_TYPES.slice(),
    POSITION_AXES: Object.assign({}, POSITION_AXES), FONT_STACKS: Object.assign({}, FONT_STACKS), DEFAULT_FONT: DEFAULT_FONT,
    detectFormat: detectFormat, outputFor: outputFor, outputName: outputName,
    getWatermarkPosition: getWatermarkPosition, textMetrics: textMetrics, logoMetrics: logoMetrics, previewScale: previewScale,
    validateFile: validateFile, validateDimensions: validateDimensions, normalizeConfig: normalizeConfig,
    loadImage: loadImage, createCanvas: createCanvas, drawWatermark: drawWatermark, canvasToBlob: canvasToBlob,
    processImage: processImage, createTask: createTask, runBatchQueue: runBatchQueue
  };
});
