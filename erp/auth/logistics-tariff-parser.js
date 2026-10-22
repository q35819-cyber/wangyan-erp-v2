'use strict';

const ExcelJS = require('exceljs');

const GROUPS = ['Extra Small', 'Budget', 'Small', 'Big', 'Premium Small', 'Premium Big', 'HK'];

function clean(value) {
  return String(value == null ? '' : value).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
}

function cellText(sheet, row, column) {
  const cell = sheet.getCell(row, column);
  const source = cell.isMerged && cell.master ? cell.master : cell;
  return clean(source.text || source.value && source.value.result || source.value);
}

function groupName(value) {
  const normalized = clean(value).replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('premium small')) return 'Premium Small';
  if (normalized.includes('premium big')) return 'Premium Big';
  if (normalized.includes('extra small')) return 'Extra Small';
  if (/\bbudget\b/.test(normalized)) return 'Budget';
  if (/\bsmall\b/.test(normalized)) return 'Small';
  if (/\bbig\b/.test(normalized)) return 'Big';
  if (/\bhk\b/.test(normalized) || normalized.includes('中国香港')) return 'HK';
  return '';
}

function rate(text) {
  const source = clean(text);
  const kg = source.match(/([0-9]+(?:\.[0-9]+)?)\s*元\s*\/\s*(?:千克|kg)/i);
  const gram = source.match(/([0-9]+(?:\.[0-9]+)?)\s*元\s*\/\s*克/i);
  const hundred = source.match(/([0-9]+(?:\.[0-9]+)?)\s*元\s*\/\s*100克/i);
  const fixed = source.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元)?\s*\/\s*(?:票|件)/i);
  const currencyParts = Array.from(source.matchAll(/[￥¥]\s*([0-9]+(?:\.[0-9]+)?)/g)).map(match => Number(match[1]));
  const perGramCurrency = source.match(/[￥¥]\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*(?:1\s*)?(?:g|克)/i);
  const fixedCurrency = /\+/.test(source) && currencyParts.length ? currencyParts[0] : null;
  return {
    perKg: kg ? Number(kg[1]) : gram ? Number(gram[1]) * 1000 : hundred ? Number(hundred[1]) * 10 : perGramCurrency ? Number(perGramCurrency[1]) * 1000 : null,
    fixed: fixed ? Number(fixed[1]) : fixedCurrency == null ? 0 : fixedCurrency,
    incrementKg: hundred ? 0.1 : 0.001,
    source
  };
}

function gramWeight(minValue, maxValue) {
  const min = Number(clean(minValue).match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
  const max = Number(clean(maxValue).match(/[0-9]+(?:\.[0-9]+)?/)?.[0]);
  return { min: Number.isFinite(min) ? min / 1000 : null, max: Number.isFinite(max) ? max / 1000 : null };
}

function range(text, unitPattern) {
  const source = clean(text).replace(/，/g, ',');
  const pair = source.match(new RegExp('([0-9]+(?:\\.[0-9]+)?)\\s*[-–~至]\\s*([0-9]+(?:\\.[0-9]+)?)\\s*' + unitPattern, 'i'));
  if (pair) return { min: Number(pair[1]), max: Number(pair[2]) };
  const max = source.match(new RegExp('(?:≤|不超|以内|<=)\\s*([0-9]+(?:\\.[0-9]+)?)\\s*' + unitPattern, 'i'));
  if (max) return { min: 0, max: Number(max[1]) };
  const single = source.match(new RegExp('(?:^|[^0-9])([0-9]+(?:\\.[0-9]+)?)\\s*' + unitPattern, 'i'));
  return single ? { min: 0, max: Number(single[1]) } : { min: null, max: null };
}

function sizeLimits(text) {
  const source = clean(text);
  const sum = source.match(/三边(?:之)?和(?:不超|≤|<|不超过)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:CM|厘米)/i);
  const side = source.match(/(?:单边(?:最大尺寸|最长限制|最长边|最大)?|最长边)(?:不超|≤|<|不超过)?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:CM|厘米)/i);
  return { maxSideCm: side ? Number(side[1]) : null, maxSumCm: sum ? Number(sum[1]) : null, source };
}

