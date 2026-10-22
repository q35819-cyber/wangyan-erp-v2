(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_PRODUCT_COLOR_LABELS = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // One table for Chinese display and the linked Russian color name.
  // Never replace the standard color's platform value or dictionary ID.
  var colors = Object.create(null), russianColors = Object.create(null);
  var entries = [
    ['黑色','черный','black'], ['白色','белый','white'], ['红色','красный','red'],
    ['蓝色','синий','blue'], ['浅蓝色','голубой','light blue','lightblue'],
    ['绿色','зеленый','green'], ['黄色','желтый','yellow'], ['橙色','оранжевый','orange'],
    ['粉色','розовый','pink'], ['紫色','фиолетовый','purple','violet'],
    ['淡紫色','сиреневый','lilac'], ['灰色','серый','gray','grey'],
    ['棕色','коричневый','brown'], ['米色','бежевый','beige'],
    ['金色','золотой','золотистый','gold','golden'], ['银色','серебряный','серебристый','silver'],
    ['古铜色','бронзовый','bronze'], ['铜色','медный','copper'],
    ['透明','прозрачный','transparent','clear'], ['无色','бесцветный','colorless'],
    ['多色','разноцветный','многоцветный','мультиколор','multicolor','multicolour','multi color'],
    ['酒红色','бордовый','burgundy'], ['卡其色','хаки','khaki'],
    ['橄榄绿','оливковый','olive'], ['绿松石色','бирюзовый','turquoise'],
    ['青色','циан','cyan'], ['青绿色','сине-зеленый','teal'], ['海军蓝','темно-синий','navy','navy blue'],
    ['奶油色','кремовый','cream'], ['乳白色','молочный','milky white'],
    ['象牙白','слоновая кость','ivory'], ['沙色','песочный','sand'],
    ['珊瑚色','коралловый','coral'], ['桃色','персиковый','peach'],
    ['覆盆子红','малиновый','raspberry'], ['薰衣草色','лавандовый','lavender'],
    ['薄荷绿','мятный','mint'], ['翠绿色','изумрудный','emerald'],
    ['石墨灰','графитовый','graphite'], ['巧克力色','шоколадный','chocolate'],
    ['黑白色','черно-белый','black and white'], ['灰蓝色','серо-голубой'],
    ['海绿色','морская волна'], ['玫瑰金','розовое золото','rose gold'],
    ['深蓝色','темно-синий','dark blue'],
    ['香槟色','шампань','champagne'], ['咖啡色','кофейный','coffee'],
    ['藕粉色','пыльно-розовый','dusty pink'], ['雾蓝色','дымчато-синий','smoky blue'],
    ['银灰色','серебристо-серый','silver gray','silver grey'],
    ['杏色','абрикосовый','apricot'], ['柠檬黄','лимонный','lemon yellow'],
    ['天蓝色','небесно-голубой','sky blue'], ['宝蓝色','королевский синий','royal blue']
  ];
  // Ordered two-color names use explicit Russian combining stems, not guessed suffixes.
  var bases = [
    ['黑','черный','черно','black'], ['灰','серый','серо','gray'], ['白','белый','бело','white'],
    ['红','красный','красно','red'], ['蓝','синий','сине','blue'], ['绿','зеленый','зелено','green'],
    ['黄','желтый','желто','yellow'], ['棕','коричневый','коричнево','brown'],
    ['橙','оранжевый','оранжево','orange'], ['紫','фиолетовый','фиолетово','purple'],
    ['粉','розовый','розово','pink'], ['金','золотой','золотисто','gold'],
    ['银','серебристый','серебристо','silver'], ['米','бежевый','бежево','beige']
  ];
  bases.forEach(function (first) { bases.forEach(function (second) {
    if (first === second) return;
    var old = entries.find(function (row) { return row[0] === first[0] + second[0] + '色'; });
    if (old) { old.push(first[3] + '-' + second[3], first[3] + ' and ' + second[3]); return; }
    entries.push([first[0] + second[0] + '色', first[2] + '-' + second[1], first[3] + '-' + second[3], first[3] + ' and ' + second[3]]);
  }); });
  entries.forEach(function (row) {
    russianColors[normalize(row[0])] = row[1];
    row.slice(1).forEach(function (alias) { colors[normalize(alias)] = row[0]; russianColors[normalize(alias)] = row[1]; });
  });
  var finishes = [
    ['哑光','матовый','matte','matt','亚光','消光'],
    ['亮光','глянцевый','glossy','gloss','高光'],
    ['荧光','неоновый','neon','флуоресцентный'],
    ['珠光','перламутровый','pearlescent','pearl'],
    ['透明','прозрачный','transparent','clear']
  ];
  function finish(value, target, depth) {
    for (var i = 0; i < finishes.length; i++) {
      var row = finishes[i];
      for (var j = 0; j < row.length; j++) {
        var alias = normalize(row[j]), rest = '';
        if (value.indexOf(alias) === 0) rest = value.slice(alias.length).replace(/^[- ]+/, '');
        else if (value.endsWith(' ' + alias)) rest = value.slice(0, -alias.length).trim();
        if (!rest) continue;
        var ru = russian(rest, depth + 1);
        // These modifiers agree with singular masculine color adjectives only.
        if (!ru || !/^[\u0400-\u04ff-]+$/.test(ru)) continue;
        var zh = translate(rest, depth + 1);
        return target === 'ru' ? row[1] + ' ' + ru : (zh ? row[0] + zh : '');
      }
    }
    return null;
  }
  function normalize(value) { return String(value == null ? '' : value).normalize('NFKC').trim().toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-').replace(/\s+/g, ' '); }
  function translate(value, depth) {
    depth = depth || 0; if (depth > 4) return '';
    var raw = String(value == null ? '' : value).trim(), key = normalize(raw);
    if (!raw || /[\u3400-\u9fff]/.test(raw)) return raw;
    if (colors[key]) return colors[key];
    var finished = finish(key, 'zh', depth); if (finished) return finished;
    var shade = key.match(/^(светло|темно)[- ]?(.+)$/) || key.match(/^(light|dark)[- ](.+)$/);
    if (shade && colors[shade[2]]) return (/^(светло|light)$/.test(shade[1]) ? '浅' : '深') + colors[shade[2]];
    var parts = key.split(/\s*[,/+;]\s*/);
    if (parts.length > 1 && parts.every(function (part) { return colors[part]; })) return parts.map(function (part) { return colors[part]; }).join(' / ');
    return '';
  }
  function isColor(a) { return String(a.id || a.attribute_id || '') === '10096'; }
  function russian(value, depth) {
    depth = depth || 0; if (depth > 4) return null;
    var raw = String(value == null ? '' : value).trim(), key = normalize(raw);
    if (!raw) return '';
    // The dictionary's Russian text is already authoritative for this label.
    if (/^[\u0400-\u04ff\s,\/+;()–—-]+$/.test(raw)) return raw;
    if (russianColors[key]) return russianColors[key];
    if (russianColors[key + '色']) return russianColors[key + '色'];
    var finished = finish(key, 'ru', depth); if (finished) return finished;
    var shade = key.match(/^(light|dark)[- ](.+)$/) || key.match(/^(浅|深)(.+)$/);
    var base = shade && russian(shade[2], depth + 1);
    if (base && /^[\u0400-\u04ff-]+$/.test(base)) return (/^(light|浅)$/.test(shade[1]) ? 'светло-' : 'темно-') + base;
    var parts = key.split(/\s*[,/+;]\s*/);
    if (parts.length > 1) {
      var translated = parts.map(function (part) { return russian(part, depth + 1); });
      if (translated.every(function (part) { return part !== null; })) return translated.join(' / ');
    }
    return null;
  }
  function selectionName(items) {
    // Only use the exact value attached to the selected ID in the RU dictionary response.
    if (items.some(function (item) { return !item.id || item.sourceLanguage !== 'RU' || !item.value || /[\u3400-\u9fff]/.test(item.value); })) return null;
    return items.map(function (item) { return item.value; }).join('; ');
  }
  function display(a, item, options) {
    if (!isColor(a)) return item;
    var raw = String(item.value == null ? '' : item.value);
    var same = item.id && (options || []).find(function (option) { return String(option.id) === String(item.id) && /[\u3400-\u9fff]/.test(option.value || ''); });
    var label = same ? String(same.value) : translate(raw);
    return Object.assign({}, item, { label: label || ('未映射颜色（' + raw + '）'), info: (label || '颜色中文待确认') + '；原值：' + raw + (item.info ? '；' + item.info : '') });
  }
  return { translate: translate, russian: russian, selectionName: selectionName, isColor: isColor, display: display,
    catalog: function () { return entries.map(function (row) { return row.slice(); }); } };
});
