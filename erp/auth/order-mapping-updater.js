'use strict';

const fs = require('fs');
const path = require('path');
const { decrypt } = require('./ai-config');
const { parseCredentialKey } = require('./credential-crypto');
const { loadRuntimeSecret } = require('./runtime-secret');

const START = '  // AUTO-MAPPING-START: 服务端更新器只允许原子更新这个对象。';
const END = '  // AUTO-MAPPING-END';
const MAPPING_LOCK_RETRY_MS = 50;
const MAPPING_LOCK_TIMEOUT_MS = 5000;
const MAPPING_LOCK_STALE_MS = 30000;
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function processAlive(pid) {
  if (!(Number(pid) > 0)) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error && error.code !== 'ESRCH' ? true : false; }
}
async function withMappingFileLock(file, action) {
  const lockFile = file + '.wyerp.lock';
  const started = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await fs.promises.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }), 'utf8');
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      try {
        const info = JSON.parse(await fs.promises.readFile(lockFile, 'utf8'));
        if (Date.now() - Number(info.createdAt || 0) > MAPPING_LOCK_STALE_MS && !processAlive(info.pid)) await fs.promises.unlink(lockFile);
      } catch (readError) {
        if (readError && readError.code === 'ENOENT') continue;
      }
      if (Date.now() - started >= MAPPING_LOCK_TIMEOUT_MS) throw Object.assign(new Error('公共映射正在由另一个进程更新，请稍后重试。'), { code: 'mapping_update_busy' });
      await wait(MAPPING_LOCK_RETRY_MS);
    }
  }
  try { return await action(); }
  finally {
    try { await handle.close(); } catch (error) {}
    try { await fs.promises.unlink(lockFile); } catch (error) { if (!error || error.code !== 'ENOENT') console.error('[order-mapping-updater] 释放映射锁失败:', error.message); }
  }
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function validate(reason, chinese) {
  const source = clean(reason, 500);
  const translated = clean(chinese, 500);
  if (!source || !/[\u0400-\u04ff]/.test(source)) throw Object.assign(new Error('取消或拒收原因缺少俄文原文，不能写入中文映射，请先从订单接口取回原文。'), { code: 'order_mapping_reason_invalid' });
  if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw Object.assign(new Error('取消或拒收原因的中文译文不合格，请重新提供准确的中文译文。'), { code: 'order_mapping_translation_invalid' });
  return { source, translated };
}

function parseMap(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start < 0 || end < 0) throw Object.assign(new Error('订单映射文件缺少起止标记，不能安全写回，请联系系统管理员恢复该文件。'), { code: 'order_mapping_markers_missing' });
  const block = source.slice(start + START.length, end);
  const match = block.match(/var CANCEL_REASON_ZH = (\{[^]*?\});/);
  if (!match) throw Object.assign(new Error('订单映射文件里没有找到取消拒收原因映射结构，请联系系统管理员检查该文件。'), { code: 'order_mapping_object_missing' });
  const values = {};
  const entry = /^\s*(['"])(.*?)\1\s*:\s*(['"])(.*?)\3,?\s*$/gm;
  let found;
  while ((found = entry.exec(match[1]))) values[found[2]] = found[4];
  if (!Object.keys(values).length) throw Object.assign(new Error('订单映射文件里的取消或拒收原因映射为空，请联系系统管理员补齐后再试。'), { code: 'order_mapping_entries_missing' });
  return { start, end, values };
}

function parseFeeMap(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start < 0 || end < 0) throw Object.assign(new Error('订单映射文件缺少起止标记，不能安全写回，请联系系统管理员恢复该文件。'), { code: 'order_mapping_markers_missing' });
  const block = source.slice(start + START.length, end);
  const match = block.match(/var ACCRUAL_FEE_ZH = (\{[^]*?\});/);
  if (!match) throw Object.assign(new Error('订单映射文件里没有找到已签收费用名称映射结构，请联系系统管理员检查该文件。'), { code: 'order_fee_mapping_object_missing' });
  const values = Object.create(null);
  const body = match[1].slice(1, -1);
  // 兼容原文件同一行的多个数字键，以及新写入的 JSON 转义字符串。
  const entry = /(?:^|,)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\d+)|([a-z_][a-z0-9_]*))\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*(?=,|$)/gim;
  let found;
  let cursor = 0;
  while ((found = entry.exec(body))) {
    if (!/^[\s,]*$/.test(body.slice(cursor, found.index))) throw Object.assign(new Error('订单费用名称映射结构含有无法识别的内容，不能安全写回，请联系系统管理员检查该文件。'), { code: 'order_fee_mapping_object_invalid' });
    let key, value;
    try {
      key = found[1] != null ? JSON.parse('"' + found[1] + '"') : found[2] != null ? decodeSingleQuoted(found[2]) : found[3] || found[4];
      value = found[5] != null ? JSON.parse('"' + found[5] + '"') : decodeSingleQuoted(found[6]);
    } catch (_) {
      throw Object.assign(new Error('订单费用名称映射结构含有无法识别的内容，不能安全写回，请联系系统管理员检查该文件。'), { code: 'order_fee_mapping_object_invalid' });
    }
    const isNumeric = /^\d+$/.test(key);
    values[isNumeric ? Number(key) : key] = value;
    cursor = entry.lastIndex;
  }
  if (!/^[\s,]*$/.test(body.slice(cursor))) throw Object.assign(new Error('订单费用名称映射结构含有无法识别的内容，不能安全写回，请联系系统管理员检查该文件。'), { code: 'order_fee_mapping_object_invalid' });
  // Find exact position of ACCRUAL_FEE_ZH in source
  const feeStart = source.indexOf('var ACCRUAL_FEE_ZH =', start);
  const feeEnd = source.indexOf('};', feeStart) + 2;
  return { start, end, feeStart, feeEnd, values };
}