function billing(group, logic) {
  const source = clean(logic);
  if (group === 'HK') return { mode: 'conditional_volume', divisor: 6000, condition: '三边和超过60cm时计抛' };
  if (!source) return { mode: 'actual', divisor: null, condition: '资费表未标注计抛，按实重计费' };
  if (/不计抛|实重计费|按实重/.test(source) || !['Big', 'Premium Big'].includes(group)) return { mode: 'actual', divisor: null, condition: '按实重计费' };
  const divisor = source.match(/÷\s*([0-9]+)/);
  return { mode: 'volumetric', divisor: divisor ? Number(divisor[1]) : 12000, condition: '实际重与体积重取较大值' };
}

function transportMode(transport, channel) {
  const source = clean(transport + ' ' + channel).toLowerCase();
  if (/economy|经济|陆运/.test(source)) return '陆运';
  if (/standard|标准|陆空(?:联运)?/.test(source)) return '陆空';
  if (/express|特快|空运/.test(source)) return '空运';
  return '';
}

function sourceDate(originalName, fallbackYear) {
  const name = clean(originalName);
  const epoch = name.match(/(?:^|[_-])(1[6-9]\d{8})(?:[_-]|\.|$)/);
  if (epoch) {
    const date = new Date(Number(epoch[1]) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  let match = name.match(/(20\d{2})[.\-年](\d{1,2})(?:[.\-月](\d{1,2}))?/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3] || 1)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  match = name.match(/\bV\s*(\d{1,2})[.\-](\d{1,2})\b/i);
  if (!match) match = name.match(/(?:资费表|tariffs?)[^0-9]{0,12}(\d{1,2})[.\-](\d{1,2})/i);
  if (!match) return null;
  const year = Number(fallbackYear) || new Date().getUTCFullYear();
  const date = new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function workbookSourceDate(sheets) {
  const dates = new Set();
  const label = /^(?:官方)?(?:资费表?|费率|价格)(?:源)?(?:更新|生效|发布日期|日期)(?:日期|时间)?$/;
  const parse = value => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const match = clean(value).match(/^(20\d{2})[-./年](\d{1,2})(?:[-./月](\d{1,2}))日?$/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10) : null;
  };
  for (const sheet of sheets) {
    for (let row = 1; row <= Math.min(sheet.rowCount, 10); row += 1) {
      for (let column = 1; column <= Math.min(sheet.columnCount, 12); column += 1) {
        const text = cellText(sheet, row, column).replace(/[：:]$/, '').trim();
        if (!label.test(text)) continue;
        const cell = sheet.getCell(row, column + 1);
        const day = parse(cell.value instanceof Date ? cell.value : cellText(sheet, row, column + 1));
        if (day) dates.add(day);
      }
    }
  }
  return dates.size === 1 ? new Date([...dates][0] + 'T00:00:00.000Z').toISOString() : null;
}

function versionLabel(originalName) {
  const name = clean(originalName);
  const explicit = (name.match(/(?:20\d{2}[.\-年]?\d{1,2}[.\-月]?\d{0,2}|V\s*\d+(?:\.\d+)*)/i) || [])[0];
  if (explicit) return explicit;
  const epochDate = sourceDate(name);
  if (epochDate && /(?:^|[_-])1[6-9]\d{8}(?:[_-]|\.|$)/.test(name)) return epochDate.slice(0, 10).replace(/-/g, '.');
  const short = name.match(/(?:资费表|tariffs?)[^0-9]{0,12}(\d{1,2}[.\-]\d{1,2})/i);
  return short ? 'V' + short[1].replace('-', '.') : '未标注版本';
}

function workbookOfficialDate(workbook) {
  const dates = new Set();
  const label = /(?:官方日期|(?:资费|运价|报价|版本)?(?:生效|执行|更新|发布)日期|生效时间|执行时间|effective\s*date|valid\s*from)/i;
  function dateValue(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const match = clean(value).match(/(?:^|\D)(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})(?:日)?(?=\D|$)/);
    if (!match) return null;
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
  }
  for (const sheet of workbook.worksheets) {
    for (let row = 1; row <= Math.min(sheet.rowCount, 20); row += 1) {
      for (let column = 1; column <= Math.min(sheet.columnCount, 20); column += 1) {
        let text;
        try { text = cellText(sheet, row, column); } catch (error) { continue; }
        if (!label.test(text)) continue;
        const values = [text, sheet.getCell(row, column + 1).value, sheet.getCell(row + 1, column).value];
        for (const value of values) {
          const date = dateValue(value);
          if (date) dates.add(date);
        }
      }
    }
  }
  return dates.size === 1 ? Array.from(dates)[0] + 'T00:00:00.000Z' : null;
}

