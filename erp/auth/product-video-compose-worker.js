'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function publicError(code, message, options = {}) {
  return Object.assign(new Error(message), { publicCode: code, retryable: options.retryable === true, details: options.details || null });
}

function normalizeComposeOptions(input = {}) {
  const durationSeconds = Math.floor(Number(input.durationSeconds) || 0);
  if (durationSeconds < 8 || durationSeconds > 20) throw publicError('product_video_duration_invalid', '视频时长必须在8到20秒之间。');
  const transition = input.transition === 'fade' ? 'fade' : 'cut';
  const motion = input.motion === true;
  const width = Math.max(2, Math.min(2160, Math.floor(Number(input.width) || 1080)));
  const height = Math.max(2, Math.min(2880, Math.floor(Number(input.height) || 1440)));
  const fps = Math.max(24, Math.min(30, Math.floor(Number(input.fps) || 25)));
  return { durationSeconds, transition, motion, width: width - width % 2, height: height - height % 2, fps };
}

function normalizedImageExtension(value) {
  const extension = String(value || '').trim().toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw publicError('product_video_image_format_invalid', '视频合成只支持JPG、PNG、WEBP商品图片。');
  return extension === '.jpeg' ? '.jpg' : extension;
}

function validateImages(images) {
  if (!Array.isArray(images) || images.length < 2 || images.length > 8) throw publicError('product_video_image_count_invalid', '请选择2到8张商品图片生成视频。');
  let totalBytes = 0;
  return images.map((item, index) => {
    if (!Buffer.isBuffer(item && item.body) || !item.body.length) throw publicError('product_video_image_missing', `第${index + 1}张商品图片无法读取，请刷新图片后重试。`);
    if (item.body.length > 15 * 1024 * 1024) throw publicError('product_video_image_too_large', `第${index + 1}张商品图片过大，请压缩后重试。`);
    totalBytes += item.body.length;
    return { body: item.body, extension: normalizedImageExtension(item.extension) };
  }).map(item => {
    if (totalBytes > 80 * 1024 * 1024) throw publicError('product_video_input_too_large', '所选图片总大小过大，请减少图片后重试。');
    return item;
  });
}

function parseHttpByteRange(value, sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('video size must be a non-negative safe integer');
  const header = String(value || '').trim();
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2]) || size === 0) return { valid: false };
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { valid: false };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 0 || start >= size) return { valid: false };
    if (!match[2]) end = size - 1;
    else {
      end = Number(match[2]);
      if (!Number.isSafeInteger(end) || end < start) return { valid: false };
      end = Math.min(end, size - 1);
    }
  }
  return { valid: true, start, end, length: end - start + 1 };
}

function seconds(value) {
  return Number(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function imageFilter(index, options, segmentSeconds) {
  const { width, height, fps, motion } = options;
  const normalize = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=${fps},format=yuv420p`;
  const animate = motion ? `,zoompan=z='min(zoom+0.00025,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${width}x${height}:fps=${fps}` : '';
  return `[${index}:v]${normalize}${animate},trim=duration=${seconds(segmentSeconds)},settb=AVTB,setpts=PTS-STARTPTS[v${index}]`;
}

function buildFfmpegArgs(inputFiles, input = {}, outputFile) {
  const options = normalizeComposeOptions(input);
  if (!Array.isArray(inputFiles) || inputFiles.length < 2 || inputFiles.length > 8) throw publicError('product_video_image_count_invalid', '请选择2到8张商品图片生成视频。');
  if (!outputFile) throw new Error('outputFile is required');
  const fadeSeconds = options.transition === 'fade' ? Math.min(0.4, options.durationSeconds / inputFiles.length / 3) : 0;
  const segmentSeconds = options.transition === 'fade'
    ? (options.durationSeconds + fadeSeconds * (inputFiles.length - 1)) / inputFiles.length
    : options.durationSeconds / inputFiles.length;
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const file of inputFiles) args.push('-loop', '1', '-framerate', String(options.fps), '-t', seconds(segmentSeconds), '-i', file);
  const filters = inputFiles.map((_, index) => imageFilter(index, options, segmentSeconds));
  let outputLabel = 'vout';
  if (options.transition === 'fade') {
    let previous = 'v0';
    for (let index = 1; index < inputFiles.length; index++) {
      const next = index === inputFiles.length - 1 ? outputLabel : `xf${index}`;
      const offset = index * (segmentSeconds - fadeSeconds);
      filters.push(`[${previous}][v${index}]xfade=transition=fade:duration=${seconds(fadeSeconds)}:offset=${seconds(offset)}[${next}]`);
      previous = next;
    }
  } else {
    filters.push(inputFiles.map((_, index) => `[v${index}]`).join('') + `concat=n=${inputFiles.length}:v=1:a=0[${outputLabel}]`);
  }
  filters.push(`[${outputLabel}]trim=duration=${seconds(options.durationSeconds)},setpts=PTS-STARTPTS[final]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[final]', '-an', '-c:v', String(input.encoder || 'libx264'), '-preset', 'superfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', seconds(options.durationSeconds), outputFile);
  return { args, options, fadeSeconds, segmentSeconds };
}

function runFfmpeg(executable, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = Math.max(5000, Math.min(5 * 60 * 1000, Number(options.timeoutMs) || 120000));
  return new Promise((resolve, reject) => {
    let stderr = '', settled = false;
    const child = spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch (_) {}
      settled = true;
      reject(publicError('product_video_ffmpeg_timeout', '视频合成超时，请减少图片或稍后重试。', { retryable: true }));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    child.stderr && child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(publicError('product_video_ffmpeg_unavailable', '视频合成组件未就绪，请联系管理员检查FFmpeg配置。', { details: error.code || error.message }));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(publicError('product_video_ffmpeg_failed', '视频合成失败，请检查商品图片后重试。', { details: stderr.replace(/\s+/g, ' ').trim().slice(0, 1000) }));
    });
  });
}

async function composeProductVideo(input = {}) {
  const images = validateImages(input.images);
  const options = normalizeComposeOptions(input);
  const ffmpegPath = String(input.ffmpegPath || process.env.ERP_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wyerp-product-video-'));
  try {
    const files = images.map((item, index) => {
      const file = path.join(tempRoot, `image-${String(index + 1).padStart(2, '0')}${item.extension}`);
      fs.writeFileSync(file, item.body, { flag: 'wx', mode: 0o600 });
      return file;
    });
    const outputFile = path.join(tempRoot, 'result.mp4');
    const built = buildFfmpegArgs(files, { ...options, encoder: input.encoder }, outputFile);
    await runFfmpeg(ffmpegPath, built.args, { timeoutMs: input.timeoutMs, spawnImpl: input.spawnImpl });
    const body = fs.readFileSync(outputFile);
    if (body.length < 12 || body.subarray(4, 8).toString('ascii') !== 'ftyp') throw publicError('product_video_output_invalid', '视频合成结果格式异常，请重新生成。');
    if (body.length > 100 * 1024 * 1024) throw publicError('product_video_output_too_large', '视频合成结果过大，请减少图片或缩短时长。');
    return { body, mimeType: 'video/mp4', extension: '.mp4', sizeBytes: body.length, durationSeconds: options.durationSeconds, width: options.width, height: options.height, fps: options.fps, transition: options.transition, motion: options.motion };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

module.exports = { ALLOWED_EXTENSIONS, normalizeComposeOptions, validateImages, parseHttpByteRange, buildFfmpegArgs, runFfmpeg, composeProductVideo };
