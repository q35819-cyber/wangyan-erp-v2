(function () {
  'use strict';

  // This editor keeps one tooltip outside the form and its scrolling variant table.
  var fields = {
    shop: ['上架店铺', '选择本商品所属的店铺。请先确认店铺，再填写该店铺下的商品信息。'],
    category: ['产品类目', '新增时在下拉框内输入部分名称或编号模糊筛选，再选择完整三级类目。编辑已有商品时类目锁定，不能修改。第三层对应商品类型，无需在产品属性中重复填写。当前目录未提供 rFBS 专属可售标记，具体可售范围待官方文档确认。'],
    title: ['标题', '填写准确的商品名称，可包含品牌、型号、用途和关键规格；不要填写与商品无关的信息。本页最多可输入 500 个字符。'],
    brand: ['品牌', '填写商品实际品牌名称；没有品牌时填写“无品牌”，不要借用其他品牌。'],
    weight: ['包装重量', '填写商品连同包装的实际总重量，单位为克（g），数值必须大于 0。例如 0.5 千克应填写 500。'],
    length: ['包装长度', '填写包装后的实际长度，单位为毫米（mm），数值必须大于 0。例如 20 厘米应填写 200。'],
    width: ['包装宽度', '填写包装后的实际宽度，单位为毫米（mm），数值必须大于 0。例如 10 厘米应填写 100。'],
    height: ['包装高度', '填写包装后的实际高度，单位为毫米（mm），数值必须大于 0。例如 5 厘米应填写 50。'],
    barcode: ['条形码', '填写商品或包装上实际标注的条形码，保留开头的 0。不要把货号或 SKU 当作条形码；是否必填及格式要求以当前类目规则为准。'],
    hashtags: ['主题标签', '填写与商品风格、趋势或主题相关的标签，例如 #简约 #户外；多个标签用空格分隔，不要填写品牌、参数或商品名称。具体格式以当前类目说明为准；类目属性载入后可填写。'],
    description: ['简介', '填写商品用途、材质、规格、包装清单和使用注意事项等介绍，内容应与实物一致。这里填写普通描述文字。'],
    richContent: ['富内容', '用于结构化图文描述。可通过右侧富内容编辑器配置图片、文字和展示样式；不确定格式时优先使用编辑器，不建议直接手工修改原始数据。'],
    sourceUrl: ['货源地址', '填写对应商品的完整 HTTPS 货源详情链接，便于核对供货商品。不要填写店铺首页、账号密码或带登录凭证的链接。'],
    sourceNote: ['货源备注', '填写供货商品规格、颜色、包装、采购注意事项等内部备注。不要填写密码、API Key 或其他敏感凭证。']
  };
  var variantFields = {
    name: ['SKU 名称', '填写该变体的名称，可用颜色、尺寸或型号区分不同规格。这里填写名称，不是平台分配的 SKU 编号。'],
    offerId: ['货号', '填写卖家用于识别该变体的商品货号，保留原有字母、数字和符号。新增商品可点击“一键随机货号”，按 wy-年月日-4位大写随机字母-0001 生成；同一批变体共用随机字母，末尾编号依次递增。列宽按载入时最长货号另留约 6 个字符的空间确定；较长内容可自动换行，不会因此增加换行字符。编辑已有商品时先核对原货号，避免误改商品关联。'],
    purchase: ['采购价', '填写该变体的实际采购单价，只填金额数字，不带货币符号；按当前 ERP 采购成本口径填写，不要混入平台售价。'],
    domesticShipping: ['国内快递费', '填写该变体采购环节的国内快递费用，不是国际物流费。只填金额数字，最多两位小数；没有费用可填 0，暂未确定可留空。按与采购价相同的成本币种填写，各变体分别保存。'],
    sale: ['售价', '填写该变体的销售单价，只填金额数字，不带货币符号；币种应与所属店铺商品一致。'],
    old: ['划线价', '填写该变体用于对比展示的原价，只填金额数字，并与售价使用相同币种。具体价格限制以平台校验结果为准。'],
    packQuantity: ['每包数量，件', '填写每个销售包装中实际包含的商品件数。例如一包 3 件填写 3；不要填写仓库库存总量。'],
    itemLength: ['长度，厘米', '填写该变体商品本身的实际长度，单位为厘米。此处与上方以毫米填写的包装长度不同，请核对单位。'],
    color: ['商品颜色', '从类目颜色选项中选择该变体的标准颜色，例如“黑色”。'],
    colorName: ['颜色名称', '修改前面的商品颜色时，直接填入所选字典 ID 对应的俄文原值，不从中文反译；清空商品颜色也会清空此项。可手动补充俄文描述，下次修改商品颜色时会重新同步。此项独立保存为颜色名称属性，不替换标准颜色的字典编号。']
  };
  var tooltip = document.createElement('div');
  tooltip.id = 'productFieldTooltip';
  tooltip.className = 'field-help-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  var heading = document.createElement('strong');
  var content = document.createElement('div');
  tooltip.append(heading, content);
  document.body.appendChild(tooltip);
  var active = null, activeRect = null, hideTimer = null, sequence = 0;

  function describe(node, add) {
    if (!node) return;
    var ids = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== tooltip.id; });
    if (add) ids.push(tooltip.id);
    if (ids.length) node.setAttribute('aria-describedby', ids.join(' '));
    else node.removeAttribute('aria-describedby');
  }
  function cancelHide() { window.clearTimeout(hideTimer); }
  function hide() {
    cancelHide();
    if (active) { describe(active, false); describe(document.getElementById(active.dataset.helpInput), false); }
    active = null;
    activeRect = null;
    tooltip.hidden = true;
  }
  function scheduleHide() {
    cancelHide();
    hideTimer = window.setTimeout(function () {
      if (active && (active.matches(':hover') || active === document.activeElement || tooltip.matches(':hover'))) return;
      hide();
    }, 140);
  }
  function position() {
    if (!active || !active.isConnected) return hide();
    var rect = active.getBoundingClientRect(), gap = 8, margin = 12;
    activeRect = rect;
    var width = tooltip.offsetWidth, height = tooltip.offsetHeight;
    var left = Math.min(Math.max(margin, rect.right - width), Math.max(margin, window.innerWidth - width - margin));
    var top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) top = rect.top - height - gap;
    tooltip.style.left = left + 'px';
    tooltip.style.top = Math.max(margin, Math.min(top, window.innerHeight - height - margin)) + 'px';
  }
  function show(trigger) {
    if (active !== trigger) hide();
    cancelHide();
    active = trigger;
    heading.textContent = trigger.dataset.helpTitle;
    content.textContent = trigger.dataset.helpText;
    describe(trigger, true);
    describe(document.getElementById(trigger.dataset.helpInput), true);
    tooltip.hidden = false;
    position();
  }
  function configure(trigger, info, input) {
    trigger.className = 'field-help-trigger';
    trigger.type = 'button';
    trigger.textContent = 'i';
    trigger.dataset.helpTitle = info[0];
    trigger.dataset.helpText = info[1];
    trigger.setAttribute('aria-label', info[0] + '填写说明');
    if (input) {
      if (!input.id) input.id = 'product-help-field-' + (++sequence);
      trigger.dataset.helpInput = input.id;
      if (!input.getAttribute('aria-label')) input.setAttribute('aria-label', info[0]);
    }
    trigger.removeAttribute('title');
  }
  function enhance(input, info) {
    if (!input || input.type === 'hidden' || input.closest('.field-help-control')) return;
    var wrapper = document.createElement('span');
    wrapper.className = 'field-help-control';
    var control = input.parentElement.matches('.unit-row, .source-url-control') ? input.parentElement : input;
    if (control.classList.contains('unit-row')) wrapper.classList.add('field-help-compact');
    control.before(wrapper);
    wrapper.appendChild(control);
    var trigger = document.createElement('button');
    configure(trigger, info, input);
    wrapper.appendChild(trigger);
  }
  function enhanceAttributes(attributes) {
    hide();
    var hashtags = attributes.find(function (attribute) { return String(attribute.id) === '23171'; });
    var hashtagsHelp = document.querySelector('.field-help-trigger[data-help-input="hashtags"]');
    if (hashtagsHelp) configure(hashtagsHelp, ['主题标签', fields.hashtags[1] + (hashtags && hashtags.description ? '\n\n类目说明：\n' + String(hashtags.description) : '')], document.getElementById('hashtags'));
    var bindings = window.WYERP_PRODUCT_ATTRIBUTE_FIELDS.bindings(attributes);
    ['title','description','richContent','weight','barcode','length','width','height'].forEach(function (key) {
      var trigger = document.querySelector('.field-help-trigger[data-help-input="' + key + '"]');
      if (trigger) configure(trigger, fields[key], document.getElementById(key));
    });
    ['color','colorName','packQuantity','itemLength'].forEach(function (key) {
      var trigger = document.querySelector('[data-variant-field="' + key + '"] .field-help-trigger');
      if (trigger) configure(trigger, variantFields[key]);
    });
    bindings.forEach(function (binding, i) {
      if (!binding || binding.area === 'media') return;
      if (binding.area === 'dimensions') {
        ['length','width','height'].forEach(function (key) {
          var trigger = document.querySelector('.field-help-trigger[data-help-input="' + key + '"]');
          if (trigger) configure(trigger, [fields[key][0], fields[key][1] + '\n该类目的组合包装尺寸使用厘米，保存时会从本页毫米值自动换算。' + (attributes[i].description ? '\n\n类目说明：\n' + attributes[i].description : '')], document.getElementById(key));
        });
        return;
      }
      var info = (binding.area === 'field' ? fields : variantFields)[binding.key];
      var trigger = binding.area === 'field' ? document.querySelector('.field-help-trigger[data-help-input="' + binding.key + '"]') : document.querySelector('[data-variant-field="' + binding.key + '"] .field-help-trigger');
      if (!info || !trigger) return;
      var attribute = attributes[i];
      var guidance = info[1] + (attribute.required ? '\n此项为当前类目的必填属性。' : '');
      if (window.WYERP_PRODUCT_ATTRIBUTE_OPTIONS.kind(attribute)) guidance += '\n可直接输入部分文字模糊搜索，再从下拉选项中选择' + (window.WYERP_PRODUCT_ATTRIBUTE_OPTIONS.multiple(attribute) ? '，可逐项添加或移除多个值。' : '一个值。');
      else if (attribute.collection) guidance += '\n多个属性值用英文分号分隔；值本身含分号时用双引号包住。';
      if (attribute.description) guidance += '\n\n类目说明：\n' + attribute.description;
      configure(trigger, [info[0], guidance], binding.area === 'field' ? document.getElementById(binding.key) : null);
      if (binding.area === 'variant') document.querySelectorAll('#variantBody [data-field="' + binding.key + '"]').forEach(function (input) { input.setAttribute('aria-description', guidance); });
    });
    document.querySelectorAll('[data-attribute-index]').forEach(function (input) {
      var attribute = attributes[Number(input.dataset.attributeIndex)];
      if (!attribute) return;
      var binding = bindings[Number(input.dataset.attributeIndex)];
      var name = binding && binding.area === 'media' ? binding.label : String(attribute.name || '商品属性');
      var guidance = '填写该商品的“' + name + '”实际属性值。' + (attribute.required ? '此项为当前类目的必填属性。' : '此项为选填属性，不适用时可留空。');
      if (/^型号名称/.test(name)) guidance += '\n可点击说明图标后的“一键生成”，按年月日时分秒（YYMMDDHHMMSS）加 4 位随机数生成 16 位纯数字，例如 2609012051374056。';
      if (window.WYERP_PRODUCT_ATTRIBUTE_OPTIONS.kind(attribute)) guidance += '\n可在下拉框中输入关键词模糊搜索后选择' + (window.WYERP_PRODUCT_ATTRIBUTE_OPTIONS.multiple(attribute) ? '，逐项添加或移除多个值。' : '，不要自行编造字典值。');
      if (attribute.description && String(attribute.description).trim()) guidance += '\n\n类目说明：\n' + String(attribute.description).trim();
      else guidance += '如名称包含单位，请按该单位填写；具体取值要求以当前类目为准。';
      enhance(input, [name, guidance]);
    });
  }
  function enhanceVariants() {
    hide();
    document.querySelectorAll('.variant-head-title[data-variant-field]').forEach(function (title) {
      var info = variantFields[title.dataset.variantField];
      if (!info || title.querySelector('.field-help-trigger')) return;
      var trigger = document.createElement('button');
      configure(trigger, info);
      (title.querySelector('.variant-head-suffix') || title).appendChild(trigger);
    });
    document.querySelectorAll('#variantBody [data-field]').forEach(function (input) {
      var info = variantFields[input.dataset.field];
      if (!info) return;
      input.setAttribute('aria-label', info[0]);
      input.setAttribute('aria-description', info[1]);
    });
  }
  Object.keys(fields).forEach(function (id) { enhance(document.getElementById(id), fields[id]); });
  [
    ['.variant-sample-info', ['自动识别颜色/尺寸', '勾选后会读取SKU名称和采集货源保留的原始规格文字，只对当前类目中可区分多SKU的颜色/尺寸属性尝试自动匹配。仅唯一匹配时自动填写；不确定时保留原值并用红字提示人工确认。']]
  ].forEach(function (item) {
    var old = document.querySelector(item[0]);
    if (!old) return;
    var trigger = document.createElement('button');
    configure(trigger, item[1]);
    old.replaceWith(trigger);
  });
  function triggerFor(target) { return target && target.closest ? target.closest('.field-help-trigger') : null; }
  document.addEventListener('mouseover', function (event) { var trigger = triggerFor(event.target); if (trigger) show(trigger); });
  document.addEventListener('mouseout', function (event) { if (triggerFor(event.target)) scheduleHide(); });
  document.addEventListener('focusin', function (event) { var trigger = triggerFor(event.target); if (trigger) show(trigger); else scheduleHide(); });
  document.addEventListener('focusout', function (event) { if (triggerFor(event.target)) scheduleHide(); });
  tooltip.addEventListener('mouseenter', cancelHide);
  tooltip.addEventListener('mouseleave', scheduleHide);
  document.addEventListener('click', function (event) {
    var trigger = triggerFor(event.target);
    if (trigger) { event.preventDefault(); show(trigger); }
    else if (!tooltip.contains(event.target)) hide();
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hide(); });
  document.addEventListener('scroll', function (event) {
    if (!active || tooltip.contains(event.target)) return;
    var rect = active.getBoundingClientRect();
    // A queued scroll event may arrive after hover/focus at the final position.
    // Only close when the anchor has actually moved since the tooltip opened.
    if (!activeRect || rect.top !== activeRect.top || rect.left !== activeRect.left) hide();
  }, true);
  window.addEventListener('resize', hide);
  window.WYERP_PRODUCT_FIELD_HELP = { attributes: enhanceAttributes, variants: enhanceVariants };
})();