function rule(provider, scheme, market, sheetName, group, channel, transport, eta, rateText, logicText, weightText, valueText, sizeText, row) {
  const parsedRate = rate(rateText);
  const weight = range(weightText, '(?:KG|千克|公斤)');
  const declaredValue = range(valueText, '(?:₽|RUB|卢布)?');
  return {
    id: provider.toLowerCase() + '-' + scheme.toLowerCase() + '-' + Buffer.from(market).toString('hex').slice(0, 16) + '-' + row,
    provider, scheme, market: group === 'HK' ? '中国香港' : market, sheetName, group, channel: clean(channel), transport: clean(transport), transportMode: transportMode(transport, channel), eta: clean(eta),
    rate: parsedRate, billing: billing(group, logicText), weightKg: weight,
    declaredValueRub: declaredValue, dimensions: sizeLimits(sizeText), sourceRow: row
  };
}

function parseCel(sheet, scheme, market) {
  const rules = [];
  let lastGroup = '', lastLogic = '', lastWeight = '', lastValue = '', lastSize = '';
  for (let row = 3; row <= Math.min(sheet.rowCount, 80); row += 1) {
    const currentGroup = groupName(cellText(sheet, row, 1));
    if (currentGroup) lastGroup = currentGroup;
    const channel = cellText(sheet, row, 2);
    if (!lastGroup || !channel || !/CEL/i.test(channel)) continue;
    lastLogic = cellText(sheet, row, 6) || lastLogic;
    lastWeight = cellText(sheet, row, 8) || lastWeight;
    lastValue = cellText(sheet, row, 9) || lastValue;
    lastSize = cellText(sheet, row, 10) || lastSize;
    const parsed = rule('CEL', scheme, market, sheet.name, lastGroup, channel, cellText(sheet, row, 3), cellText(sheet, row, 4), cellText(sheet, row, 5), lastLogic, lastWeight, lastValue, lastSize, row);
    if (parsed.rate.perKg != null) rules.push(parsed);
  }
  return rules;
}

function parseGuoo(sheet, scheme, market) {
  const rules = [];
  let lastGroup = '', lastWeight = '', lastValue = '', lastSize = '';
  for (let row = 10; row <= Math.min(sheet.rowCount, 80); row += 1) {
    const currentGroup = groupName(cellText(sheet, row, 2));
    if (currentGroup) lastGroup = currentGroup;
    const channel = cellText(sheet, row, 3);
    if (!lastGroup || !channel || !/GU[O0]{2}/i.test(channel)) continue;
    lastWeight = cellText(sheet, row, 7) || lastWeight;
    lastValue = cellText(sheet, row, 8) || lastValue;
    lastSize = cellText(sheet, row, scheme === 'FBP' ? 10 : 9) || lastSize;
    const logic = ['Big', 'Premium Big'].includes(lastGroup) ? '实际重与体积重取较大值，长×宽×高÷12000' : '按实重计费，不计抛';
    const parsed = rule('GUOO', scheme, market, sheet.name, lastGroup, channel, cellText(sheet, row, 4), '', cellText(sheet, row, 6), logic, lastWeight, lastValue, lastSize, row);
    if (parsed.rate.perKg != null) rules.push(parsed);
  }
  return rules;
}

function parseCelCis(sheet, scheme) {
  const rules = [];
  let lastWeight = '', lastValue = '', lastSize = '', lastEta = '';
  for (let row = 3; row <= Math.min(sheet.rowCount, 80); row += 1) {
    const channel = cellText(sheet, row, 1);
    const group = groupName(channel);
    const market = /Belarus/i.test(channel) ? '白俄罗斯' : /Kazakhstan/i.test(channel) ? '哈萨克斯坦' : '';
    if (!group || !market) continue;
    lastEta = cellText(sheet, row, 2) || lastEta;
    lastWeight = cellText(sheet, row, 4) || lastWeight;
    lastSize = cellText(sheet, row, 5) || lastSize;
    lastValue = cellText(sheet, row, 6) || lastValue;
    const logic = ['Big', 'Premium Big'].includes(group) ? '实际重与体积重取较大值，长×宽×高÷12000' : '按实重计费，不计抛';
    const parsed = rule('CEL', scheme, market, sheet.name, group, channel, transportMode('', channel), lastEta, cellText(sheet, row, 3), logic, lastWeight, lastValue, lastSize, row);
    if (parsed.rate.perKg != null) rules.push(parsed);
  }
  return rules;
}