function decodeSingleQuoted(value) {
  return value.replace(/\\(u[0-9a-f]{4}|x[0-9a-f]{2}|.)/gi, (_, escaped) => {
    if (escaped[0] === 'u' || escaped[0] === 'x') return String.fromCharCode(parseInt(escaped.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t' }[escaped] || escaped;
  });
}

function validateFee(typeId, rawName, chinese) {
  const source = clean(rawName, 500);
  const translated = clean(chinese, 200);
  if (!source && typeId == null) throw Object.assign(new Error('费用名称映射缺少俄文原文或费用类型编号，请先从接口取回原始费用名称。'), { code: 'order_fee_mapping_source_invalid' });
  if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw Object.assign(new Error('费用名称的中文译文不合格，请重新提供准确的中文译文。'), { code: 'order_fee_translation_invalid' });
  let normalizedTypeId = null;
  if (typeId != null) {
    const num = Number(typeId);
    normalizedTypeId = isNaN(num) ? String(typeId) : num;
  }
  return { typeId: normalizedTypeId, source, translated };
}

async function persistTranslation(file, reason, chinese) {
  const checked = validate(reason, chinese);
  const source = await fs.promises.readFile(file, 'utf8');
  const parsed = parseMap(source);
  if (parsed.values[checked.source] === checked.translated) return { changed: false, reason: checked.source, chinese: checked.translated };
  parsed.values[checked.source] = checked.translated;
  const ordered = Object.fromEntries(Object.entries(parsed.values).sort((a, b) => a[0].localeCompare(b[0], 'ru')));
  const generated = START + '\n  var CANCEL_REASON_ZH = ' + JSON.stringify(ordered, null, 2).replace(/^/gm, '  ').trimStart() + ';\n';
  const next = source.slice(0, parsed.start) + generated + source.slice(parsed.end);
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
  return { changed: true, reason: checked.source, chinese: checked.translated };
}

async function persistFeeTranslation(file, typeId, rawName, chinese) {
  const checked = validateFee(typeId, rawName, chinese);
  const source = await fs.promises.readFile(file, 'utf8');
  const parsed = parseFeeMap(source);
  
  // 检查是否已存在相同映射
  let existingKey = null;
  if (checked.typeId != null && parsed.values[checked.typeId] === checked.translated) {
    return { changed: false, typeId: checked.typeId, source: checked.source, chinese: checked.translated };
  }
  if (checked.source && Object.keys(parsed.values).some(key => String(key).toLowerCase() === checked.source.toLowerCase())) {
    const foundKey = Object.keys(parsed.values).find(key => String(key).toLowerCase() === checked.source.toLowerCase());
    if (parsed.values[foundKey] === checked.translated) {
      return { changed: false, typeId: checked.typeId, source: checked.source, chinese: checked.translated };
    }
    existingKey = foundKey;
  }
  
  // 添加或更新映射
  const key = checked.typeId != null ? checked.typeId : checked.source.toLowerCase();
  parsed.values[key] = checked.translated;
  
  // 分离数字键和字符串键，分别排序
  const numericKeys = Object.keys(parsed.values).filter(k => /^\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  const stringKeys = Object.keys(parsed.values).filter(k => !/^\d+$/.test(k)).sort((a, b) => a.localeCompare(b));
  
  // 生成新的 ACCRUAL_FEE_ZH 对象文本
  const lines = [];
  let currentLine = '';
  
  // 先写数字键（每行多个）
  for (const numKey of numericKeys) {
    const entry = `${numKey}: ${JSON.stringify(parsed.values[numKey])}`;
    if (currentLine && currentLine.length + entry.length + 2 > 120) {
      lines.push(currentLine);
      currentLine = '';
    }
    if (currentLine) currentLine += ', ';
    currentLine += entry;
  }
  if (currentLine) lines.push(currentLine);
  
  // 再写字符串键（每行一个，键必须加引号以支持空格和特殊字符）
  for (const strKey of stringKeys) {
    lines.push(`${JSON.stringify(strKey)}: ${JSON.stringify(parsed.values[strKey])}`);
  }
  
  const generated = 'var ACCRUAL_FEE_ZH = {\n    ' + lines.join(',\n    ') + '\n  };';
  const next = source.slice(0, parsed.feeStart) + generated + source.slice(parsed.feeEnd);
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
  return { changed: true, typeId: checked.typeId, source: checked.source, chinese: checked.translated };
}

function validateReturnStatus(rawStatus, chinese) {
  const source = clean(rawStatus, 500);
  const translated = clean(chinese, 200);
  if (!source) throw Object.assign(new Error('退货状态映射缺少俄文原文，请先从退货接口取回原始状态。'), { code: 'order_return_status_source_invalid' });
  if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw Object.assign(new Error('退货状态的中文译文不合格，请重新提供准确的中文译文。'), { code: 'order_return_status_translation_invalid' });
  return { source, translated };
}

function parseReturnStatusMap(source) {
  // RETURN_STATUS_ZH has its own later auto-mapping block, not the cancellation/fee block.
  let start = -1, end = -1, objectMatch = null, blockStart = -1;
  let offset = 0;
  while (true) {
    const nextStart = source.indexOf(START, offset);
    if (nextStart < 0) break;
    const nextEnd = source.indexOf(END, nextStart + START.length);
    if (nextEnd < 0) throw Object.assign(new Error('订单映射文件缺少结束标记，不能安全写回，请联系系统管理员检查该文件。'), { code: 'order_mapping_markers_missing' });
    const contentStart = nextStart + START.length;
    const block = source.slice(contentStart, nextEnd);
    const candidate = block.match(/\bvar\s+RETURN_STATUS_ZH\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (candidate) {
      if (objectMatch) throw Object.assign(new Error('订单映射文件出现重复的退货状态映射区块，不能安全写回。'), { code: 'order_return_status_object_ambiguous' });
      start = nextStart;
      end = nextEnd;
      blockStart = contentStart;
      objectMatch = candidate;
    }
    offset = nextEnd + END.length;
  }
  if (source.indexOf(START) < 0 || source.indexOf(END) < 0) throw Object.assign(new Error('订单映射文件缺少起止标记，不能安全写回，请联系系统管理员恢复该文件。'), { code: 'order_mapping_markers_missing' });
  if (!objectMatch) throw Object.assign(new Error('订单映射文件里没有找到退货状态映射结构，请联系系统管理员检查该文件。'), { code: 'order_return_status_object_missing' });
  const body = objectMatch[1].slice(1, -1);
  const entry = /(?:^|,)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\s*(?=,|$)/gm;
  const values = Object.create(null);
  let found, cursor = 0;
  const invalid = () => Object.assign(new Error('退货状态映射存在无法识别的内容，已拒绝写回，请联系系统管理员检查该文件。'), { code: 'order_return_status_entries_invalid' });
  while ((found = entry.exec(body))) {
    if (!/^[\s,]*$/.test(body.slice(cursor, found.index))) throw invalid();
    let key, value;
    try {
      key = found[1] != null ? JSON.parse('"' + found[1] + '"') : found[2] != null ? decodeSingleQuoted(found[2]) : found[3];
      value = found[4] != null ? JSON.parse('"' + found[4] + '"') : decodeSingleQuoted(found[5]);
    } catch (_) { throw invalid(); }
    if (Object.prototype.hasOwnProperty.call(values, key)) throw invalid();
    values[key] = value;
    cursor = entry.lastIndex;
  }
  if (!/^[\s,]*$/.test(body.slice(cursor))) throw invalid();
  if (!Object.keys(values).length) throw Object.assign(new Error('订单映射文件里的退货状态映射为空，请联系系统管理员补齐后再试。'), { code: 'order_return_status_entries_missing' });
  const statusStart = blockStart + objectMatch.index;
  const statusEnd = statusStart + objectMatch[0].length;
  return { start, end, statusStart, statusEnd, values };
}
async function persistReturnStatusTranslationUnlocked(file, rawStatus, chinese) {
  const checked = validateReturnStatus(rawStatus, chinese);
  const source = await fs.promises.readFile(file, 'utf8');
  const parsed = parseReturnStatusMap(source);
  
  // 检查是否已存在相同映射
  if (parsed.values[checked.source] === checked.translated) {
    return { changed: false, source: checked.source, chinese: checked.translated };
  }
  
  // 添加或更新映射
  parsed.values[checked.source] = checked.translated;
  
  // 按字母顺序排序键
  const sortedKeys = Object.keys(parsed.values).sort((a, b) => a.localeCompare(b));
  
  // 生成新的 RETURN_STATUS_ZH 对象文本
  const lines = [];
  let currentLine = '';
  
  for (const key of sortedKeys) {
    const safeKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);
    const entry = safeKey + ": " + JSON.stringify(parsed.values[key]);
    if (currentLine && currentLine.length + entry.length + 2 > 120) {
      lines.push(currentLine);
      currentLine = '';
    }
    if (currentLine) currentLine += ', ';
    currentLine += entry;
  }
  if (currentLine) lines.push(currentLine);
  
  const generated = '  var RETURN_STATUS_ZH = {\n    ' + lines.join(',\n    ') + '\n  };';
  const next = source.slice(0, parsed.statusStart) + generated + source.slice(parsed.statusEnd);
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
  return { changed: true, source: checked.source, chinese: checked.translated };
}

async function persistReturnStatusTranslation(file, rawStatus, chinese) {
  return withMappingFileLock(file, () => persistReturnStatusTranslationUnlocked(file, rawStatus, chinese));
}

function validateCategory(rawName, chinese) {
  const source = clean(rawName, 500);
  const translated = clean(chinese, 200);
  if (!source) throw Object.assign(new Error('商品类目名称映射缺少俄文原文，请先从接口取回原始类目名称。'), { code: 'category_name_source_invalid' });
  if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw Object.assign(new Error('商品类目名称的中文译文不合格，请重新提供准确的中文译文。'), { code: 'category_translation_invalid' });
  return { source, translated };
}

function parseCategoryMap(source) {
  const start = source.indexOf(START);
  const end = source.indexOf(END, start + START.length);
  if (start < 0 || end < 0) throw Object.assign(new Error('订单映射文件缺少起止标记，不能安全写回，请联系系统管理员恢复该文件。'), { code: 'order_mapping_markers_missing' });
  const block = source.slice(start + START.length, end);
  const match = block.match(/var CAT_TRANSLATIONS = (\{[^]*?\});/);
  if (!match) throw Object.assign(new Error('订单映射文件里没有找到类目名称映射结构，请联系系统管理员检查该文件。'), { code: 'category_translations_object_missing' });
  const values = {};
  const entry = /^\s*(['"])(.*?)\1\s*:\s*(['"])(.*?)\3,?\s*$/gm;
  let found;
  while ((found = entry.exec(match[1]))) {
    values[found[2]] = found[4];
  }
  if (!Object.keys(values).length) throw Object.assign(new Error('订单映射文件里的类目名称映射为空，请联系系统管理员补齐后再试。'), { code: 'category_translations_entries_missing' });
  const catStart = source.indexOf('var CAT_TRANSLATIONS =', start);
  const catEnd = source.indexOf('};', catStart) + 2;
  return { start, end, catStart, catEnd, values };
}

async function persistCategoryTranslation(file, rawName, chinese) {
  const checked = validateCategory(rawName, chinese);
  const source = await fs.promises.readFile(file, 'utf8');
  const parsed = parseCategoryMap(source);
  
  // 检查是否已存在相同映射
  if (parsed.values[checked.source] === checked.translated) {
    return { changed: false, source: checked.source, chinese: checked.translated };
  }
  
  // 添加或更新映射
  parsed.values[checked.source] = checked.translated;
  
  // 按俄文字母顺序排序键
  const sortedKeys = Object.keys(parsed.values).sort((a, b) => a.localeCompare(b, 'ru'));
  
  // 生成新的 CAT_TRANSLATIONS 对象文本
  const entries = sortedKeys.map(key => `  "${key}": "${parsed.values[key]}"`);
  const generated = 'var CAT_TRANSLATIONS = {\n' + entries.join(',\n') + '\n};';
  const next = source.slice(0, parsed.catStart) + generated + source.slice(parsed.catEnd);
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
  return { changed: true, source: checked.source, chinese: checked.translated };
}

function parseTermsArray(source) {
  // 检测AUTO-MAPPING标记（支持不同注释后缀）
  const startMarker = '  // AUTO-MAPPING-START';
  const endMarker = '  // AUTO-MAPPING-END';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw Object.assign(new Error('订单映射文件缺少起止标记，不能安全写回，请联系系统管理员恢复该文件。'), { code: 'order_mapping_markers_missing' });
  const block = source.slice(start + startMarker.length, end);
  const match = block.match(/var terms = (\[[\s\S]*?\]);/);
  if (!match) throw Object.assign(new Error('订单映射文件里没有找到术语数组，请联系系统管理员检查该文件。'), { code: 'terms_array_missing' });
  
  const entries = [];
  // 匹配数组条目格式: ['中文','俄文','英文',...]
  const entryRegex = /\[(['"])(.*?)\1\s*,\s*(['"])(.*?)\3(?:\s*,\s*(['"])(.*?)\5)*\]/g;
  let found;
  while ((found = entryRegex.exec(match[1]))) {
    const row = [];
    // 提取所有引号内的值
    const valueRegex = /(['"])(.*?)\1/g;
    let val;
    while ((val = valueRegex.exec(found[0]))) {
      row.push(val[2]);
    }
    if (row.length >= 2) entries.push(row);
  }
  
  if (!entries.length) throw Object.assign(new Error('术语数组为空，不能写回映射文件，请先补充需要映射的术语。'), { code: 'terms_entries_missing' });
  const termsStart = source.indexOf('var terms =', start);
  const termsEnd = source.indexOf('];', termsStart) + 2;
  return { entries, startIndex: termsStart, endIndex: termsEnd, start, end };
}

/**
 * 公共映射翻译只使用系统管理员维护的官方AI服务配置。
 * 不读取当前租户/用户自有配置，也不接受客户端配置ID。
 */
function loadMappingCredentialKey() {
  const config = loadRuntimeSecret({
    envValue: process.env.ERP_CREDENTIALS_KEY,
    production: process.env.NODE_ENV === 'production',
    file: process.env.ERP_CREDENTIALS_KEY_FILE || path.join(__dirname, '..', '..', '本机数据', '配置', 'credentials.key')
  });
  return config.secret ? parseCredentialKey(config.secret) : null;
}

async function getTranslationAiConfig(account, aiConfigStore, options = {}) {
  try {
    if (!aiConfigStore || typeof aiConfigStore.availableOfficial !== 'function') throw Object.assign(new Error('官方AI配置读取器不可用'), { code: 'official_ai_store_unavailable' });
    const config = await aiConfigStore.availableOfficial(account, ['product-translation']);
    const credentialKey = Object.prototype.hasOwnProperty.call(options, 'credentialKey') ? options.credentialKey : loadMappingCredentialKey();
    const apiKey = decrypt(config, credentialKey);
    return { configuration: config, apiKey, official: true };
  } catch (error) {
    console.error('[order-mapping-updater] 获取系统官方AI配置失败:', error.publicCode || error.code || error.message);
    return null;
  }
}

function validateAiTranslationBatch(expectedValues, translations, sourceField) {
  const expected = (Array.isArray(expectedValues) ? expectedValues : []).map(value => clean(value, 500));
  const allowed = new Set(expected);
  const rows = Array.isArray(translations) ? translations : [];
  const seen = new Set();
  const checked = [];
  for (const row of rows) {
    const source = clean(row && row[sourceField], 500);
    const chinese = clean(row && row.chinese, 500);
    if (!allowed.has(source) || seen.has(source) || !chinese || !/[\u3400-\u9fff]/.test(chinese)) {
      throw Object.assign(new Error('官方AI返回的映射与本批原文不一致，本次未写入任何映射。'), { code: 'ai_mapping_response_mismatch' });
    }
    seen.add(source);
    checked.push({ ...row, [sourceField]: source, chinese });
  }
  if (checked.length !== expected.length || expected.some(value => !seen.has(value))) {
    throw Object.assign(new Error('官方AI没有完整返回本批全部映射，本次未写入任何映射。'), { code: 'ai_mapping_response_incomplete' });
  }
  return checked;
}

function validateTerm(rawName, chinese) {
  const source = clean(rawName, 100);
  const translated = clean(chinese, 50);
  if (!source) throw Object.assign(new Error('待映射术语缺少原文，请先提供需要翻译的原始术语。'), { code: 'term_source_invalid' });
  // 源名称必须包含俄文或英文字母
  if (!/[\u0400-\u04ffA-Za-z]/.test(source)) throw Object.assign(new Error('待映射术语的原文必须是俄文或英文，中文条目不需要再翻译。'), { code: 'term_source_must_be_russian_or_english' });
  if (!translated || !/[\u3400-\u9fff]/.test(translated)) throw Object.assign(new Error('术语的中文译文不合格，请填写准确的中文译名。'), { code: 'term_translation_invalid' });
  return { source, translated };
}

async function persistTermTranslationUnlocked(file, rawName, chinese) {
  const checked = validateTerm(rawName, chinese);
  const source = await fs.promises.readFile(file, 'utf8');
  const parsed = parseTermsArray(source);
  
  // 已有原文映射绝不覆盖：只要任一源语言别名已存在，就保留公共映射表里的旧中文。
  const normalizeTerm = value => String(value == null ? '' : value).normalize('NFKC').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  const sourceKey = normalizeTerm(checked.source);
  const existing = parsed.entries.find(row => row.slice(1).some(alias => normalizeTerm(alias) === sourceKey));
  if (existing) {
    return { changed: false, source: checked.source, chinese: existing[0], preservedExisting: true };
  }
  
  // 在数组末尾追加新条目: ['中文翻译','俄文原值']
  const newEntry = `    ['${checked.translated}','${checked.source}']`;
  const lines = source.split('\n');
  const termsEndLineIndex = lines.findIndex((line, idx) => {
    const pos = source.split('\n').slice(0, idx).join('\n').length + line.length;
    return pos >= parsed.endIndex && line.trim() === '];';
  });
  
  if (termsEndLineIndex < 0) throw Object.assign(new Error('无法定位术语数组的结束位置，不能安全写回映射文件，请联系系统管理员检查该文件。'), { code: 'terms_array_end_not_found' });
  
  // 在];之前插入新条目
  lines.splice(termsEndLineIndex, 0, newEntry + ',');
  const next = lines.join('\n');
  
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  await fs.promises.writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.promises.rename(temporary, file);
  return { changed: true, source: checked.source, chinese: checked.translated };
}
async function persistTermTranslation(file, rawName, chinese) {
  return withMappingFileLock(file, () => persistTermTranslationUnlocked(file, rawName, chinese));
}

module.exports = { 
  persistTranslation, 
  persistFeeTranslation, 
  persistReturnStatusTranslation,
  persistCategoryTranslation,
  persistTermTranslation,
  validate, 
  validateFee, 
  validateReturnStatus,
  validateCategory,
  validateTerm,
  parseMap, 
  parseFeeMap, 
  parseReturnStatusMap,
  parseCategoryMap,
  parseTermsArray,
  getTranslationAiConfig,
  loadMappingCredentialKey,
  validateAiTranslationBatch,
  defaultFile: path.join(__dirname, '..', 'assets', 'order-mappings.js') 
};
