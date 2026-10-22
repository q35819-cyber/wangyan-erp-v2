(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./product-color-labels'));
  else root.WYERP_PRODUCT_OPTION_LABELS = factory(root.WYERP_PRODUCT_COLOR_LABELS);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (colors) {
  'use strict';
  // Display translations only: source values and platform dictionary identifiers never change.
  // AUTO-MAPPING-START: 服务端更新器只允许原子更新这个数组。
  var terms = [
    ['是','да','yes','true'], ['否','нет','no','false'],
    ['无品牌','нет бренда','no brand','без бренда','unbranded'],
    ['黑色','черный','black'], ['白色','белый','white'], ['红色','красный','red'],
    ['蓝色','синий','blue'], ['绿色','зеленый','green'], ['黄色','желтый','yellow'],
    ['粉色','розовый','pink'], ['灰色','серый','gray','grey'], ['棕色','коричневый','brown'],
    ['米色','бежевый','beige'], ['紫色','фиолетовый','purple'], ['橙色','оранжевый','orange'],
    ['多色','разноцветный','multicolor'], ['透明','прозрачный','transparent'],
    ['棉','хлопок','cotton'], ['亚麻','лен','linen'], ['羊毛','шерсть','wool'],
    ['羊绒','кашемир','cashmere'], ['真丝','шелк','silk'], ['聚酯纤维','полиэстер','polyester'],
    ['尼龙','нейлон','nylon'], ['聚酰胺','полиамид','polyamide'], ['氨纶','эластан','elastane','spandex'],
    ['粘胶纤维','вискоза','viscose'], ['腈纶','акрил','acrylic'], ['莫代尔','модал','modal'],
    ['莱赛尔纤维','лиоцелл','lyocell'], ['竹纤维','бамбуковое волокно','bamboo fiber'],
    ['皮革','кожа','leather'], ['真皮','натуральная кожа','genuine leather'],
    ['人造革','искусственная кожа','artificial leather','faux leather'], ['生态皮革','экокожа','eco leather'],
    ['绒面革','замша','suede'], ['织物','текстиль','textile','fabric'], ['牛仔布','деним','denim'],
    ['针织面料','трикотаж','knitted fabric'], ['天鹅绒','бархат','velvet'], ['缎面','атлас','satin'],
    ['抓绒','флис','fleece'], ['蕾丝','кружево','lace'], ['薄纱','тюль','tulle'],
    ['橡胶','резина','rubber'], ['硅胶','силикон','silicone'], ['塑料','пластик','plastic'],
    ['聚丙烯','полипропилен','polypropylene'], ['聚乙烯','полиэтилен','polyethylene'],
    ['聚氨酯','полиуретан','polyurethane'], ['聚氯乙烯','поливинилхлорид','polyvinyl chloride'],
    ['木材','дерево','wood'], ['竹','бамбук','bamboo'], ['纸','бумага','paper'], ['纸板','картон','cardboard'],
    ['玻璃','стекло','glass'], ['陶瓷','керамика','ceramic'], ['瓷','фарфор','porcelain'],
    ['金属','металл','metal'], ['钢','сталь','steel'], ['不锈钢','нержавеющая сталь','stainless steel'],
    ['铝','алюминий','aluminum','aluminium'], ['铜','медь','copper'], ['黄铜','латунь','brass'],
    ['铁','железо','iron'], ['钛','титан','titanium'], ['锌合金','цинковый сплав','zinc alloy'],
    ['银','серебро','silver'], ['金','золото','gold'], ['石材','камень','stone'],
    ['中国','китай','china'], ['俄罗斯','россия','russia'], ['土耳其','турция','turkey'],
    ['越南','вьетнам','vietnam'], ['印度','индия','india'], ['韩国','южная корея','south korea'],
    ['日本','япония','japan'], ['美国','сша','united states','usa'], ['德国','германия','germany'],
    ['法国','франция','france'], ['意大利','италия','italy'], ['英国','великобритания','united kingdom','uk'],
    ['西班牙','испания','spain'], ['波兰','польша','poland'], ['白俄罗斯','беларусь','belarus'],
    ['哈萨克斯坦','казахстан','kazakhstan'], ['印度尼西亚','индонезия','indonesia'],
    ['泰国','таиланд','thailand'], ['马来西亚','малайзия','malaysia'], ['巴基斯坦','пакистан','pakistan'],
    ['孟加拉国','бангладеш','bangladesh'], ['葡萄牙','португалия','portugal'], ['捷克','чехия','czech republic'],
    ['瑞士','швейцария','switzerland'], ['瑞典','швеция','sweden'], ['芬兰','финляндия','finland'],
    ['荷兰','нидерланды','netherlands'], ['比利时','бельгия','belgium'], ['加拿大','канада','canada'],
    ['澳大利亚','австралия','australia'], ['巴西','бразилия','brazil'], ['墨西哥','мексика','mexico'],
    ['男士','мужской','men','male'], ['女士','женский','women','female'],
    ['男女通用','унисекс','unisex'], ['男孩','мальчики','boys','для мальчиков'],
    ['女孩','девочки','girls','для девочек'], ['儿童','детский','children','kids'],
    ['成人','взрослый','adult'], ['新生儿','новорожденные','newborn'],
    ['春季','весна','spring'], ['夏季','лето','summer'], ['秋季','осень','autumn','fall'],
    ['冬季','зима','winter'], ['四季','всесезонный','all season','all-season'],
    ['春秋季','демисезон','demi-season'], ['春夏季','весна-лето','spring-summer'],
    ['秋冬季','осень-зима','autumn-winter'], ['休闲','повседневный','casual'],
    ['运动','спортивный','sport','sports'], ['经典','классический','classic'],
    ['商务','деловой','business'], ['复古','винтажный','vintage'], ['居家','домашний','home'],
    ['直筒','прямой','straight'], ['修身','приталенный','slim fit'], ['宽松','свободный','loose fit'],
    ['纯色','однотонный','solid color','plain'], ['条纹','полоска','striped','stripe'],
    ['格纹','клетка','checked','plaid'], ['波点','горошек','polka dot'], ['花卉','цветочный','floral'],
    ['几何图案','геометрический','geometric'], ['印花','принт','print'],
    ['圆形','круглый','round'], ['方形','квадратный','square'], ['长方形','прямоугольный','rectangular'],
    ['椭圆形','овальный','oval'], ['三角形','треугольный','triangular'],
    ['拉链','молния','zipper'], ['纽扣','пуговицы','buttons'], ['按扣','кнопки','snap buttons'],
    ['魔术贴','липучка','hook and loop'], ['系带','шнуровка','lacing'], ['无扣件','без застежки','no fastening'],
    ['可调节','регулируемый','adjustable'], ['可拆卸','съемный','removable'],
    ['防水','водонепроницаемый','waterproof'], ['防泼水','водоотталкивающий','water repellent'],
    ['透气','дышащий','breathable'], ['保暖','утепленный','insulated'],
    ['新品','новый','new'], ['二手','бывший в употреблении','used'],
    ['无图案','без рисунка','no pattern'], ['无香型','без запаха','unscented'],
    ['哑光','матовый','matte'], ['亮光','глянцевый','glossy'], ['光滑','гладкий','smooth'],
    ['左侧','левый','left'], ['右侧','правый','right'], ['通用','универсальный','universal'],
    ['Cooldry（速干面料）','cooldry'], ['Coolmax（吸湿排汗面料）','coolmax'],
    ['Croslite（闭孔树脂）','croslite'], ['EVA（乙烯-醋酸乙烯共聚物）','eva'],
    ['Hipora（防水透气膜）','hipora'], ['Polar Fleece（摇粒绒）','polar fleece'],
    ['Softshell（软壳面料）','softshell'], ['Taffeta（塔夫绸）','taffeta'],
    ["高档缎纹棉","Сатин люкс"],
    ["马尔莫林面料","Марморин"],
    ["面粉盐/莫科索尔","Мукосоль"],
    ["无尘纸","Airlaid"],
    ["含铁水镁石","Хантигирит"],
    ["超轻尼龙","Lightest nylon"],
    ["Dunicel无纺布","Dunicel"],
    ["Dunisilk仿丝","Dunisilk"],
    ["Dunisoft柔性无纺布","Dunisoft"],
    ["Dunilin亚麻质感无纺布","Dunilin"],
    ["硬聚氯乙烯 (PVC-U)","НПВХ (PVC-U)"],
    ["法尔福","Farfo"],
    ["高性能聚乙烯 (HPPE)","HPPE"],
    ["软点材质","SoftPoint"],
    ["氟橡胶 (Viton)","Viton"],
    ["帕卡木","Pakka wood"],
    ["纤维复合材料","FiberComp"],
    ["简易包装","Easy pack"],
    ["超级jewel盒","Super jewel case"],
    ["超级宝石盒","Super Jewel Box"],
    ["超薄盒","Slim Case"],
    ["零售盒","RETAIL BOX"],
    ["媒体盒","Media-Box"],
    ["标准Keep盒","Keep case"],
    ["珠宝盒包装","Jewel Case"],
    ["DVD盒装","DVD-BOX"],
    ["纸套包装","DigiSleeve"],
    ["Digipak 纸盒包装","DigiPak"],
    ["精装书型盒","DigiBook"],
    ["抽屉式纸盒","Box Slider"],
    ["套装盒","Box Set"],
    ["盒中袋","Bag-in-Box"],
    ["双支装注射器","Двойной шприц"],
  ];
  // AUTO-MAPPING-END
  var brands = [['耐克','найк','nike'], ['阿迪达斯','адидас','adidas'], ['彪马','пума','puma'],
    ['锐步','рибок','reebok'], ['新百伦','нью баланс','new balance'], ['斯凯奇','скетчерс','skechers'],
    ['小米','сяоми','xiaomi'], ['华为','хуавей','huawei'], ['三星','самсунг','samsung'],
    ['索尼','сони','sony'], ['联想','леново','lenovo'], ['华硕','асус','asus'], ['无品牌','нет бренда','no brand','без бренда','unbranded']];
  function normalize(value) { return String(value == null ? '' : value).normalize('NFKC').trim().toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-').replace(/\s+/g, ' '); }
  function chinese(value) { return /[\u3400-\u9fff]/.test(value || '') && !/[\u0400-\u04ff]/.test(value || ''); }
  function isBrand(a) { return ['85','31'].indexOf(String(a && (a.id || a.attribute_id))) >= 0; }
  function lookup(value, target, a) {
    var key = normalize(value), rows = isBrand(a) ? brands : terms;
    if (!key) return '';
    if (target === 'zh' && colors && colors.isColor(a || {})) return colors.translate(value);
    var row = rows.find(function (entry) { return entry.some(function (alias) { return normalize(alias) === key; }); });
    return row ? row[target === 'ru' ? 1 : target === 'en' ? 2 : 0] : '';
  }
  function needsTranslation(value) { return /[A-Za-z\u0400-\u04ff]/.test(value || '') && !/^(?:[2-9]?[XSML]{1,4}|OS|EU|US|UK|RU|CN|[\d\s.,%×x/+\-]+)$/i.test(String(value).trim()); }
  function display(a, item, options) {
    var match = item.id && (options || []).find(function (v) { return String(v.id) === String(item.id) && (chinese(v.labelZh) || chinese(v.value)); });
    var label = match && (match.labelZh || match.value) || item.labelZh || lookup(item.value, 'zh', a);
    var russian = match && match.sourceLanguage === 'RU' ? match.value : item.sourceLanguage === 'RU' ? item.value : lookup(item.value, 'ru', a);
    var visible = label || russian || (chinese(item.value) ? '俄文原值未加载' : item.value);
    return Object.assign({}, item, { label: visible, info: (item.info ? item.info + '；' : '') + (label ? '俄文原值：' : '中文尚未映射，显示俄文原值：') + (russian || '尚未加载') });
  }
  function createLocalizer(settings) {
    var pending = new Map();
    return { selectionLabels: function (a, items, context, force) {
      // Existing product selections are private/legacy input. Never auto-call AI for them.
      // They may use an existing public mapping; otherwise keep the source value until the user explicitly clicks Translate.
      return Promise.resolve(items.map(function (item) {
        var label = lookup(item.value, 'zh', a);
        return label ? Object.assign({}, item, { labelZh: label }) : item;
      }));
    }, localize: function (a, items, context, force) {
      var clean = items.filter(function (v) { return /^\d+$/.test(v.id); });
      var key = [context.scope, context.version, context.descriptionCategoryId, context.typeId, String(a.id), String(a.dictionaryId || a.dictionary_id || ''), 'zh-label-v1', clean.map(function (v) { return [v.id, v.value]; })];
      var token = JSON.stringify([key, clean.map(function (item) { return item.evidenceToken || ''; })]);
      if (!force && pending.has(token)) return pending.get(token);
      var task = (settings.cache && !force ? settings.cache.get('optionLabels', key) : Promise.resolve(null)).then(function (cached) {
        return Promise.all(clean.map(function (item) {
          var saved = cached && cached.items.find(function (v) { return v.id === String(item.id) && v.value === item.value; });
          var label = chinese(item.labelZh) ? item.labelZh : lookup(item.value, 'zh', a) || saved && saved.labelZh;
          if (label || !needsTranslation(item.value)) return Object.assign({}, item, { labelZh: label || '' });
          if (context.alive && !context.alive()) return item;
          if (!item.evidenceToken) return Object.assign({}, item, { translationError: '属性选项来源已失效或不匹配，请重新读取平台字典后再试；公共映射未更新。' });
          return settings.translator.translate(item.value, { target: 'zh', automatic: !force, publicMapping: true, evidenceToken: item.evidenceToken, attribute: a, force: force, alive: context.alive }).then(function (text) {
            return Object.assign({}, item, { labelZh: chinese(text) ? text : '', translationError: chinese(text) ? '' : '翻译结果没有中文，已保留原文' });
          }).catch(function (error) { return Object.assign({}, item, { translationError: error.message }); });
        }));
      }).then(function (localized) {
        var persist = localized.filter(function (item) { return chinese(item.labelZh); });
        var write = settings.cache && persist.length && (!context.alive || context.alive()) ? settings.cache.put('optionLabels', key, { items: persist }) : Promise.resolve();
        return write.then(function () { return localized; });
      });
      pending.set(token, task); if (pending.size > 120) pending.delete(pending.keys().next().value);
      return task.catch(function (error) { pending.delete(token); throw error; });
    } };
  }
  return { lookup: lookup, display: display, chinese: chinese, needsTranslation: needsTranslation, createLocalizer: createLocalizer, terms: terms };
});