function retsMarket(value) {
  const source = clean(value);
  if (/Belarus/i.test(source)) return '白俄罗斯';
  if (/Kazakhstan/i.test(source)) return '哈萨克斯坦';
  if (/Kyrgysztan|Kyrgyzstan|Kyrgyz/i.test(source)) return '吉尔吉斯斯坦';
  return '俄罗斯';
}

function parseRets(sheet, scheme) {
  const rules = [];
  let lastWeight = '', lastValue = '', lastSize = '';
  for (let row = 1; row <= Math.min(sheet.rowCount, 120); row += 1) {
    const category = cellText(sheet, row, 2);
    const channel = cellText(sheet, row, 3);
    const currentGroup = groupName(category) || groupName(channel);
    if (!currentGroup || !channel || /渠道名称/.test(channel)) continue;
    const market = retsMarket(category + ' ' + channel);
    lastWeight = cellText(sheet, row, 9) || lastWeight;
    lastValue = cellText(sheet, row, 10) || lastValue;
    lastSize = cellText(sheet, row, 11) || lastSize;
    const parsed = rule('RETS', scheme || 'rFBS', market, sheet.name, currentGroup, channel,
      channel, cellText(sheet, row, 6), cellText(sheet, row, 7), '', lastWeight, lastValue, lastSize, row);
    if (parsed.rate.perKg != null) rules.push(parsed);
  }
  return rules;
}

function parseOgl(sheet, scheme) {
  const rules = [];
  for (let row = 4; row <= Math.min(sheet.rowCount, 40); row += 1) {
    const group = groupName(cellText(sheet, row, 2));
    const channel = cellText(sheet, row, 3);
    if (!group || !/^OGL\b/i.test(channel)) continue;
    const parsed = rule('OGL', scheme || 'rFBS', '俄罗斯', sheet.name, group, channel,
      group === 'Extra Small' ? '陆空' : '陆运', cellText(sheet, row, 4), cellText(sheet, row, 5), '按实重计费', '', cellText(sheet, row, 11), cellText(sheet, row, 8), row);
    parsed.weightKg = gramWeight(cellText(sheet, row, 9), cellText(sheet, row, 10));
    if (parsed.rate.perKg != null) rules.push(parsed);
  }
  return rules;
}

function chinaPostMarket(sheetName) {
  if (/哈萨克斯坦/.test(sheetName)) return '哈萨克斯坦';
  if (/白俄罗斯/.test(sheetName)) return '白俄罗斯';
  return '俄罗斯';
}

function parseChinaPost(sheet, scheme) {
  const title = cellText(sheet, 1, 1) + ' ' + sheet.name;
  const channel = cellText(sheet, 3, 1) || cellText(sheet, 4, 1);
  const market = chinaPostMarket(title);
  const fixed = Number(cellText(sheet, 4, 3));
  const perKg = Number(cellText(sheet, 4, 4));
  const isRussianLight = /轻小件/.test(title);
  const rateText = isRussianLight ? cellText(sheet, 3, 3) : `${fixed}元/票+${perKg}元/kg`;
  const group = isRussianLight ? 'Extra Small' : 'Small';
  const parsed = rule('CHINA_POST', scheme || 'rFBS', market, sheet.name, group, channel,
    cellText(sheet, 3, 11) || cellText(sheet, 3, 8), cellText(sheet, 3, 12) || cellText(sheet, 3, 9), rateText,
    '按实重计费', '', '', cellText(sheet, 3, 8) || cellText(sheet, 3, 6), 3);
  parsed.weightKg = isRussianLight
    ? gramWeight(cellText(sheet, 3, 5), cellText(sheet, 3, 7))
    : gramWeight(cellText(sheet, 4, 5), cellText(sheet, 4, 6));
  return parsed.rate.perKg == null ? [] : [parsed];
}

