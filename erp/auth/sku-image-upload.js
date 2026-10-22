'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 12_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const SKU_PREVIEW_MAX_SIDE = 360;
const TYPES = Object.freeze({
  'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/bmp': ['bmp'],
  'image/heic': ['heic'], 'image/heif': ['heif'], 'image/webp': ['webp'],
  'image/avif': ['avif'], 'image/gif': ['gif']
});
const DEFAULT_MAGICK = process.platform === 'win32' ? 'C:\\Program Files\\ImageMagick-7.1.2-Q16-HDRI\\magick.exe' : '/usr/bin/magick';
const POLICY_DIR = path.resolve(__dirname, '..', 'config', 'imagemagick');

function executable() { return path.resolve(String(process.env.ERP_IMAGEMAGICK_PATH || DEFAULT_MAGICK)); }

// 文字水印必须显式指定字体：ImageMagick 默认字体没有中文字形，中文会被静默丢掉（画出来只剩英文数字）。
// 可用 ERP_STAMP_FONT 指定；否则按候选顺序找第一个存在的字体文件；一个都找不到就报错，绝不静默降级。
const STAMP_FONT_CANDIDATES = [
  process.env.ERP_STAMP_FONT,
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
].filter(Boolean);
let stampFontCache = null;
function stampFont() {
  if (stampFontCache && fs.existsSync(stampFontCache)) return stampFontCache;
  const found = STAMP_FONT_CANDIDATES.map(item => path.resolve(String(item))).find(file => fs.existsSync(file));
  if (!found) throw fail('sku_image_stamp_font_unavailable', '服务器缺少可用于水印文字的字体（中文需要中文字体），请安装字体或用 ERP_STAMP_FONT 指定', 503);
  stampFontCache = found;
  return found;
}
let readiness;
function processorReady() {
  try {
    const binary = executable(), policyFile = path.join(POLICY_DIR, 'policy.xml'), key = `${binary}:${fs.statSync(binary).mtimeMs}:${fs.statSync(policyFile).mtimeMs}`;
    if (readiness?.key === key) return readiness.ok;
    const policy = fs.readFileSync(policyFile, 'utf8'), version = execFileSync(binary, ['-version'], { env: { ...process.env, MAGICK_CONFIGURE_PATH: POLICY_DIR }, windowsHide: true, timeout: 5000, encoding: 'utf8' });
    const ok = /ImageMagick 7\.1\.2-29 Q16-HDRI/.test(version) && /domain="module" rights="none"/.test(policy) && /domain="delegate" rights="none" pattern="\*"/.test(policy) && /domain="filter" rights="none" pattern="\*"/.test(policy) && /domain="path" rights="none" pattern="@\*"/.test(policy) && /pattern="\{JPEG,JPG,PNG\}"/.test(policy);
    readiness = { key, ok }; return ok;
  } catch (_) { readiness = undefined; return false; }
}
function fail(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }
function sniff(body) {
  if (!Buffer.isBuffer(body) || !body.length) throw fail('sku_image_empty', '图片文件为空');
  if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
  if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (body.length >= 12 && body.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = body.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return 'image/heic';
  }
  throw fail('sku_image_content_invalid', '图片文件头不属于允许的静态格式', 415);
}
function validate({ body, contentType, name }) {
  if (!Buffer.isBuffer(body) || body.length > MAX_BYTES) throw fail('sku_image_too_large', '单张图片不得超过 6 MiB', 413);
  const mimeType = sniff(body), extension = String(name || '').split('.').pop().toLowerCase(), supplied = String(contentType || '').split(';')[0].toLowerCase();
  const heifAlias = mimeType === 'image/heic' && supplied === 'image/heif' && extension === 'heif';
  if (!(TYPES[mimeType] || []).includes(extension) && !heifAlias || supplied !== mimeType && !heifAlias) throw fail('sku_image_type_mismatch', '图片扩展名、MIME 与文件内容不一致', 415);
  return { inputMimeType: heifAlias ? 'image/heif' : mimeType, inputExtension: '.' + extension, inputSizeBytes: body.length, inputSha256: crypto.createHash('sha256').update(body).digest('hex') };
}
function environment() { return { ...process.env, MAGICK_CONFIGURE_PATH: POLICY_DIR, MAGICK_TEMPORARY_PATH: os.tmpdir(), OMP_NUM_THREADS: '1' }; }
function normalizeOperations(value) {
  if (!Array.isArray(value) || value.length > 12) throw fail('sku_image_operations_invalid', '图片处理参数无效');
  return value.map(operation => {
    if (!operation || typeof operation !== 'object') throw fail('sku_image_operations_invalid', '图片处理参数无效');
    if (operation.type === 'rotate' && [90, 180, 270].includes(Number(operation.degrees))) return { type: 'rotate', degrees: Number(operation.degrees) };
    if (operation.type === 'crop') {
      const result = { type: 'crop', x: Number(operation.x), y: Number(operation.y), width: Number(operation.width), height: Number(operation.height) };
      if (Object.values(result).slice(1).every(Number.isInteger) && result.x >= 0 && result.y >= 0 && result.width > 0 && result.height > 0 && result.width <= MAX_SIDE && result.height <= MAX_SIDE) return result;
    }
    if (operation.type === 'resize') {
      const result = { type: 'resize', width: Number(operation.width), height: Number(operation.height), fit: String(operation.fit || 'pad') };
      if (Number.isInteger(result.width) && Number.isInteger(result.height) && result.width > 0 && result.height > 0 && result.width <= MAX_SIDE && result.height <= MAX_SIDE && result.width * result.height <= MAX_PIXELS && ['pad', 'crop', 'stretch'].includes(result.fit)) return result;
    }
      if (operation.type === 'stamp') {
        const text = String(operation.text == null ? '' : operation.text).replace(/[\u0000-\u001f\u007f]/g, '').trim();
        const result = {
          type: 'stamp',
          text,
          x: Number(operation.x),
          y: Number(operation.y),
          size: Number(operation.size),
          opacity: Number(operation.opacity),
          color: String(operation.color || '#000000').toLowerCase()
        };
        const TEXT_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9 .,:?\u3001\u3002\uFF0C\uFF01\uFF1F\uFF1B\uFF1A\uFF08\uFF09()\[\]\u3010\u3011*+\/-]+$/;
        if (!text || text.length > 40 || !TEXT_PATTERN.test(text)) throw fail('sku_image_stamp_text_invalid', '水印文字只能是 1-40 个常规字符（中文、字母、数字和常见标点），不要用 % 反引号 引号或反斜杠');
        if (!Number.isInteger(result.x) || !Number.isInteger(result.y) || result.x < 0 || result.y < 0 || result.x > 20000 || result.y > 20000) throw fail('sku_image_stamp_position_invalid', '水印位置需是 0-20000 范围内的整数坐标');
        if (!Number.isInteger(result.size) || result.size < 8 || result.size > 400) throw fail('sku_image_stamp_size_invalid', '水印字号需为 8-400 像素');
        if (!Number.isInteger(result.opacity) || result.opacity < 1 || result.opacity > 100) throw fail('sku_image_stamp_opacity_invalid', '水印不透明度需为 1-100');
        if (!/^#[0-9a-f]{6}$/.test(result.color)) throw fail('sku_image_stamp_color_invalid', '水印颜色必须是 #RRGGBB 十六进制');
        return result;
      }
    if (operation.type === 'watermark') {
      const result = { type: 'watermark', x: Number(operation.x), y: Number(operation.y), width: Number(operation.width), height: Number(operation.height) };
      if (Object.values(result).slice(1).every(Number.isInteger) && result.x >= 0 && result.y >= 0 && result.width > 0 && result.height > 0 && result.width <= MAX_SIDE && result.height <= MAX_SIDE) {
        if (operation.mask !== undefined) {
          const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(operation.mask));
          if (!match) throw fail('sku_image_mask_invalid', '选区蒙版必须为PNG');
          const maskBody = Buffer.from(match[1], 'base64');
          if (!maskBody.length || maskBody.length > 512 * 1024 || sniff(maskBody) !== 'image/png') throw fail('sku_image_mask_invalid', '选区蒙版无效或过大');
          result.mask = `data:image/png;base64,${maskBody.toString('base64')}`;
          result.maskSha256 = crypto.createHash('sha256').update(maskBody).digest('hex');
        }
        return result;
      }
    }
    throw fail('sku_image_operations_invalid', '图片处理参数无效');
  });
}
async function command(args, timeout = 20_000, listLengthError) {
  if (!processorReady()) throw fail('sku_image_processor_unavailable', '图片处理引擎不可用', 503);
  try { return await run(executable(), args, { env: environment(), timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }); }
  catch (cause) {
    if (cause.killed || cause.signal) throw fail('sku_image_processing_timeout', '图片处理超时', 422);
    if (listLengthError && /list length exceeds limit/i.test(String(cause.stderr || cause.message || ''))) throw fail(listLengthError.code, listLengthError.message, listLengthError.status);
    throw fail('sku_image_decode_failed', '图片损坏、格式异常或无法安全解析', 415);
  }
}
async function processImage({ body, contentType, name, operations = [], outputFormat = 'jpeg' }) {
  const input = validate({ body, contentType, name });
  operations = normalizeOperations(operations);
  outputFormat = String(outputFormat || 'jpeg').toLowerCase();
  if (!['jpeg', 'png'].includes(outputFormat)) throw fail('sku_image_output_format_invalid', '只允许输出 JPG 或 PNG');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wyerp-sku-image-'));
  const extension = outputFormat === 'png' ? '.png' : '.jpg', mimeType = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
  const source = path.join(directory, 'source' + input.inputExtension), output = path.join(directory, 'working' + extension);
  try {
    await fs.promises.writeFile(source, body, { flag: 'wx', mode: 0o600 });
    const identified = await command(['identify', '-quiet', '-format', '%m|%w|%h|%n\n', source], 20_000, { code: 'sku_image_animated_not_allowed', message: '暂不支持动态图，请上传静态图片', status: 415 });
    const rows = String(identified.stdout || '').trim().split(/\r?\n/).filter(Boolean), fields = (rows[0] || '').split('|');
    const width = Number(fields[1]), height = Number(fields[2]), frames = Math.max(rows.length, Number(fields[3]) || 0);
    if (frames !== 1) throw fail('sku_image_animated_not_allowed', '不支持动态图或多帧图片', 415);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw fail('sku_image_dimensions_invalid', '图片尺寸或总像素超过安全上限', 422);
    const args = [source + '[0]', '-auto-orient', '-strip', '-colorspace', 'sRGB'];
    const stampJobs = [];
    let maskIndex = 0;
    for (const operation of operations) {
      if (operation.type === 'rotate') args.push('-rotate', String(operation.degrees));
      if (operation.type === 'crop') args.push('-crop', `${operation.width}x${operation.height}+${operation.x}+${operation.y}`, '+repage');
      if (operation.type === 'resize') {
        const geometry = `${operation.width}x${operation.height}`;
        if (operation.fit === 'stretch') args.push('-resize', geometry + '!');
        else if (operation.fit === 'crop') args.push('-resize', geometry + '^', '-gravity', 'center', '-extent', geometry);
        else args.push('-resize', geometry, '-background', 'white', '-gravity', 'center', '-extent', geometry);
      }
      if (operation.type === 'stamp') {
        // 文字水印单独走“先渲染文字、再合成”两步：在同一条命令里 -font 对中文不生效（实测只剩 ASCII），
        // 拆开后实测中文正常。见 stampTextToImage。
        stampJobs.push(operation);
      }
      if (operation.type === 'watermark' && !operation.mask) args.push('-region', `${operation.width}x${operation.height}+${operation.x}+${operation.y}`, '-statistic', 'Median', '25x25', '+region');
      if (operation.type === 'watermark' && operation.mask) {
        const mask = path.join(directory, `mask-${maskIndex++}.png`), maskBody = Buffer.from(operation.mask.slice('data:image/png;base64,'.length), 'base64');
        await fs.promises.writeFile(mask, maskBody, { flag: 'wx', mode: 0o600 });
        const maskInfo = String((await command(['identify', '-quiet', '-format', '%w|%h|%n', mask], 20_000, { code: 'sku_image_mask_invalid', message: '选区蒙版必须是单帧PNG', status: 400 })).stdout || '').trim().split('|');
        const maskWidth = Number(maskInfo[0]), maskHeight = Number(maskInfo[1]), maskFrames = Number(maskInfo[2]);
        if (!Number.isInteger(maskWidth) || !Number.isInteger(maskHeight) || maskWidth < 1 || maskHeight < 1 || maskWidth > 2048 || maskHeight > 2048 || maskWidth * maskHeight > 4_000_000 || maskFrames !== 1) throw fail('sku_image_mask_invalid', '选区蒙版尺寸无效');
        args.push('(', '+clone', '-statistic', 'Median', '25x25', ')', '(', mask + '[0]', '-resize', `${width}x${height}!`, ')', '-compose', 'over', '-composite');
      }
    }
    if (outputFormat === 'jpeg') args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-quality', '90');
    else args.push('-define', 'png:exclude-chunks=date,time');
    args.push(output);
    await command(args);
    for (const [index, stamp] of stampJobs.entries()) {
      const hex = String(stamp.color).slice(1);
      const red = parseInt(hex.slice(0, 2), 16), green = parseInt(hex.slice(2, 4), 16), blue = parseInt(hex.slice(4, 6), 16);
      const merged = path.join(directory, `stamped-${index}${extension}`);
      // 直接在成品图上 draw：不新建画布（我们的 policy 禁用了 XC 生成器），且单独一条命令里 -font 对中文有效。
      await command(['convert', output, '-font', stampFont(), '-fill', `rgba(${red},${green},${blue},${(stamp.opacity / 100).toFixed(3)})`, '-stroke', 'none', '-pointsize', String(stamp.size), '-draw', `text ${stamp.x},${stamp.y} '${stamp.text.replace(/'/g, '')}'`, merged], 20_000, { code: 'sku_image_stamp_failed', message: '水印添加失败', status: 422 });
      await fs.promises.rename(merged, output);
    }
    const converted = await fs.promises.readFile(output);
    if (!converted.length || converted.length > MAX_OUTPUT_BYTES || sniff(converted) !== mimeType) throw fail('sku_image_output_invalid', '转换结果无效或过大', 422);
    const info = await command(['identify', '-quiet', '-format', '%w|%h|%n', output]);
    const result = String(info.stdout || '').trim().split('|');
    const summaryOperations = operations.map(operation => operation.mask ? { ...operation, mask: undefined } : operation);
    return { body: converted, mimeType, extension, sizeBytes: converted.length, sha256: crypto.createHash('sha256').update(converted).digest('hex'), width: Number(result[0]), height: Number(result[1]), frameCount: 1, input, processingSummary: { engine: 'ImageMagick 7.1.2-29', autoOrient: true, colorspace: 'sRGB', metadataStripped: true, output: outputFormat, quality: outputFormat === 'jpeg' ? 90 : undefined, operations: summaryOperations } };
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

// SKU 图片列表只需要小尺寸预览。这里接收已经由服务器私有对象校验过的工作图，
// 生成最长边 360px 的 JPG；缩略图仍由私有对象存储加密保存，不进入静态目录或浏览器持久缓存。
async function createThumbnail({ body, contentType, maxSide = SKU_PREVIEW_MAX_SIDE }) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > MAX_OUTPUT_BYTES) throw fail('sku_image_preview_source_invalid', '预览图片内容无效或过大', 422);
  const mimeType = sniff(body);
  const supplied = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png'].includes(mimeType) || supplied && supplied !== mimeType) throw fail('sku_image_preview_source_invalid', '预览图片格式不正确', 415);
  const side = Number(maxSide);
  if (!Number.isInteger(side) || side < 64 || side > 720) throw fail('sku_image_preview_size_invalid', '预览尺寸参数不正确');
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wyerp-sku-preview-'));
  const source = path.join(directory, mimeType === 'image/png' ? 'source.png' : 'source.jpg');
  const output = path.join(directory, 'preview.jpg');
  try {
    await fs.promises.writeFile(source, body, { flag: 'wx', mode: 0o600 });
    const identified = await command(['identify', '-quiet', '-format', '%w|%h|%n', source], 20_000, { code: 'sku_image_preview_source_invalid', message: '预览图片不是可读取的单帧图片', status: 415 });
    const fields = String(identified.stdout || '').trim().split('|');
    const width = Number(fields[0]), height = Number(fields[1]), frames = Number(fields[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS || frames !== 1) throw fail('sku_image_preview_source_invalid', '预览图片尺寸不正确或包含多帧内容', 422);
    await command([source + '[0]', '-auto-orient', '-strip', '-colorspace', 'sRGB', '-thumbnail', `${side}x${side}>`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', '-quality', '82', output]);
    const converted = await fs.promises.readFile(output);
    if (!converted.length || converted.length > 2 * 1024 * 1024 || sniff(converted) !== 'image/jpeg') throw fail('sku_image_preview_output_invalid', '预览图生成结果无效', 422);
    const previewInfo = String((await command(['identify', '-quiet', '-format', '%w|%h|%n', output])).stdout || '').trim().split('|');
    const previewWidth = Number(previewInfo[0]), previewHeight = Number(previewInfo[1]), previewFrames = Number(previewInfo[2]);
    if (!Number.isInteger(previewWidth) || !Number.isInteger(previewHeight) || previewWidth < 1 || previewHeight < 1 || previewWidth > side || previewHeight > side || previewFrames !== 1) throw fail('sku_image_preview_output_invalid', '预览图尺寸校验未通过', 422);
    return {
      body: converted,
      mimeType: 'image/jpeg',
      extension: '.jpg',
      sizeBytes: converted.length,
      sha256: crypto.createHash('sha256').update(converted).digest('hex'),
      width: previewWidth,
      height: previewHeight,
      sourceWidth: width,
      sourceHeight: height,
      maxSide: side
    };
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
}

// probe：只做校验与尺寸识别，不重编码。用于“替换版本”上传（例如浏览器本地画好水印后回写原链接），
// 内容由客户端生成，服务端负责格式校验、尺寸识别与哈希落库。
async function probe({ body, contentType, name }) {
  if (!processorReady()) throw fail('sku_image_processor_unavailable', '图片处理引擎不可用', 503);
  const input = validate({ body, contentType, name });
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wyerp-sku-image-'));
  const source = path.join(directory, 'source' + input.inputExtension);
  try {
    await fs.promises.writeFile(source, body, { flag: 'wx', mode: 0o600 });
    const identified = await command(['identify', '-quiet', '-format', '%w|%h|%n\n', source], 20_000, { code: 'sku_image_animated_not_allowed', message: '暂不支持动态图，请上传静态图片', status: 415 });
    const rows = String(identified.stdout || '').trim().split(/\r?\n/).filter(Boolean), fields = (rows[0] || '').split('|');
    const frames = Math.max(rows.length, Number(fields[3]) || 0);
    if (frames !== 1) throw fail('sku_image_animated_not_allowed', '不支持动态图或多帧图片', 415);
    const width = Number(fields[1]), height = Number(fields[2]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw fail('sku_image_dimensions_invalid', '图片尺寸或总像素超过安全上限', 422);
    return { input, width, height, frameCount: 1 };
  } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(body) { let value = 0xffffffff; for (const byte of body) value = CRC_TABLE[(value ^ byte) & 0xff] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function createZip(files) {
  if (!Array.isArray(files) || !files.length || files.length > 30) throw fail('sku_image_download_invalid', '下载图片数量无效');
  const locals = [], directories = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(String(file.name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120), 'utf8'), body = Buffer.from(file.body || []), checksum = crc32(body);
    if (!name.length || !body.length) throw fail('sku_image_download_invalid', '下载图片无效');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); directories.push(central, name); offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(directories), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

module.exports = { MAX_BYTES, MAX_PIXELS, MAX_SIDE, SKU_PREVIEW_MAX_SIDE, TYPES, sniff, validate, normalizeOperations, processImage, createThumbnail, probe, createZip, processorReady, executable, POLICY_DIR };