function looksLikeTariffSheet(sheet) {
  let productHeader = false, channelHeader = false, rateHeader = false;
  for (let row = 1; row <= Math.min(sheet.rowCount, 15); row += 1) {
    for (let column = 1; column <= Math.min(sheet.columnCount, 15); column += 1) {
      const value = cellText(sheet, row, column);
      if (/产品类别/.test(value)) productHeader = true;
      if (/渠道名称/.test(value)) channelHeader = true;
      if (/^资费$/.test(value)) rateHeader = true;
    }
  }
  return productHeader && channelHeader && rateHeader;
}

function sheetDescriptor(sheetName) {
  const name = clean(sheetName);
  if (/俄罗斯轻小件|e邮宝.*(?:哈萨克斯坦|白俄罗斯)/.test(name)) return { scheme: 'rFBS', market: chinaPostMarket(name), parser: 'china-post', defaultedScheme: true };
  if (/YANDEX|WB/i.test(name)) return null;
  if (/^OZON CIS-FBP$/i.test(name)) return { scheme: 'FBP', market: '独联体', parser: 'cis' };
  if (/^OZON CIS 独联体国家$/i.test(name)) return { scheme: 'rFBS', market: '独联体', parser: 'cis' };
  if (/哈萨克斯坦/.test(name)) return { scheme: 'rFBS', market: '哈萨克斯坦', parser: 'standard' };
  if (/白俄/.test(name)) return { scheme: 'rFBS', market: '白俄罗斯', parser: 'standard' };
  if (/吉尔吉斯斯坦/.test(name)) return { scheme: 'rFBS', market: '吉尔吉斯斯坦', parser: 'standard' };
  if (/乌兹别克斯坦/.test(name)) return { scheme: 'rFBS', market: '乌兹别克斯坦', parser: 'standard' };
  if (/realFBS|OZON\s*[- ]?rFBS/i.test(name)) return { scheme: 'rFBS', market: '俄罗斯', parser: 'standard' };
  if (/(?:^|[^A-Z])FBP(?:[^A-Z]|$)/i.test(name)) return { scheme: 'FBP', market: '俄罗斯', parser: 'standard' };
  if (/(?:^|[^A-Z])FBO(?:[^A-Z]|$)/i.test(name)) return { scheme: 'FBO', market: '俄罗斯', parser: 'standard' };
  if (/(?:^|[^A-Z])FBS(?:[^A-Z]|$)/i.test(name)) return { scheme: 'FBS', market: '俄罗斯', parser: 'standard' };
  return null;
}

async function parseLogisticsWorkbook(buffer, originalName) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw Object.assign(new Error('不是有效的 XLSX 文件'), { publicCode: 'logistics_xlsx_invalid' });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length > 30) throw Object.assign(new Error('工作表数量超过限制'), { publicCode: 'logistics_xlsx_too_complex' });
  const name = clean(originalName);
  const provider = /GU[O0]{2}/i.test(name) ? 'GUOO' : /CEL/i.test(name) ? 'CEL' : /RETS|俄通收/i.test(name) ? 'RETS' : /OGL/i.test(name) ? 'OGL' : /邮政|China\s*Post/i.test(name) ? 'CHINA_POST' : '';
  const candidates = workbook.worksheets.map(sheet => ({
    sheet,
    descriptor: sheetDescriptor(sheet.name) || (/OGL/i.test(name + ' ' + cellText(sheet, 1, 2) + ' ' + cellText(sheet, 3, 2)) ? { scheme: 'rFBS', market: '俄罗斯', parser: 'ogl', defaultedScheme: true } : looksLikeTariffSheet(sheet) ? { scheme: 'rFBS', market: '俄罗斯', parser: 'auto', defaultedScheme: true } : null)
  })).filter(item => item.descriptor);
  if (!candidates.length) throw Object.assign(new Error('没有找到 FBO、FBS、FBP 或 rFBS 主资费工作表'), { publicCode: 'logistics_scheme_sheet_missing' });
  if (candidates.some(item => item.sheet.rowCount > 500 || item.sheet.columnCount > 80)) throw Object.assign(new Error('资费工作表超过解析限制'), { publicCode: 'logistics_xlsx_too_complex' });
  const sampleSheet = candidates[0].sheet;
  const sampleText = sampleSheet.name + ' ' + cellText(sampleSheet, 1, 1) + ' ' + cellText(sampleSheet, 4, 2) + ' ' + cellText(sampleSheet, 4, 3);
  const workbookText = workbook.worksheets.slice(0, 8).map(sheet => sheet.name + ' ' + cellText(sheet, 1, 1) + ' ' + cellText(sheet, 3, 1) + ' ' + cellText(sheet, 3, 3)).join(' ');
  const detectedProvider = provider || (/GU[O0]{2}/i.test(sampleText) ? 'GUOO' : /CEL/i.test(sampleText) ? 'CEL' : /RETS|俄通收/i.test(sampleText) ? 'RETS' : /\bOGL\b/i.test(workbookText) ? 'OGL' : /邮政|China\s*Post|ePacket/i.test(workbookText) ? 'CHINA_POST' : '');
  if (!detectedProvider) throw Object.assign(new Error('无法识别物流商，请在文件名或表头保留物流商名称'), { publicCode: 'logistics_provider_unknown' });
  const parsedSheets = candidates.map(item => {
    const descriptor = item.descriptor;
    const rules = descriptor.parser === 'ogl' ? parseOgl(item.sheet, descriptor.scheme) : descriptor.parser === 'china-post' ? parseChinaPost(item.sheet, descriptor.scheme) : detectedProvider === 'RETS' ? parseRets(item.sheet, descriptor.scheme) : descriptor.parser === 'cis' ? parseCelCis(item.sheet, descriptor.scheme) : detectedProvider === 'GUOO' ? parseGuoo(item.sheet, descriptor.scheme, descriptor.market) : parseCel(item.sheet, descriptor.scheme, descriptor.market);
    const markets = Array.from(new Set(rules.map(ruleItem => ruleItem.market).filter(market => market !== '中国香港')));
    const requiresSixGroups = detectedProvider !== 'CHINA_POST';
    if (!markets.length || (requiresSixGroups && markets.some(market => !GROUPS.slice(0, 6).every(group => rules.some(ruleItem => ruleItem.market === market && ruleItem.group === group))))) {
      throw Object.assign(new Error(item.sheet.name + ' 缺少完整的六类 OZON 渠道'), { publicCode: 'logistics_rules_incomplete' });
    }
    return { scheme: descriptor.scheme, market: descriptor.market, sheetName: item.sheet.name, defaultedScheme: !!descriptor.defaultedScheme, rules };
  });
  const rules = parsedSheets.flatMap(item => item.rules);
  const schemes = Array.from(new Set(parsedSheets.map(item => item.scheme)));
  const markets = Array.from(new Set(rules.map(item => item.market)));
  if (!rules.length) {
    throw Object.assign(new Error('没有解析到可用物流规则'), { publicCode: 'logistics_rules_incomplete' });
  }
  const version = versionLabel(name);
  return { provider: detectedProvider, version, sourceUpdatedAt: workbookSourceDate(workbook.worksheets), sheetName: parsedSheets.map(item => item.sheetName).join('、'), sheets: parsedSheets.map(item => ({ scheme: item.scheme, market: item.market, sheetName: item.sheetName, schemeDefaulted: item.defaultedScheme, rules: item.rules.length })), schemes, markets, rules };
}

function calculateRule(rule, actualKg, dimensionsCm) {
  const dimensions = Array.isArray(dimensionsCm) ? dimensionsCm.map(Number) : [];
  const validDimensions = dimensions.length === 3 && dimensions.every(value => Number.isFinite(value) && value > 0);
  const volumeKg = rule.billing.divisor && validDimensions ? dimensions[0] * dimensions[1] * dimensions[2] / rule.billing.divisor : null;
  let chargeableKg = Number(actualKg);
  if (rule.billing.mode === 'volumetric' && volumeKg != null) chargeableKg = Math.max(chargeableKg, volumeKg);
  if (rule.billing.mode === 'conditional_volume' && validDimensions && dimensions.reduce((sum, value) => sum + value, 0) > 60) chargeableKg = Math.max(chargeableKg, volumeKg);
  const increment = rule.rate.incrementKg || 0.001;
  chargeableKg = Math.ceil(chargeableKg / increment - 1e-9) * increment;
  const price = rule.rate.perKg == null ? null : chargeableKg * rule.rate.perKg + Number(rule.rate.fixed || 0);
  return { actualKg: Number(actualKg), volumeKg, chargeableKg, price: price == null ? null : Math.round(price * 100) / 100 };
}

module.exports = { parseLogisticsWorkbook, calculateRule, groupName, rate, billing, transportMode, sourceDate, versionLabel, sheetDescriptor, parseOgl, parseChinaPost };
