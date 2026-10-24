(function () {
  'use strict';

  const GRS_MODELS_URL = '/api/integrations/ai/grsai/models';
  const GRS_SAVE_URL = '/api/integrations/ai/grsai';
  const CONFIGURATIONS_URL = '/api/integrations/ai/configurations';
  const PROMPTS_URL = '/api/integrations/ai/prompts';
  const PROMPT_SELECTIONS_URL = '/api/integrations/ai/prompt-selections';
  const PRODUCT_RULES_URL = '/api/system/ai/product-rules';
  const PRICING_URL = '/api/system/ai/pricing';
  const GROUP_META = [['text', '文本'], ['image', '图片'], ['video', '视频']];
  const TEMPLATE_LABELS = {
    'deepseek-official': 'DeepSeek 官方',
    'alibaba-model-studio-image': '阿里百炼',
    'grsai-product': 'GRS AI', 'grsai-image': 'GRS AI',
    'agentrouter-product': 'AgentRouter', 'agentrouter-image': 'AgentRouter',
    'apiyi-product': 'API易', 'apiyi-image': 'API易',
    'truesota-product': 'TrueSota', 'truesota-image': 'TrueSota',
    'custom-product': '自定义（文本）', 'custom-image': '自定义（图片）'
  };

  function byId(id) { return document.getElementById(id); }
  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  let configState = { loaded: false, standalone: false, configurations: [], coverage: { text: false, image: false, video: false }, systemAdmin: false, owner: false, customizationAllowed: false, subaccounts: [] };
  function selectModule(name) {
    const target = document.querySelector('#aiModuleNav [data-module="' + name + '"]');
    // AI图片、数据分析规则只对系统管理员开放；其他人点链接或手动改地址也进不去。
    if (target && target.hasAttribute('data-admin-only') && !configState.systemAdmin) return;
    document.querySelectorAll('#aiModuleNav [data-module]').forEach(function (button) {
      const active = button.dataset.module === name;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-panel]').forEach(function (panel) {
      const active = panel.dataset.panel === name;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
  }
  function readableChineseMessage(value, fallback) {
    const detail = typeof value === 'string' ? value.trim() : '';
    const technicalDetail = /(?:\bHTTP\s*\d{3}\b|https?:\/\/|[A-Za-z]:\\|\\\\|\/(?:private|tmp|var|etc|Users|home)\/|\b(?:ETIMEDOUT|ECONNRESET|ENOENT|EACCES)\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b(?:Error|Exception):|\b(?:token|authorization|bearer|password|cookie|secret|api[_-]?key|csrf)\b|[\r\n])/i;
    return /[\u3400-\u9fff]/.test(detail) && !technicalDetail.test(detail) ? detail : fallback;
  }
  function message(error, fallback) {
    return readableChineseMessage(error && error.message, fallback);
  }
  let csrfToken = null;
  let storageIdentity = null;
  async function readIdentity() {
    if (csrfToken !== null) return;
    let response;
    try { response = await window.fetch('/api/auth/me', { credentials: 'same-origin' }); }
    catch (error) { throw Object.assign(new Error('无法连接 ERP 服务，请确认服务已启动后刷新页面'), { publicCode: 'identity_unreachable' }); }
    if (!response.ok) throw Object.assign(new Error('登录状态已失效，请退出后重新登录，再打开 AI 配置'), { publicCode: 'unauthorized' });
    const data = await response.json().catch(function () { return {}; });
    const tenantId = String(data.tenantId || '').trim();
    const userId = String(data.userId || '').trim();
    if (!tenantId || !userId) throw Object.assign(new Error('服务端未返回完整登录身份，无法读取或保存本机暂存'), { publicCode: 'identity_invalid' });
    storageIdentity = { tenantId: tenantId, userId: userId };
    csrfToken = String(data.csrfToken || '');
  }
  function scopedStashKey(baseKey) {
    if (!storageIdentity) return null;
    return baseKey + ':' + encodeURIComponent(storageIdentity.tenantId) + ':' + encodeURIComponent(storageIdentity.userId);
  }
  async function api(url, options) {
    const method = options && options.method ? String(options.method).toUpperCase() : 'GET';
    await readIdentity();
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options && options.headers ? options.headers : {});
    if (method !== 'GET' && method !== 'HEAD') {
      if (!csrfToken) throw Object.assign(new Error('缺少 CSRF 令牌，请退出后重新登录'), { publicCode: 'csrf_unavailable' });
      headers['X-CSRF-Token'] = csrfToken;
    }
    let response;
    try {
      response = await window.fetch(url, Object.assign({ credentials: 'same-origin' }, options, { method: method, headers: headers }));
    } catch (error) {
      throw Object.assign(new Error('请求没有送达 ERP 服务，请稍后重试'), { publicCode: 'request_failed' });
    }
    const body = await response.json().catch(function () { return {}; });
    if (!response.ok) throw Object.assign(new Error(readableChineseMessage(body.message, 'AI服务配置请求未完成，请稍后重试。')), { publicCode: body.error, body: body, httpStatus: response.status });
    return body;
  }
  function setBusy(button, isBusy, label) {
    if (!button) return;
    if (isBusy) {
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (label) button.textContent = label;
      return;
    }
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
  function flashIn(boxId, text, bad) {
    const box = byId(boxId);
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
    box.classList.toggle('is-error', Boolean(bad));
    box.classList.toggle('is-ok-line', !bad);
    if (box._timer) window.clearTimeout(box._timer);
    if (text) box._timer = window.setTimeout(function () { box.hidden = true; box.textContent = ''; }, 6000);
  }

  // ───────────────────────── AI服务配置：列表 + 新增/编辑弹窗 ─────────────────────────

  async function loadConfigurations() {
    const data = await api(CONFIGURATIONS_URL);
    configState.configurations = data.configurations || [];
    configState.coverage = data.coverage || { text: false, image: false, video: false };
    configState.systemAdmin = data.systemAdmin === true;
    configState.owner = data.owner === true;
    configState.customizationAllowed = data.customizationAllowed === true;
    configState.subaccounts = Array.isArray(data.subaccounts) ? data.subaccounts : [];
    configState.loaded = true;
    configState.standalone = data.standalone === true;
    if (configState.standalone) {
      const serviceHelp = document.querySelector('[data-panel="services"] .ai-panel-head p');
      if (serviceHelp) serviceHelp.textContent = '按需添加多个AI服务商，自定义API地址、模型及密钥；分别指定文本和图片的默认模型。';
      const generateButton = byId('aiGenerateAll');
      if (generateButton) generateButton.textContent = '全部生成（供应商可能收费）';
    }
    applyAdminTabs();
    applyOwnerAccess();
    applyCustomizationAccess();
    renderServices();
    renderSubaccounts();
  }
  function applyAdminTabs() {
    document.querySelectorAll('#aiModuleNav [data-admin-only]').forEach(function (tab) {
      tab.hidden = !configState.systemAdmin;
    });
  }
  function applyOwnerAccess() {
    const owner = configState.owner;
    ['services', 'prompts', 'access'].forEach(function (name) {
      const tab = document.querySelector('#aiModuleNav [data-module="' + name + '"]');
      const panel = document.querySelector('[data-panel="' + name + '"]');
      if (tab) tab.hidden = !owner;
      if (!owner && panel) panel.hidden = true;
    });
    if (!owner) { selectModule('denied'); return; }
    const active = document.querySelector('#aiModuleNav [data-module].is-active:not([hidden])');
    selectModule(active ? active.dataset.module : 'services');
  }
  function applyCustomizationAccess() {
    const allowed = configState.customizationAllowed || configState.systemAdmin;
    const add = byId('aiConfigAdd');
    if (add) { add.disabled = !allowed; add.title = allowed ? '' : '免费用户可以使用官方AI服务和官方模板。\n配置自己的AI服务需要付费会员。'; }
    const quick = byId('aiQuickImport');
    if (quick) { quick.hidden = !configState.standalone; quick.disabled = !allowed || !configState.owner; }
    const adapter = byId('aiVendorNew');
    if (adapter) { adapter.hidden = !configState.standalone; adapter.disabled = !allowed || !configState.owner; }
    ['cfgSaveBtn','cfgTestBtn','cfgFunctionalTestBtn'].forEach(function (id) { const button = byId(id); if (button) button.disabled = !allowed; });
    const status = byId('aiConfigListError');
    if (status && configState.owner && !allowed) {
      status.hidden = false;
      status.classList.remove('is-error');
      status.classList.add('is-ok-line');
      status.textContent = '当前方案可正常使用官方AI服务和官方模板；配置自己的AI服务需要升级付费会员。';
    }
  }
  function renderSubaccounts() {
    const wrap = byId('aiSubaccountList');
    const state = byId('aiSubaccountStatus');
    if (!wrap || !configState.owner) return;
    wrap.replaceChildren();
    if (!configState.subaccounts.length) {
      wrap.append(emptyBlock('暂无启用中的子账号。新子账号默认允许使用 AI。'));
      if (state) state.textContent = '暂无子账号';
      return;
    }
    configState.subaccounts.forEach(function (member) {
      const card = el('article');
      const head = el('div', 'ai-member-head');
      const avatar = el('div', 'ai-avatar');
      avatar.textContent = '子';
      const profile = el('div');
      const name = el('h3');
      const identity = window.WYERP_IDENTITY_DISPLAY.displayIdentity(member);
      name.textContent = identity.masked || '子账号';
      name.title = identity.raw || '';
      const note = el('p');
      note.textContent = member.aiAllowed === false ? '子账号 · 已关闭 AI' : '子账号 · 默认允许 AI';
      profile.append(name, note);
      const control = el('label', 'ai-switch');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = member.aiAllowed !== false;
      const slider = el('span');
      const label = el('b');
      label.textContent = '允许使用AI';
      input.addEventListener('change', function () { saveSubaccount(member, input); });
      control.append(input, slider, label);
      head.append(avatar, profile, control);
      const help = el('p', 'ai-help');
      help.textContent = '关闭后，新 AI 请求会由服务端拒绝；重新开启不绕过配置、模型或其它服务端门禁。';
      card.append(head, help);
      wrap.append(card);
    });
    if (state) state.textContent = '共 ' + configState.subaccounts.length + ' 个子账号';
  }
  async function saveSubaccount(member, input) {
    const allowed = input.checked;
    input.disabled = true;
    try {
      await api('/api/integrations/ai/subaccounts/' + encodeURIComponent(member.userId), { method: 'PUT', body: JSON.stringify({ allowed: allowed }) });
      await loadConfigurations();
      flashIn('aiSubaccountError', allowed ? '已允许该子账号使用 AI' : '已关闭该子账号的 AI 使用权限');
    } catch (error) {
      input.checked = !allowed;
      flashIn('aiSubaccountError', message(error, '子账号 AI 权限保存失败'), true);
    } finally {
      input.disabled = false;
    }
  }
  function renderServices() {
    renderCoverage();
    renderConfigList();
  }
  function renderCoverage() {
    const box = byId('aiCoverage');
    if (!box) return;
    box.replaceChildren();
    GROUP_META.forEach(function (pair) {
      const group = pair[0], label = pair[1];
      const on = Boolean(configState.coverage[group]);
      const chip = el('span', 'ai-coverage-chip ' + (on ? 'is-on' : 'is-off'));
      chip.textContent = (on ? '✓ ' : '') + label + (on ? '已接通' : '未接通');
      box.append(chip);
    });
  }
  function renderConfigList() {
    const wrap = byId('aiConfigList');
    if (!wrap) return;
    wrap.replaceChildren();
    const rows = configState.configurations;
    if (!rows.length) {
      wrap.append(emptyBlock(configState.customizationAllowed || configState.systemAdmin
        ? '还没有 AI 配置，点右上角“新增AI配置”，把密钥信息填完整。'
        : '当前使用系统官方AI服务；免费用户无需配置密钥，升级会员后可配置自己的AI服务。'));
      return;
    }
    const grsRows = rows.filter(function (row) { return String(row.template || '').indexOf('grsai-') === 0; });
    const others = rows.filter(function (row) { return String(row.template || '').indexOf('grsai-') !== 0; });
    const table = tableWithHead(['配置名称', '供应商', '支持能力', '启用状态', '模型', '操作']);
    const tbody = table.querySelector('tbody');
    if (grsRows.length) tbody.append(buildGrsRow(grsRows));
    others.forEach(function (row) { tbody.append(buildGenericRow(row)); });
    wrap.append(table);
  }
  function tableWithHead(headers) {
    const table = el('table', 'ai-table');
    const thead = el('thead');
    const headRow = el('tr');
    headers.forEach(function (text) {
      const th = el('th');
      th.textContent = text;
      headRow.append(th);
    });
    thead.append(headRow);
    table.append(thead, el('tbody'));
    return table;
  }
  function tableCell(textOrNode, className) {
    const td = el('td', className || '');
    if (typeof textOrNode === 'string') td.textContent = textOrNode;
    else if (Array.isArray(textOrNode)) textOrNode.forEach(function (node) { td.append(node); });
    else if (textOrNode) td.append(textOrNode);
    return td;
  }
  function rowActions(buttons) {
    const wrap = el('div', 'ai-cell-actions');
    buttons.forEach(function (button) { wrap.append(button); });
    return wrap;
  }
  function actionButton(text, className, onClick) {
    const button = el('button', 'ai-button' + (className ? ' ' + className : ''));
    button.type = 'button';
    button.textContent = text;
    button.addEventListener('click', function (event) { onClick(button, event); });
    return button;
  }
  function groupBadges(groups) {
    const wrap = el('div', 'ai-group-badges');
    GROUP_META.forEach(function (pair) {
      if (groups.indexOf(pair[0]) !== -1) {
        const badge = el('span', 'ai-group-badge');
        badge.textContent = pair[1];
        wrap.append(badge);
      }
    });
    return wrap;
  }
  function miniSwitch(label, on, disabled, onChange) {
    const wrap = el('label', 'ai-switch-row' + (disabled ? ' is-disabled' : ''));
    const sw = el('span', 'ai-mini-switch' + (on ? ' is-on' : ''));
    const text = el('span');
    text.textContent = label + (on ? '·启用中' : '·已停用');
    wrap.append(sw, text);
    wrap.addEventListener('click', function (event) {
      event.preventDefault();
      if (disabled) return;
      onChange(!on);
    });
    return wrap;
  }
  function buildGrsRow(grsRows) {
    const productRow = grsRows.find(function (row) { return row.template === 'grsai-product'; }) || null;
    const imageRow = grsRows.find(function (row) { return row.template === 'grsai-image'; }) || null;
    const groups = [];
    if (productRow) groups.push('text');
    if (imageRow) groups.push('image');
    if (imageRow && imageRow.supportsVideo) groups.push('video');
    const sharedNames = grsRows.map(function (r) { return r.name; }).filter(function (value, index, arr) { return arr.indexOf(value) === index; });

    const switchBox = el('div', 'ai-switch-stack');
    switchBox.append(miniSwitch('文本', Boolean(productRow && productRow.enabled), !(productRow && productRow.credentialsConfigured), function (next) { toggleRow(productRow, next); }));
    switchBox.append(miniSwitch('图片', Boolean(imageRow && imageRow.enabled), !(imageRow && imageRow.credentialsConfigured), function (next) { toggleRow(imageRow, next); }));
    const video = el('span', 'ai-video-note');
    video.textContent = '视频·仅登记' + (imageRow && imageRow.enabled && imageRow.supportsVideo ? '（已登记）' : '（未登记）');
    switchBox.append(video);

    const modelBox = el('div', 'ai-model-stack');
    const textModel = productRow ? String((productRow.model && productRow.model.name) || '未选择') : '未配置';
    const transModel = imageRow ? String((imageRow.model && imageRow.model['image-translation']) || (imageRow.model && imageRow.model.name) || '未选择') : '未配置';
    const redrawModel = imageRow ? String((imageRow.model && imageRow.model['image-redraw']) || (imageRow.model && imageRow.model.name) || '未选择') : '未配置';
    [['文本', textModel], ['图片翻译', transModel], ['图片重绘', redrawModel]].forEach(function (pair) {
      const line = el('div');
      line.textContent = pair[0] + '：' + pair[1];
      modelBox.append(line);
    });

    const tr = el('tr');
    tr.append(tableCell(sharedNames.length === 1 ? sharedNames[0] : 'GRS AI 配置'));
    tr.append(tableCell('GRS AI（国内节点）'));
    tr.append(tableCell(groupBadges(groups)));
    tr.append(tableCell(switchBox));
    tr.append(tableCell(modelBox));
    const actions = rowActions([
      actionButton('编辑', '', function () { openConfigDialog(true); }),
      actionButton('连接测试', '', function (button) { runCardConnectionTests(grsRows, button); }),
      actionButton('功能测试(付费)', '', function (button) { functionalTest(grsRows, button); }),
      actionButton('删除', 'is-danger', deleteGrs)
    ]);
    tr.append(tableCell(actions));
    return tr;
  }
  function buildGenericRow(row) {
    const modelName = String((row.model && (row.model.name || row.model['image-redraw'])) || '—');
    const switchBox = el('div', 'ai-switch-stack');
    switchBox.append(miniSwitch('该配置', Boolean(row.enabled), !row.credentialsConfigured, function (next) { toggleRow(row, next); }));
    const actions = rowActions([
      ...(configState.standalone ? [actionButton('编辑', '', function () { if(row.protocol==='custom-structured')openVendorDialog(row);else openLocalAiDialog(row); })] : []),
      ...(row.protocol==='custom-structured' ? [] : [actionButton('连接测试', '', function (button) { runCardConnectionTests([row], button); })]),
      actionButton('功能测试(付费)', '', function (button) { functionalTest([row], button); }),
      actionButton('删除', 'is-danger', function () { deleteRow(row); })
    ]);
    const tr = el('tr');
    tr.append(tableCell(row.name));
    tr.append(tableCell(TEMPLATE_LABELS[row.template] || row.template));
    tr.append(tableCell(groupBadges(row.groups || [])));
    tr.append(tableCell(switchBox));
    tr.append(tableCell(modelName));
    tr.append(tableCell(actions));
    return tr;
  }
  async function toggleRow(row, enabled) {
    if (!row) { flashIn('aiConfigListError', '这一类能力还没有配置，点“新增AI配置”填写', true); return; }
    if (enabled && !row.credentialsConfigured) { flashIn('aiConfigListError', '该配置还没有保存密钥，不能启用', true); return; }
    try {
      await api(CONFIGURATIONS_URL + '/' + row.id + '/enable', { method: 'POST', body: JSON.stringify({ enabled: enabled }) });
      await loadConfigurations();
    } catch (error) {
      flashIn('aiConfigListError', message(error, '启用状态保存失败'), true);
    }
  }
  async function runConnectionTests(rows, button) {
    const targets = rows.filter(function (row) { return row.credentialsConfigured; });
    if (!targets.length) throw Object.assign(new Error('没有可测试的配置：请先保存密钥'), { publicCode: 'ai_configuration_missing_key' });
    setBusy(button, true, '正在测试连接…');
    const outcomes = [];
    try {
      for (const row of targets) {
        try {
          const outcome = await api(CONFIGURATIONS_URL + '/' + row.id + '/test', { method: 'POST', body: JSON.stringify({ kind: 'connection' }) });
          const verified = (outcome.models || []).join('、') || (row.model && (row.model.name || row.model['image-redraw'])) || '模型有效';
          outcomes.push({ name: row.name, ok: true, text: verified + (outcome.credits === null || outcome.credits === undefined ? '' : ' · 余额 ' + outcome.credits) });
        } catch (error) {
          outcomes.push({ name: row.name, ok: false, text: message(error, '连接失败') });
        }
      }
      return outcomes;
    } finally {
      setBusy(button, false);
    }
  }
  async function runCardConnectionTests(rows, button) {
    try {
      const outcomes = await runConnectionTests(rows, button);
      const failed = outcomes.filter(function (item) { return !item.ok; });
      flashIn('aiConfigListError', outcomes.map(function (item) { return item.name + '：' + (item.ok ? '✓ ' : '✗ ') + item.text; }).join('；'), Boolean(failed.length));
    } catch (error) {
      flashIn('aiConfigListError', message(error, '连接测试失败'), true);
    }
  }
  async function deleteGrs() {
    if (!window.confirm('确认删除本租户的 GRS AI 配置？删除后需要重新填写密钥才能再用。')) return;
    try {
      await api(GRS_SAVE_URL, { method: 'DELETE' });
      await loadConfigurations();
      flashIn('aiConfigListError', 'GRS AI 配置已删除');
    } catch (error) {
      flashIn('aiConfigListError', message(error, '删除失败'), true);
    }
  }
  async function deleteRow(row) {
    if (!window.confirm('确认删除“' + row.name + '”？删除后需要重新配置。')) return;
    try {
      await api(CONFIGURATIONS_URL + '/' + row.id, { method: 'DELETE' });
      await loadConfigurations();
      flashIn('aiConfigListError', '配置已删除');
    } catch (error) {
      flashIn('aiConfigListError', message(error, '删除失败'), true);
    }
  }

  // ── 新增/编辑 AI 配置弹窗 ──

  // Local-only provider profiles: model IDs and API addresses are user-supplied,
  // while server-side validation/encrypted storage remain authoritative.
  const LOCAL_PROVIDER_URLS = Object.freeze({
    custom: '', openai: 'https://api.openai.com/v1',
    deepseek: 'https://api.deepseek.com',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    moonshot: 'https://api.moonshot.cn/v1'
  });
  const LOCAL_AI_CAPABILITIES = Object.freeze({
    product: ['product-translation', 'title-optimization', 'description-optimization', 'selling-point-generation', 'attribute-text-optimization'],
    image: ['image-translation', 'image-redraw', 'image-repair']
  });
  let localAiEditingId = null;
  function openLocalAiDialog(row) {
    if (!configState.standalone || !configState.owner) return;
    localAiEditingId = row ? row.id : null;
    byId('aiLocalDialogTitle').textContent = row ? '编辑 AI 平台' : '新增 AI 平台';
    byId('localAiName').value = row ? row.name : '';
    byId('localAiType').value = row ? row.section : 'product';
    byId('localAiType').disabled = Boolean(row);
    byId('localAiUrl').value = row ? row.baseUrl : '';
    byId('localAiModel').value = row ? String(row.model && row.model.name || '') : '';
    byId('localAiKey').value = '';
    byId('localAiKey').placeholder = row && row.credentialsConfigured ? '留空表示保留现有密钥' : '填写平台提供的 API Key';
    byId('localAiEnabled').checked = row ? Boolean(row.enabled) : true;
    byId('localAiDefault').checked = !row;
    byId('localAiPlatform').value = 'custom';
    byId('localAiError').hidden = true;
    showModal('aiLocalConfigDialog');
  }
  async function saveLocalAiDialog() {
    if (!configState.standalone || !configState.owner) return;
    const button = byId('localAiSave');
    const section = byId('localAiType').value;
    const name = byId('localAiName').value.trim();
    const baseUrl = byId('localAiUrl').value.trim();
    const model = byId('localAiModel').value.trim();
    const apiKey = byId('localAiKey').value.trim();
    const enabled = byId('localAiEnabled').checked;
    const assigned = byId('localAiDefault').checked;
    const existing = configState.configurations.find(function (r) { return r.id === localAiEditingId; });
    if (!name || !baseUrl || !model || (!apiKey && !(existing && existing.credentialsConfigured))) {
      flashIn('localAiError', '请填写配置名称、HTTPS接口地址、模型ID和API Key', true);
      return;
    }
    if (!/^https:\/\/[^/\s?#]+/i.test(baseUrl)) {
      flashIn('localAiError', '目前仅支持公开 HTTPS 的 OpenAI 兼容 API 地址', true);
      return;
    }
    setBusy(button, true, '正在保存…');
    try {
      const body = {
        id: localAiEditingId || undefined, name: name, section: section,
        template: section === 'product' ? 'custom-product' : 'custom-image',
        protocol: section === 'product' ? 'openai-chat-completions' : 'openai-image',
        baseUrl: baseUrl, model: { name: model },
        capabilities: LOCAL_AI_CAPABILITIES[section],
        enabled: enabled, allowSubaccounts: false,
        timeoutMs: 30000
      };
      if (apiKey) body.apiKey = apiKey;
      const saved = await api(CONFIGURATIONS_URL, { method: 'POST', body: JSON.stringify(body) });
      if (assigned && enabled) {
        for (const capability of LOCAL_AI_CAPABILITIES[section]) {
          await api('/api/integrations/ai/defaults/' + capability, {
            method: 'PUT', body: JSON.stringify({ configurationId: saved.configuration.id })
          });
        }
        await api('/api/integrations/ai/ui-preferences', {
          method: 'PUT', body: JSON.stringify({ billingChannel: 'own' })
        });
      }
      byId('localAiKey').value = '';
      closeModal('aiLocalConfigDialog');
      await loadConfigurations();
      flashIn('aiConfigListError', 'AI平台配置已加密保存，可使用“连接测试”验证配置', false);
    } catch (error) {
      flashIn('localAiError', message(error, 'AI平台保存或用途分配失败'), true);
    } finally { setBusy(button, false); }
  }


  // Quick-import is deliberately declarative: external JS/TS is never evaluated.
  // Each item is sent through the same authenticated, CSRF-protected encrypted save API.
  let quickImportParsed = null;
  const QUICK_JSON_EXAMPLE = {
    providers: [
      { name: '我的文本 AI', type: 'text', baseUrl: 'https://api.example.com/v1',
        model: 'text-model-id', apiKey: '填写自己的密钥', default: true },
      { name: '我的图片 AI', type: 'image', baseUrl: 'https://images.example.com/v1',
        model: 'image-edit-model-id', apiKey: '填写自己的密钥', default: true }
    ]
  };
  function resetQuickImportPreview() {
    quickImportParsed = null;
    byId('aiQuickApply').disabled = true;
    byId('aiQuickPreviewOutput').hidden = true;
    byId('aiQuickPreviewOutput').textContent = '';
    flashIn('aiQuickError', '');
  }
  function quickImportPreview() {
    resetQuickImportPreview();
    try {
      if (!configState.standalone || !configState.owner) throw new Error('仅允许单机版本机管理员导入');
      const parser = window.wyerpAiQuickImport;
      if (!parser) throw new Error('配置解析组件未加载，请刷新页面');
      const rows = parser.parse(byId('aiQuickCode').value);
      const existing = new Set(configState.configurations.map(function (row) { return row.name; }));
      if (rows.some(function (row) { return existing.has(row.name); })) throw new Error('已有同名平台。为防止误覆盖已有密钥，请修改导入配置名称或使用编辑功能');
      quickImportParsed = rows;
      byId('aiQuickPreviewOutput').textContent = JSON.stringify(rows.map(parser.publicPreview), null, 2);
      byId('aiQuickPreviewOutput').hidden = false;
      byId('aiQuickApply').disabled = false;
    } catch (error) {
      flashIn('aiQuickError', String(error.message || '无法识别导入配置'), true);
    }
  }
  async function applyQuickImport() {
    if (!configState.standalone || !configState.owner || !Array.isArray(quickImportParsed) || !quickImportParsed.length) return;
    const rows = quickImportParsed;
    const button = byId('aiQuickApply');
    setBusy(button, true, '正在导入…');
    let savedCount = 0;
    try {
      for (const row of rows) {
        const response = await api(CONFIGURATIONS_URL, {
          method: 'POST',
          body: JSON.stringify({
            name: row.name, section: row.section, template: row.template,
            protocol: row.protocol, baseUrl: row.baseUrl,
            model: { name: row.model }, apiKey: row.apiKey,
            enabled: row.enabled, allowSubaccounts: false,
            capabilities: row.capabilities, timeoutMs: 30000
          })
        });
        savedCount++;
        if (row.makeDefault && row.enabled) {
          for (const capability of row.capabilities) {
            await api('/api/integrations/ai/defaults/' + capability, {
              method: 'PUT', body: JSON.stringify({ configurationId: response.configuration.id })
            });
          }
        }
      }
      if (rows.some(function (r) { return r.makeDefault && r.enabled; })) {
        await api('/api/integrations/ai/ui-preferences', {
          method: 'PUT', body: JSON.stringify({ billingChannel: 'own' })
        });
      }
      byId('aiQuickCode').value = '';
      byId('aiQuickFile').value = '';
      quickImportParsed = null;
      closeModal('aiQuickImportDialog');
      await loadConfigurations();
      flashIn('aiConfigListError', '已导入 ' + savedCount + ' 个模型并加密保存密钥；使用前建议连接测试', false);
    } catch (error) {
      await loadConfigurations().catch(function () {});
      resetQuickImportPreview();
      flashIn('aiQuickError', '已保存 ' + savedCount + ' 条，后续失败：' + message(error, '导入失败') + '。请先核对列表，避免再次导入重复模型。', true);
    } finally { setBusy(button, false); }
  }
  function setupQuickImport() {
    const button = byId('aiQuickImport');
    if (!button) return;
    button.addEventListener('click', function () {
      if (!configState.standalone || !configState.owner) return;
      byId('aiQuickCode').value = '';
      resetQuickImportPreview();
      showModal('aiQuickImportDialog');
      byId('aiQuickCode').focus();
    });
    byId('aiQuickCode').addEventListener('input', resetQuickImportPreview);
    byId('aiQuickPreview').addEventListener('click', quickImportPreview);
    byId('aiQuickApply').addEventListener('click', applyQuickImport);
    byId('aiQuickExample').addEventListener('click', function () {
      byId('aiQuickCode').value = JSON.stringify(QUICK_JSON_EXAMPLE, null, 2);
      resetQuickImportPreview();
    });
    byId('aiQuickCodeExample').addEventListener('click', function () {
      byId('aiQuickCode').value = 'export default ' + JSON.stringify(QUICK_JSON_EXAMPLE, null, 2) + ';';
      resetQuickImportPreview();
    });
    byId('aiQuickChooseFile').addEventListener('click', function () { byId('aiQuickFile').click(); });
    byId('aiQuickFile').addEventListener('change', async function () {
      const file = this.files && this.files[0];
      if (!file) return;
      if (file.size > 60000) return flashIn('aiQuickError', '文件不能超过60KB', true);
      try {
        byId('aiQuickCode').value = await file.text();
        resetQuickImportPreview();
        quickImportPreview();
      } catch (_) { flashIn('aiQuickError', '文件读取失败，请复制文件内容粘贴', true); }
    });
  }

  const VENDOR_TEXT_SAMPLE={version:1,request:{method:'POST',path:'/v2/custom/chat',auth:'x-api-key',body:{engine:'{{model}}',system:'{{system}}',input:'{{inputJson}}'}},response:{textPath:'result.answer'}};
  const VENDOR_IMAGE_SAMPLE={version:1,request:{method:'POST',path:'/v2/media/submit',auth:'bearer',body:{engine:'{{model}}',prompt:'{{prompt}}',source:'{{image}}',references:'{{images}}'}},response:{imagePath:'data.url',taskPath:'data.taskId',statusPath:'data.status'},poll:{path:'/v2/media/result/{{taskId}}',response:{imagePath:'data.url',statusPath:'data.status'}}};
  let vendorEditingId=null;
  function vendorProgramInput(){
    let raw=byId('vendorCode').value.trim();
    const ticks=String.fromCharCode(96).repeat(3);
    if(raw.startsWith(ticks))raw=raw.replace(new RegExp('^'+ticks+'(?:json|typescript|ts|javascript)?\\s*','i'),'').replace(new RegExp('\\s*'+ticks+'$'),'');
    if(/^export\s+default\s+/i.test(raw))raw=raw.replace(/^export\s+default\s+/i,'').replace(/;\s*$/,'');
    if(raw.length>30000)throw new Error('适配器代码超过30KB');
    try{const obj=JSON.parse(raw);if(!obj||typeof obj!=='object'||Array.isArray(obj))throw new Error();return obj;}
    catch(_){throw new Error('只支持严格JSON或export default+JSON；不执行任意JS/TS函数');}
  }
  function openVendorDialog(row){
    if(!configState.standalone||!configState.owner)return;
    vendorEditingId=row?.protocol==='custom-structured'?row.id:null;
    byId('aiVendorTitle').textContent=vendorEditingId?'编辑供应商适配器':'新增供应商适配器';
    byId('vendorName').value=row?.name||'';
    byId('vendorSection').value=row?.section||'product';
    byId('vendorSection').disabled=Boolean(vendorEditingId);
    byId('vendorUrl').value=row?.baseUrl||'';
    byId('vendorModel').value=row?.model?.name||'';
    byId('vendorKey').value='';
    byId('vendorKey').placeholder=row?.credentialsConfigured?'留空保留原密钥':'供应商API Key';
    byId('vendorCode').value=JSON.stringify(row?.model?.adapter||(byId('vendorSection').value==='product'?VENDOR_TEXT_SAMPLE:VENDOR_IMAGE_SAMPLE),null,2);
    byId('vendorEnabled').checked=row?.enabled!==false;
    byId('vendorDefault').checked=!vendorEditingId;
    byId('vendorError').hidden=true;
    showModal('aiVendorAdapterDialog');
  }
  async function saveVendorDialog(){
    if(!configState.standalone||!configState.owner)return;
    const section=byId('vendorSection').value,key=byId('vendorKey').value.trim();
    const existing=configState.configurations.find(x=>x.id===vendorEditingId);
    if(!byId('vendorName').value.trim()||!byId('vendorUrl').value.trim()||!byId('vendorModel').value.trim()||(!key&&!existing?.credentialsConfigured)){
      flashIn('vendorError','请填写名称、HTTPS服务地址、模型ID和密钥',true);return;
    }
    let program;try{program=vendorProgramInput();}catch(error){flashIn('vendorError',error.message,true);return;}
    const button=byId('vendorSave');setBusy(button,true,'正在验证保存…');
    try{
      const data={id:vendorEditingId||undefined,name:byId('vendorName').value.trim(),section,
        protocol:'custom-structured',template:section==='product'?'custom-product':'custom-image',
        baseUrl:byId('vendorUrl').value.trim(),model:{name:byId('vendorModel').value.trim(),adapter:program},
        capabilities:LOCAL_AI_CAPABILITIES[section],enabled:byId('vendorEnabled').checked,
        allowSubaccounts:false,timeoutMs:30000};
      if(key)data.apiKey=key;
      const saved=await api(CONFIGURATIONS_URL,{method:'POST',body:JSON.stringify(data)});
      if(byId('vendorDefault').checked&&data.enabled){
        for(const capability of data.capabilities)await api('/api/integrations/ai/defaults/'+capability,{method:'PUT',body:JSON.stringify({configurationId:saved.configuration.id})});
        await api('/api/integrations/ai/ui-preferences',{method:'PUT',body:JSON.stringify({billingChannel:'own'})});
      }
      byId('vendorKey').value='';byId('vendorCode').value='';
      closeModal('aiVendorAdapterDialog');await loadConfigurations();
      flashIn('aiConfigListError','供应商适配器已验证保存；无需重启即可使用',false);
    }catch(error){flashIn('vendorError',message(error,'保存适配器失败'),true);}
    finally{setBusy(button,false);}
  }
  function setupVendorDialog(){
    const b=byId('aiVendorNew');if(!b)return;
    b.addEventListener('click',()=>openVendorDialog(null));
    byId('vendorSection').addEventListener('change',function(){byId('vendorCode').value=JSON.stringify(this.value==='product'?VENDOR_TEXT_SAMPLE:VENDOR_IMAGE_SAMPLE,null,2);});
    byId('vendorTextExample').addEventListener('click',()=>{byId('vendorSection').value='product';byId('vendorCode').value=JSON.stringify(VENDOR_TEXT_SAMPLE,null,2);});
    byId('vendorImageExample').addEventListener('click',()=>{byId('vendorSection').value='image';byId('vendorCode').value=JSON.stringify(VENDOR_IMAGE_SAMPLE,null,2);});
    byId('vendorJsonCheck').addEventListener('click',()=>{try{const obj=vendorProgramInput();if(obj.version!==1||!obj.request||!obj.response)throw new Error('缺少v1、request或response');flashIn('vendorError','代码格式初检通过；服务器保存时执行最终协议校验',false);}catch(e){flashIn('vendorError',e.message,true);}});
    byId('vendorSave').addEventListener('click',saveVendorDialog);
  }
  const cfgDialogState = { editing: false, hasExistingKey: false };
  function cfgEls() {
    return {
      name: byId('cfgName'), key: byId('cfgApiKey'),
      text: byId('cfgGroupText'), image: byId('cfgGroupImage'), video: byId('cfgGroupVideo'),
      textModel: byId('cfgTextModel'), transModel: byId('cfgTransModel'), redrawModel: byId('cfgRedrawModel'),
      textField: byId('cfgTextField'), transField: byId('cfgTransField'), redrawField: byId('cfgRedrawField')
    };
  }
  function fillSelect(select, items, selected) {
    select.replaceChildren();
    (items || []).forEach(function (item) {
      const option = el('option');
      option.value = item.name;
      option.textContent = item.label && item.label !== item.name ? item.label + '（' + item.name + '）' : item.name;
      if (item.name === selected) option.selected = true;
      select.append(option);
    });
    if (!selected && select.options.length) select.options[0].selected = true;
  }
  async function openConfigDialog(editing) {
    const d = cfgEls();
    flashIn('cfgError', '');
    let modelsData;
    try {
      modelsData = await api(GRS_MODELS_URL);
    } catch (error) {
      flashIn('aiConfigListError', message(error, '模型清单读取失败'), true);
      return;
    }
    const selected = modelsData.selected || {};
    fillSelect(d.textModel, modelsData.text, selected.product);
    fillSelect(d.transModel, modelsData.image, selected.imageTranslation);
    fillSelect(d.redrawModel, modelsData.image, selected.imageRedraw);
    cfgDialogState.editing = editing;
    const grsRows = configState.configurations.filter(function (row) { return String(row.template || '').indexOf('grsai-') === 0; });
    const productRow = grsRows.find(function (row) { return row.template === 'grsai-product'; }) || null;
    const imageRow = grsRows.find(function (row) { return row.template === 'grsai-image'; }) || null;
    if (editing) {
      byId('aiConfigDialogTitle').textContent = '修改AI配置';
      const names = grsRows.map(function (r) { return r.name; }).filter(function (value, index, arr) { return arr.indexOf(value) === index; });
      d.name.value = names.length === 1 ? names[0] : '';
      d.text.checked = Boolean(productRow && productRow.enabled);
      d.image.checked = Boolean(imageRow && imageRow.enabled);
      d.video.checked = Boolean(imageRow && imageRow.supportsVideo);
      cfgDialogState.hasExistingKey = grsRows.some(function (row) { return row.credentialsConfigured; });
    } else {
      byId('aiConfigDialogTitle').textContent = '新增AI配置';
      d.name.value = '';
      d.text.checked = true; d.image.checked = true; d.video.checked = false;
      cfgDialogState.hasExistingKey = false;
    }
    d.key.value = '';
    d.key.placeholder = (editing && cfgDialogState.hasExistingKey) ? '留空表示不修改已有密钥' : '必填：粘贴供应商控制台生成的 API 密钥';
    syncCfgFields();
    showModal('aiConfigDialog');
    d.name.focus();
  }
  function syncCfgFields() {
    const d = cfgEls();
    d.textField.hidden = !d.text.checked;
    d.transField.hidden = !d.image.checked;
    d.redrawField.hidden = !d.image.checked;
    if (!d.image.checked) d.video.checked = false;
    d.video.disabled = !d.image.checked;
  }
  function collectConfig() {
    const d = cfgEls();
    const name = d.name.value.trim();
    const groups = { text: d.text.checked, image: d.image.checked, video: d.video.checked };
    const models = { product: d.textModel.value, imageTranslation: d.transModel.value, imageRedraw: d.redrawModel.value };
    const apiKey = d.key.value.trim();
    if (!name) { flashIn('cfgError', '请填写配置名称', true); return null; }
    if (!groups.text && !groups.image) { flashIn('cfgError', '文本、图片至少勾选一项', true); return null; }
    if (groups.video && !groups.image) { flashIn('cfgError', '视频只能随图片通道一起登记', true); return null; }
    if (groups.text && !models.product) { flashIn('cfgError', '请选择文本模型', true); return null; }
    if (groups.image && (!models.imageTranslation || !models.imageRedraw)) { flashIn('cfgError', '请选择图片翻译和图片重绘模型', true); return null; }
    if (!cfgDialogState.hasExistingKey && !apiKey) { flashIn('cfgError', '请填写 API 密钥；信息填完整才能接通', true); return null; }
    return { name: name, groups: groups, models: models, apiKey: apiKey };
  }
  async function saveConfig() {
    const payload = collectConfig();
    if (!payload) return null;
    const body = { name: payload.name, groups: payload.groups, models: payload.models };
    if (payload.apiKey) body.apiKey = payload.apiKey;
    await api(GRS_SAVE_URL, { method: 'POST', body: JSON.stringify(body) });
    cfgDialogState.hasExistingKey = cfgDialogState.hasExistingKey || Boolean(payload.apiKey);
    return payload;
  }

  // ───────────────────────── 图片提示词：列表 + 新增/编辑弹窗 ─────────────────────────

  const PROMPT_CATEGORIES = [['image-main', '主图'], ['image-scene', '场景图'], ['image-selling', '卖点图'], ['image-accessory', '配件赠品图'], ['image-white-base', '白底图'], ['image-size', '尺寸图']];
  let promptState = { loaded: false, custom: [], official: [], effective: [], systemAdmin: false, owner: false, customizationAllowed: false };
  async function loadPrompts() {
    const data = await api(PROMPTS_URL);
    promptState.custom = data.custom || [];
    promptState.official = data.official || [];
    promptState.effective = data.effective || [];
    promptState.systemAdmin = Boolean(data.systemAdmin);
    promptState.owner = data.owner !== false;
    promptState.customizationAllowed = data.customizationAllowed === true || promptState.systemAdmin;
    promptState.loaded = true;
    renderPrompts();
  }
  function effectiveFor(functionKey) {
    return promptState.effective.find(function (item) { return item.functionKey === functionKey; }) || null;
  }
  function officialFor(functionKey) {
    return promptState.official.find(function (item) { return item.functionKey === functionKey; }) || null;
  }
  function getEffectiveBody(functionKey) {
    const eff = effectiveFor(functionKey);
    if (eff && eff.promptId) {
      const row = promptState.custom.find(function (item) { return item.id === eff.promptId && item.enabled !== false; });
      if (row) return row.body;
    }
    const official = officialFor(functionKey);
    return official ? official.body : '';
  }
  function renderPrompts() {
    renderPromptCoverage();
    renderPromptGroups();
  }
  function renderPromptCoverage() {
    const box = byId('aiPromptCoverage');
    box.replaceChildren();
    PROMPT_CATEGORIES.forEach(function (pair) {
      const eff = effectiveFor(pair[0]);
      const on = Boolean(eff);
      const chip = el('span', 'ai-coverage-chip ' + (on ? 'is-on' : 'is-off'));
      chip.textContent = (on ? '✓ ' : '') + pair[1] + (on ? '已生效' : '待配置');
      box.append(chip);
    });
  }
  function emptyBlock(text) {
    const block = el('div', 'ai-empty-block');
    block.textContent = text;
    return block;
  }
  function renderPromptGroups() {
    const wrap = byId('aiPromptList');
    wrap.replaceChildren();
    const isAdmin = Boolean(promptState.systemAdmin);
    const headers = ['生效图片', '生效模板', '内容预览'];
    if (isAdmin) headers.push('租户可读');
    headers.push('更新时间', '操作');
    const table = tableWithHead(headers);
    const tbody = table.querySelector('tbody');
    PROMPT_CATEGORIES.forEach(function (pair) { tbody.append(buildCategoryRow(pair)); });
    wrap.append(table);
  }
  // 每类一行：下拉选择该类生效模板（官方/各启用的自定义），行内直接新增、编辑、删除。
  function buildCategoryRow(pair) {
    const functionKey = pair[0];
    const label = pair[1];
    const official = officialFor(functionKey);
    const customs = promptState.custom.filter(function (row) { return row.functionKey === functionKey && row.enabled !== false; });
    const eff = effectiveFor(functionKey);
    const effCustom = eff && eff.source === 'custom' ? customs.find(function (row) { return row.id === eff.promptId; }) : null;
    const selected = effCustom || official;
    const canWrite = promptState.owner !== false && promptState.customizationAllowed;
    const tr = el('tr');
    tr.className = effCustom ? 'is-active' : 'is-official';
    tr.append(tableCell(label));

    const pick = el('div', 'ai-prompt-pick');
    const select = el('select', 'ai-prompt-select');
    const offOption = el('option');
    offOption.value = 'official';
    offOption.textContent = official && official.masked ? '官方模板（内容未开放）' : '官方模板';
    select.append(offOption);
    customs.forEach(function (row) {
      const option = el('option');
      option.value = row.id;
      option.textContent = row.name;
      select.append(option);
    });
    select.value = effCustom ? effCustom.id : 'official';
    select.disabled = !canWrite;
    select.addEventListener('change', function () {
      setPromptSelection(functionKey, select.value === 'official' ? null : select.value);
    });
    const nameLine = el('div', 'ai-prompt-pick-name');
    const tag = el('span', 'ai-prompt-source-tag');
    tag.textContent = effCustom ? '自定义' : '官方';
    const nameText = el('span');
    nameText.textContent = selected ? selected.name : '未配置';
    if (selected && selected.name) nameText.dataset.aiTip = selected.name;
    nameLine.append(tag, nameText);
    const stateLine = el('div', 'ai-prompt-pick-state');
    if (!eff) stateLine.textContent = '尚无可用模板，请新增';
    else if (effCustom) stateLine.textContent = eff.auto ? '按最新保存自动生效' : '已指定生效';
    else stateLine.textContent = official && official.masked ? '官方模板生效中（内容未开放）' : '官方模板生效中';
    pick.append(select, nameLine, stateLine);
    tr.append(tableCell(pick));

    const preview = el('span', 'ai-cell-preview');
    if (selected && selected.masked) preview.textContent = promptState.customizationAllowed
      ? '系统管理员未开放查看，业务中仍可正常使用'
      : '当前方案只能使用模板，模板正文不开放查看';
    else if (selected) {
      preview.dataset.aiTip = selected.body;
      preview.textContent = selected.body.length > 110 ? selected.body.slice(0, 110) + '…' : selected.body;
    } else preview.textContent = '—';
    tr.append(tableCell(preview));

    if (promptState.systemAdmin) {
      const readTd = el('td');
      if (official) {
        const check = el('label', 'ai-read-check');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(official.readable);
        input.addEventListener('click', function (event) { event.stopPropagation(); });
        input.addEventListener('change', function () { setOfficialReadable(official.key, input.checked, input); });
        const text = el('span');
        text.textContent = '租户可读';
        check.append(input, text);
        readTd.append(check);
      }
      tr.append(readTd);
    }

    const time = effCustom && effCustom.updatedAt ? new Date(effCustom.updatedAt).toLocaleString()
      : (official && official.version ? 'v' + official.version : '');
    tr.append(tableCell(time));

    const actions = [];
    if (canWrite) {
      actions.push(actionButton('新增', '', function () { openPromptDialog(null, functionKey); }));
      if (effCustom) {
        actions.push(actionButton('编辑', '', function () { openPromptDialog(effCustom, functionKey); }));
        actions.push(actionButton('删除', 'is-danger', function () { deletePrompt(effCustom, pair[1]); }));
      } else if (official && !official.masked) {
        if (promptState.systemAdmin) actions.push(actionButton('编辑官方', '', function () { openPromptDialog(official, functionKey, true); }));
        actions.push(actionButton('复制为自定义', '', function () {
          openPromptDialog({ functionKey: official.functionKey, name: official.name, body: official.body }, functionKey);
        }));
      }
    }
    tr.append(tableCell(rowActions(actions)));
    return tr;
  }
  async function setOfficialReadable(key, readable, input) {
    const old = !readable;
    try {
      await api('/api/integrations/ai/official-prompts/' + key + '/readable', { method: 'PUT', body: JSON.stringify({ readable: readable }) });
      await loadPrompts();
      flashIn('aiPromptListError', readable ? '已开放：所有租户可查看该官方提示词' : '已关闭：租户列表不再显示该提示词内容');
    } catch (error) {
      if (input) input.checked = old;
      flashIn('aiPromptListError', message(error, '可读设置保存失败'), true);
    }
  }
  async function setPromptSelection(functionKey, promptId) {
    try {
      await api(PROMPT_SELECTIONS_URL + '/' + functionKey, { method: 'PUT', body: JSON.stringify({ promptId: promptId }) });
      await loadPrompts();
    } catch (error) {
      flashIn('aiPromptListError', message(error, '生效状态保存失败'), true);
    }
  }
  async function deletePrompt(row, label) {
    if (!window.confirm('确认删除' + label + '提示词“' + row.name + '”？删除后该类将改用其它自定义或官方模板。')) return;
    try {
      const eff = effectiveFor(row.functionKey);
      if (eff && eff.promptId === row.id) {
        await api(PROMPT_SELECTIONS_URL + '/' + row.functionKey, { method: 'PUT', body: JSON.stringify({ promptId: null }) });
      }
      await api(PROMPTS_URL + '/' + row.id, { method: 'DELETE' });
      await loadPrompts();
      flashIn('aiPromptListError', '提示词已删除');
    } catch (error) {
      if (error.publicCode === 'ai_prompt_in_use') flashIn('aiPromptListError', '该提示词仍被指定生效，请先在下拉中改选其它模板，再删除', true);
      else flashIn('aiPromptListError', message(error, '删除失败'), true);
    }
  }

  // ── 新增/编辑提示词弹窗 ──

  function ptEls() {
    return { category: byId('ptCategory'), name: byId('ptName'), body: byId('ptBody') };
  }
  function openPromptDialog(row, presetKey, officialMode) {
    flashIn('ptError', '');
    const d = ptEls();
    d.category.disabled = false;
    d.body.dataset.officialKey = '';
    d.category.replaceChildren();
    PROMPT_CATEGORIES.forEach(function (pair) {
      const option = el('option');
      option.value = pair[0]; option.textContent = pair[1];
      d.category.append(option);
    });
    if (officialMode && row && row.key) {
      byId('aiPromptDialogTitle').textContent = '修改官方提示词';
      d.category.value = row.functionKey;
      d.category.disabled = true;
      d.name.value = row.name || '';
      d.body.value = row.body || '';
      d.body.dataset.editId = '';
      d.body.dataset.officialKey = row.key;
    } else if (row && row.id) {
      byId('aiPromptDialogTitle').textContent = '修改提示词';
      d.category.value = row.functionKey;
      d.name.value = row.name;
      d.body.value = row.body;
      d.body.dataset.editId = row.id;
    } else {
      byId('aiPromptDialogTitle').textContent = '新增提示词';
      d.category.value = (row && row.functionKey) || presetKey || PROMPT_CATEGORIES[0][0];
      d.name.value = row && row.name ? String(row.name).replace(/提示词$/, '') + '（自定义）' : '';
      d.body.value = row ? row.body : '';
      d.body.dataset.editId = '';
    }
    showModal('aiPromptDialog');
    d.name.focus();
  }
  async function savePromptDialog() {
    const d = ptEls();
    const functionKey = d.category.value;
    const name = d.name.value.trim();
    const body = d.body.value.trim();
    if (!name) { flashIn('ptError', '请填写提示词名称', true); return; }
    if (!body) { flashIn('ptError', '请填写提示词内容', true); return; }
    const payload = { functionKey: functionKey, name: name, body: body, enabled: true };
    if (d.body.dataset.editId) payload.id = d.body.dataset.editId;
    try {
      const officialKey = d.body.dataset.officialKey;
      if (officialKey) await api('/api/integrations/ai/official-prompts/' + officialKey, { method: 'PUT', body: JSON.stringify({ name: name, body: body }) });
      else await api(PROMPTS_URL, { method: 'POST', body: JSON.stringify(payload) });
      closeModal('aiPromptDialog');
      await loadPrompts();
      flashIn('aiPromptListError', officialKey ? '官方提示词已保存并生效' : '提示词已保存并生效');
    } catch (error) {
      flashIn('ptError', message(error, '提示词保存失败'), true);
    }
  }

  // ── 通用弹窗开关 ──

  function showModal(id) {
    const modal = byId(id);
    modal.hidden = false;
    document.body.classList.add('ai-modal-open');
  }
  function closeModal(id) {
    const modal = byId(id);
    modal.hidden = true;
    if (!document.querySelector('.ai-modal:not([hidden])')) document.body.classList.remove('ai-modal-open');
  }
  function setupModals() {
    document.addEventListener('click', function (event) {
      const closer = event.target.closest('[data-modal-close]');
      if (closer) {
        const modal = closer.closest('.ai-modal');
        if (modal) closeModal(modal.id);
        return;
      }
      if (event.target.classList && event.target.classList.contains('ai-modal')) closeModal(event.target.id);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') document.querySelectorAll('.ai-modal:not([hidden])').forEach(function (modal) { closeModal(modal.id); });
    });
  }

  function ruleInputs() {
    return [...document.querySelectorAll('[data-panel="rules"] textarea[data-rule]')];
  }
  let ruleSnapshots = null;
  const RULE_POLICY_FIELDS = {
    global: [['prohibitedClaims.zh', '禁止宣称（中文，每行一条）'], ['prohibitedClaims.ru', '禁止宣称（俄文，每行一条）'], ['prohibitedClaims.en', '禁止宣称（英文，每行一条）'], ['materialTerms', '材料词条（每行一条）']],
    title: [['ownBrand', '商品自身品牌', [['explicit_only', '仅使用当前品牌字段'], ['omit', '省略商品自身品牌']]], ['rejectBrandPlaceholder', '禁止无品牌占位', 'boolean'], ['compatibility', '适配品牌与型号', [['allow', '允许有原始证据的适配品牌型号'], ['deny', '不使用适配品牌型号']]], ['compatibilityExpressions.zh', '适配表达（中文，每行一条）'], ['compatibilityExpressions.ru', '适配表达（俄文，每行一条）']],
    summary: [['compatibility', '适配品牌与型号', [['allow', '允许有原始证据的适配品牌型号'], ['deny', '不使用适配品牌型号']]], ['compatibilityExpressions.zh', '适配表达（中文，每行一条）'], ['compatibilityExpressions.ru', '适配表达（俄文，每行一条）']],
    tags: [['excludeBrand', '主题标签排除品牌', 'boolean'], ['excludeModel', '主题标签排除型号', 'boolean']]
  };
  function policyValue(policy, path) { return path.split('.').reduce(function (value, key) { return value && value[key]; }, policy); }
  function usableRulePolicy(rule) {
    return rule && typeof rule.updatedAt === 'string' && rule.updatedAt && rule.policy && rule.policy.schemaVersion === 1 && (RULE_POLICY_FIELDS[rule.key] || []).every(function (field) {
      const value = policyValue(rule.policy, field[0]);
      return field[2] === 'boolean' ? typeof value === 'boolean' : Array.isArray(field[2]) ? field[2].some(function (option) { return option[0] === value; }) : Array.isArray(value) && value.every(function (item) { return typeof item === 'string'; });
    });
  }
  function renderRulePolicy(area, rule) {
    const article = area.closest('article');
    const previous = article.querySelector('[data-policy-controls]');
    if (previous) previous.remove();
    const group = el('div'); group.dataset.policyControls = rule.key;
    (RULE_POLICY_FIELDS[rule.key] || []).forEach(function (field) {
      if (field[0] === 'materialTerms') {
        const heading = el('h3'), help = el('p', 'ai-help'); heading.textContent = '材料英文名称与缩写';
        help.textContent = '仅原标题或材质属性中有依据的词条可用于俄语标题、简介和属性；主题标签不适用。清空后保存表示关闭材料英文例外。';
        group.append(heading, help);
      }
      const label = el('label', 'ai-field'), caption = el('span'); caption.textContent = field[1];
      const value = policyValue(rule.policy, field[0]);
      let control;
      if (field[2] === 'boolean') { control = el('input'); control.type = 'checkbox'; control.checked = value; }
      else if (Array.isArray(field[2])) {
        control = el('select');
        field[2].forEach(function (option) { const node = el('option'); node.value = option[0]; node.textContent = option[1]; control.append(node); });
        control.value = value;
      } else { control = el('textarea'); control.rows = 3; control.value = value.join('\n'); }
      control.dataset.policyField = field[0]; control.setAttribute('aria-label', field[1]); label.append(caption, control); group.append(label);
    });
    if (rule.key === 'global') {
      const help = el('p', 'ai-help');
      help.textContent = '结构化业务策略优先于写作规则正文。数字、语言、适配来源证据、平台格式、字典编号、租户隔离及已确认的硬长度校验不能关闭。';
      group.prepend(help);
    }
    article.append(group);
  }
  function editedRulePolicy(area) {
    const policy = JSON.parse(JSON.stringify(ruleSnapshots[area.dataset.rule].policy));
    area.closest('article').querySelectorAll('[data-policy-field]').forEach(function (control) {
      const path = control.dataset.policyField.split('.'), key = path.pop();
      const target = path.reduce(function (value, part) { return value[part]; }, policy);
      target[key] = control.type === 'checkbox' ? control.checked : control.tagName === 'TEXTAREA' ? control.value.split(/\r?\n/).filter(function (line) { return line !== ''; }) : control.value;
    });
    return policy;
  }
  function setRuleStatus(text, kind) {
    const status = byId('aiRuleStatus');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-ok', kind === 'ok');
    status.classList.toggle('is-bad', kind === 'bad');
    status.classList.toggle('is-waiting', kind !== 'ok' && kind !== 'bad');
  }
  function setRuleError(text) {
    const box = byId('aiRuleError');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
  }
  let systemAdminFlag = null;
  async function isSystemAdmin() {
    if (systemAdminFlag !== null) return systemAdminFlag;
    try {
      const data = await api(CONFIGURATIONS_URL);
      systemAdminFlag = data.systemAdmin === true;
    } catch (error) {
      systemAdminFlag = false;
    }
    return systemAdminFlag;
  }
  async function showRulesTabOnFailure(error) {
    const admin = await isSystemAdmin();
    if (!admin) return false;
    revealRulesTab();
    byId('aiRuleSave').disabled = true;
    setRuleError(message(error, '无法读取商品内容规则'));
    setRuleStatus('规则读取失败', 'bad');
    return true;
  }
  function revealRulesTab() {
    const tab = document.querySelector('#aiModuleNav [data-module="rules"]');
    if (tab) tab.hidden = false;
  }
  async function loadRules() {
    ruleSnapshots = null;
    byId('aiRuleSave').disabled = true;
    let data;
    try {
      data = await api(PRODUCT_RULES_URL);
    } catch (error) {
      // 只有"当前登录人不是系统管理员"才继续隐藏页签；其它失败必须显形，避免规则入口凭空消失。
      if (await showRulesTabOnFailure(error)) return;
      if (error && (error.publicCode === 'system_admin_required' || error.publicCode === 'unauthorized')) return;
      revealRulesTab();
      byId('aiRuleSave').disabled = true;
      setRuleError(message(error, '无法读取商品内容规则'));
      setRuleStatus('规则读取失败', 'bad');
      return;
    }
    revealRulesTab();
    const byKey = {};
    (data.rules || []).forEach(function (rule) { byKey[rule.key] = rule; });
    if (byKey.global && byKey.global.policy && !Object.prototype.hasOwnProperty.call(byKey.global.policy, 'materialTerms')) {
      ruleSnapshots = null; byId('aiRuleSave').disabled = true;
      setRuleError('材料英文许可表尚未配置，请联系系统管理员。'); setRuleStatus('策略读取失败', 'bad'); return false;
    }
    if (!ruleInputs().every(function (area) { return usableRulePolicy(byKey[area.dataset.rule]); })) {
      ruleSnapshots = null; byId('aiRuleSave').disabled = true;
      setRuleError('商品内容策略尚未配置，请联系系统管理员。'); setRuleStatus('策略读取失败', 'bad'); return false;
    }
    ruleSnapshots = byKey;
    ruleInputs().forEach(function (area) {
      const rule = byKey[area.dataset.rule];
      if (!rule) return;
      area.value = rule.body;
      area.dataset.enabled = rule.enabled === false ? '0' : '1';
      renderRulePolicy(area, rule);
    });
    const tab = document.querySelector('#aiModuleNav [data-module="rules"]');
    if (tab) tab.hidden = false;
    byId('aiRuleSave').disabled = false;
    setRuleStatus('可编辑 · 共 ' + (data.rules || []).length + ' 条', 'ok');
    setRuleError('');
    return true;
  }
  async function saveRules() {
    const button = byId('aiRuleSave');
    setRuleError('');
    if (!ruleSnapshots) { setRuleError('商品内容策略尚未配置，请联系系统管理员。'); button.disabled = true; return; }
    const rules = ruleInputs().map(function (area) {
      return { key: area.dataset.rule, body: area.value.trim(), enabled: area.dataset.enabled !== '0', policy: editedRulePolicy(area), expectedUpdatedAt: ruleSnapshots[area.dataset.rule].updatedAt };
    });
    if (!rules.length) { setRuleError('规则控件缺失，未提交'); return; }
    const empty = rules.find(function (rule) { return !rule.body; });
    if (empty) { setRuleError('规则内容不能为空'); setRuleStatus('未保存：存在空规则', 'bad'); return; }
    setBusy(button, true, '正在保存…');
    try {
      const saved = await api(PRODUCT_RULES_URL, { method: 'POST', body: JSON.stringify({ rules: rules }) });
      if (await loadRules()) setRuleStatus('已保存 ' + (saved.rules || rules).length + ' 条规则', 'ok');
      else setRuleStatus('已保存，但重新读取失败，请刷新后继续编辑', 'bad');
    } catch (error) {
      setRuleError(message(error, '商品内容规则保存失败'));
      setRuleStatus('保存失败，现有规则未改变', 'bad');
    } finally {
      setBusy(button, false);
    }
  }

  function pricingNumber(id) {
    const value = Number(byId(id).value);
    return Number.isSafeInteger(value) ? value : NaN;
  }
  function renderPricingEffective() {
    const imageOriginal = pricingNumber('priceImageOriginal'), imageDiscount = pricingNumber('priceImageDiscount');
    const analysisOriginal = pricingNumber('priceAnalysisOriginal'), analysisDiscount = pricingNumber('priceAnalysisDiscount');
    if (byId('priceImageEffective')) byId('priceImageEffective').textContent = Number.isSafeInteger(imageOriginal) ? '当前实际扣费：' + (imageDiscount > 0 ? imageDiscount : imageOriginal) + ' AI豆/张' : '';
    if (byId('priceAnalysisEffective')) byId('priceAnalysisEffective').textContent = Number.isSafeInteger(analysisOriginal) ? '当前实际扣费：' + (analysisDiscount > 0 ? analysisDiscount : analysisOriginal) + ' AI豆/100条' : '';
  }
  async function loadPricing() {
    if (!configState.systemAdmin && !(await isSystemAdmin())) return;
    try {
      const data = await api(PRICING_URL);
      const pricing = data.pricing || {};
      byId('priceImageOriginal').value = pricing.image && pricing.image.originalBean != null ? pricing.image.originalBean : '';
      byId('priceImageDiscount').value = pricing.image && pricing.image.discountBean != null ? pricing.image.discountBean : 0;
      byId('priceAnalysisOriginal').value = pricing.analysis && pricing.analysis.originalBean != null ? pricing.analysis.originalBean : '';
      byId('priceAnalysisDiscount').value = pricing.analysis && pricing.analysis.discountBean != null ? pricing.analysis.discountBean : 0;
      renderPricingEffective();
      byId('aiPricingStatus').textContent = '可编辑 · 价格由服务器统一执行';
      byId('aiPricingStatus').classList.remove('is-bad', 'is-waiting');
      byId('aiPricingStatus').classList.add('is-ok');
    } catch (error) {
      flashIn('aiPricingError', message(error, 'AI豆价格读取失败'), true);
      byId('aiPricingStatus').textContent = '价格读取失败';
      byId('aiPricingStatus').classList.remove('is-ok', 'is-waiting');
      byId('aiPricingStatus').classList.add('is-bad');
    }
  }
  async function savePricing() {
    const button = byId('aiPricingSave');
    const payload = {
      imageOriginalBean: pricingNumber('priceImageOriginal'),
      imageDiscountBean: pricingNumber('priceImageDiscount'),
      analysisOriginalBean: pricingNumber('priceAnalysisOriginal'),
      analysisDiscountBean: pricingNumber('priceAnalysisDiscount')
    };
    if (!Number.isSafeInteger(payload.imageOriginalBean) || payload.imageOriginalBean < 1 || !Number.isSafeInteger(payload.imageDiscountBean) || payload.imageDiscountBean < 0 || !Number.isSafeInteger(payload.analysisOriginalBean) || payload.analysisOriginalBean < 1 || !Number.isSafeInteger(payload.analysisDiscountBean) || payload.analysisDiscountBean < 0) {
      flashIn('aiPricingError', '价格必须填写为整数AI豆；原价至少1豆，折扣价可填0关闭折扣。', true);
      return;
    }
    if (payload.imageDiscountBean > payload.imageOriginalBean || payload.analysisDiscountBean > payload.analysisOriginalBean) {
      flashIn('aiPricingError', '折扣价不能高于对应原价。', true);
      return;
    }
    setBusy(button, true, '正在保存…');
    try {
      await api(PRICING_URL, { method: 'POST', body: JSON.stringify(payload) });
      await loadPricing();
      flashIn('aiPricingError', 'AI豆价格已保存，新的收费任务将立即使用新价格。');
    } catch (error) {
      flashIn('aiPricingError', message(error, 'AI豆价格保存失败'), true);
    } finally {
      setBusy(button, false);
      if (!ruleSnapshots) button.disabled = true;
    }
  }
  const CONTENT_URL = '/api/domain/commands/product-content-candidates';
  const ITEM_ORDER = ['title', 'tags', 'summary', 'sellingPoints', 'richTitle', 'richDescription'];
  let pendingGenerations = 0;
  let paidConfirmed = false;
  function setGenerateError(text) {
    const box = byId('aiGenerateError');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
  }
  function cardParts(key) {
    const card = document.querySelector('[data-item="' + key + '"]');
    return card ? { status: card.querySelector('[data-status]'), output: card.querySelector('[data-output]'), button: card.querySelector('[data-generate]') } : null;
  }
  function openImageViewer(item) {
    const existing = document.getElementById('aiImageViewer');
    if (existing) existing.remove();
    const layer = el('div', 'ai-image-lightbox');
    const image = el('img');
    image.src = item.dataUrl;
    image.alt = item.name;
    const caption = el('div', 'ai-image-caption');
    const name = el('span');
    name.textContent = item.name;
    const save = el('a');
    save.textContent = '下载这张图';
    save.href = item.dataUrl;
    save.download = String(item.name || 'image').replace(/[\\/:*?"<>|]+/g, '_') + '.png';
    caption.append(name, save);
    layer.append(image, caption);
    layer.addEventListener('click', function () { layer.remove(); });
    document.body.append(layer);
    const close = function (event) { if (event.key === 'Escape') { layer.remove(); window.removeEventListener('keydown', close); } };
    window.addEventListener('keydown', close);
  }
  async function fetchByTaskId(button) {
    const input = byId('aiReferenceTask');
    const taskId = input && input.value ? input.value.trim() : '';
    if (!taskId) { setReferenceError('请先粘贴 GRS 任务号（控制台里的 id，例如 2-cfe43ec5-…）'); return; }
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) { setReferenceError('任务号格式不对，应只含字母、数字、- _ : .'); return; }
    if (button) { button.disabled = true; button.textContent = '取回中…'; }
    setReferenceError('正在从 GRS 取回该任务的图片…');
    try {
      const out = await api('/api/domain/commands/ai-image-task', { method: 'POST', body: JSON.stringify({ taskId: taskId }) });
      if (out && out.imageUrl) {
        referenceImages.push({ name: '取回 ' + taskId.slice(0, 14), size: Math.round(out.imageUrl.length * 0.75), type: 'image/png', dataUrl: out.imageUrl, temp: true });
        renderReferenceList();
        setReferenceError('已取回该任务的图片并加入列表（' + Math.round(out.kb) + ' KB）；点图可放大，不需要时点“移除”');
      }
    } catch (error) {
      setReferenceError('取回失败：' + message(error, '未知原因'));
    } finally {
      if (button) { button.disabled = false; button.textContent = '按任务号取回'; }
    }
  }
  // ── 数据分析规则：三条规则文本保存在本机浏览器（仅系统管理员可见） ──
  const ANALYSIS_KEY = 'erp_ai_analysis_rules';
  function setAnalysisState(text, bad) {
    const box = byId('analysisSaveState');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'ai-status' + (text ? (bad ? ' is-bad' : ' is-ok') : '');
  }
  function fillAnalysisRules(data) {
    const map = [['ruleAnalysisReason', 'analysisReasonRules'], ['ruleOrderAnalysis', 'orderAnalysisRules'], ['ruleTodo', 'todoRules']];
    map.forEach(function (pair) {
      const box = byId(pair[0]);
      if (box && data && typeof data[pair[1]] === 'string') box.value = data[pair[1]];
    });
  }
  function setupAnalysisRules() {
    const button = byId('saveAnalysisRules');
    if (!button) return;
    if (window.erpStorage && typeof window.erpStorage.init === 'function') {
      Promise.resolve(window.erpStorage.init([ANALYSIS_KEY])).then(function () {
        fillAnalysisRules(window.erpStorage.get(ANALYSIS_KEY));
      }).catch(function () { setAnalysisState('数据分析规则读取失败，请重新登录后再试', true); });
    }
    button.addEventListener('click', function () {
      const payload = { analysisReasonRules: (byId('ruleAnalysisReason').value || '').trim(), orderAnalysisRules: (byId('ruleOrderAnalysis').value || '').trim(), todoRules: (byId('ruleTodo').value || '').trim() };
      const long = Object.keys(payload).filter(function (key) { return payload[key].length > 20000; });
      if (long.length) { setAnalysisState('单条规则不能超过 20000 字', true); return; }
      if (!window.erpStorage || typeof window.erpStorage.set !== 'function') { setAnalysisState('存储组件未加载，无法保存', true); return; }
      button.disabled = true;
      setAnalysisState('正在保存…');
      Promise.resolve(window.erpStorage.set(ANALYSIS_KEY, payload)).then(function () {
        setAnalysisState('已保存', false);
      }).catch(function (error) {
        setAnalysisState('保存失败：' + message(error, '请稍后重试，仍未成功请联系系统管理员。'), true);
      }).finally(function () { button.disabled = false; });
    });
  }
  function setCard(key, statusText, text, bad) {
    const parts = cardParts(key);
    if (!parts) return;
    parts.status.textContent = statusText;
    parts.output.textContent = text;
    parts.output.classList.toggle('is-failed', Boolean(bad));
  }
  function refreshGenerateButtons() {
    const busy = pendingGenerations > 0;
    byId('aiGenerateAll').disabled = busy;
    ITEM_ORDER.forEach(function (key) {
      const parts = cardParts(key);
      if (parts && parts.button) parts.button.disabled = busy;
    });
  }
  // 测试期参考图暂存：只存在浏览器本机。
  const REFERENCE_STASH_KEY = 'wyerp-ai-reference-images';
  function stashReferences() {
    const key = scopedStashKey(REFERENCE_STASH_KEY);
    if (!key) return;
    try { window.localStorage.setItem(key, JSON.stringify(referenceImages)); }
    catch (error) {
      setReferenceError('图片已全部显示在列表里，但浏览器存储空间不足，未能全部记住：请点某张图上的“移除”，或先“下载这张图”保存到本机');
    }
  }
  function restoreReferenceStash() {
    const key = scopedStashKey(REFERENCE_STASH_KEY);
    if (!key) return;
    let data = null;
    try { data = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (error) { data = null; }
    if (!Array.isArray(data)) return;
    data.slice(0, REFERENCE_MAX).forEach(function (item) {
      if (item && typeof item.dataUrl === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(item.dataUrl)) {
        referenceImages.push({ name: String(item.name || '参考图'), size: Number(item.size) || 0, type: String(item.type || ''), dataUrl: item.dataUrl });
      }
    });
  }
  const STASH_KEY = 'wyerp-ai-product-content-stash';

  // 主图素材检查（系统管理员测试台）：基础提示词取图片提示词里的生效主图模板。
  function fuseBox() { return document.getElementById('aiFuseBox'); }
  function buildFuseBox() {
    if (fuseBox()) return fuseBox();
    const panel = document.querySelector('[data-panel="image"]');
    if (!panel) return null;
    const box = el('div', 'ai-upload');
    box.id = 'aiFuseBox';
    const head = el('div', 'ai-upload-head');
    const title = el('strong');
    title.textContent = '主图素材检查（本地预览，不产生费用）';
    const state = el('span', 'ai-badge');
    state.id = 'aiFuseState';
    state.textContent = '未读取';
    head.append(title, state);
    const actions = el('div', 'ai-upload-actions');
    const read = el('button', 'ai-button');
    read.type = 'button'; read.id = 'aiFuseRead';
    read.textContent = '读取卖点提炼并预览融合提示词';
    const clear = el('button', 'ai-button');
    clear.type = 'button'; clear.id = 'aiFuseClear';
    clear.textContent = '清除暂存';
    actions.append(read, clear);
    const error = el('p', 'ai-help');
    error.id = 'aiFuseError';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const sellingNode = el('p', 'ai-help');
    sellingNode.id = 'aiFuseSelling';
    sellingNode.textContent = '商品优化暂存里的卖点提炼：未读取';
    const preview = el('textarea');
    preview.rows = 7;
    preview.readOnly = true;
    preview.id = 'aiFusePreview';
    preview.placeholder = '融合后的完整提示词显示在这里：生效主图提示词 + 卖点提炼';
    const note = el('p', 'ai-help');
    note.textContent = '生图时会把这段完整提示词连同上方上传的参考图一起发给供应商；提交之后还会单独显示“实际发送的提示词”和供应商回复供核对。';
    box.append(head, actions, error, sellingNode, preview, note);
    const anchorNode = panel.querySelector('.ai-info');
    if (anchorNode) panel.insertBefore(box, anchorNode);
    else panel.append(box);
    return box;
  }
  function setFuse(text, bad) {
    const box = buildFuseBox();
    if (!box) return;
    const node = document.getElementById('aiFuseState');
    node.textContent = text;
    node.style.color = bad ? 'var(--red)' : '';
  }
  function setFuseError(text) {
    const box = buildFuseBox();
    if (!box) return;
    const node = document.getElementById('aiFuseError');
    node.textContent = text || '';
    node.hidden = !text;
  }
  function readSellingStash() {
    const key = scopedStashKey(STASH_KEY);
    if (!key) return '';
    let data = null;
    try { data = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (error) { data = null; }
    const sellingNode = document.getElementById('aiFuseSelling');
    if (!sellingNode) { setFuse('素材检查区未就绪，请刷新页面后重试', true); return ''; }
    if (!data || typeof data !== 'object' || !data.candidates || typeof data.candidates.sellingPoints !== 'string' || !data.candidates.sellingPoints.trim()) {
      sellingNode.textContent = '商品优化暂存里的卖点提炼：暂无（先在商品优化页生成一次，让卖点提炼成功进入暂存）';
      setFuse('读不到卖点提炼', true);
      return '';
    }
    const selling = data.candidates.sellingPoints.trim();
    sellingNode.textContent = '商品优化暂存里的卖点提炼：已读到 ' + selling.length + ' 字（保存于 ' + new Date(data.savedAt || Date.now()).toLocaleString() + '）';
    setFuse('已读到卖点提炼', false);
    return selling;
  }
  function readContentStash() {
    const key = scopedStashKey(STASH_KEY);
    if (!key) return { facts: '', sellingPoints: '', title: '', tags: '', summary: '' };
    let data = null;
    try { data = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (error) { data = null; }
    if (!data || typeof data !== 'object') return { facts: '', sellingPoints: '', title: '', tags: '', summary: '' };
    const candidates = data.candidates || {};
    return { facts: String(data.facts || ''), title: String(candidates.title || ''), tags: String(candidates.tags || ''), summary: String(candidates.summary || ''), sellingPoints: String(candidates.sellingPoints || '') };
  }
  async function fuseWithModel(base) {
    const stash = readContentStash();
    return api('/api/domain/commands/ai-prompt-fuse', { method: 'POST', body: JSON.stringify({ template: base, sellingPoints: stash.sellingPoints, title: stash.title, tags: stash.tags, summary: stash.summary, facts: stash.facts }) });
  }
  function fusedPrompt(base, selling) {
    return base + '\n\n本图需体现的卖点（来自商品优化结果，只可照写，不得新增原始事实中没有的规格、数字或承诺）：\n' + selling;
  }
  function mainPromptDraft() {
    return getEffectiveBody('image-main');
  }
  function previewFusedPrompt() {
    setFuseError('');
    const selling = readSellingStash();
    const base = mainPromptDraft();
    if (!base) {
      setFuseError('还没有生效的主图提示词：请先在「图片提示词」里新增主图提示词');
      setFuse('缺少主图提示词', true);
      return;
    }
    if (!selling) return;
    document.getElementById('aiFusePreview').value = fusedPrompt(base, selling);
  }
  function setupFusePreview() {
    const box = buildFuseBox();
    if (!box) return;
    document.getElementById('aiFuseRead').addEventListener('click', previewFusedPrompt);
    document.getElementById('aiFuseClear').addEventListener('click', function () {
      const key = scopedStashKey(STASH_KEY);
      if (key) try { window.localStorage.removeItem(key); } catch (error) { void error; }
      document.getElementById('aiFuseSelling').textContent = '商品优化暂存里的卖点提炼：已清除';
      document.getElementById('aiFusePreview').value = '';
      setFuse('已清除暂存', false);
    });
  }
  function stashContent(facts, out) {
    const key = scopedStashKey(STASH_KEY);
    if (!key) return;
    try {
      window.localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), facts: facts, candidates: out.candidates || {}, failures: out.failures || {} }));
    } catch (error) { setGenerateError('暂存失败：当前浏览器不允许保存会话数据'); }
  }
  function restoreStash() {
    const key = scopedStashKey(STASH_KEY);
    if (!key) return;
    let data = null;
    try { data = JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (error) { data = null; }
    if (!data || typeof data !== 'object') return;
    if (data.facts && !byId('aiFacts').value.trim()) {
      byId('aiFacts').value = data.facts;
      byId('aiFactsBadge').textContent = String(data.facts).trim().length + ' 字（暂存）';
    }
    ITEM_ORDER.forEach(function (key) {
      if (data.candidates && typeof data.candidates[key] === 'string') setCard(key, '暂存（上次生成）', data.candidates[key]);
      else if (data.failures && data.failures[key]) setCard(key, '暂存（上次失败）', readableChineseMessage(data.failures[key].message, '上次生成未完成，请重新尝试。'), true);
    });
  }
  async function generate(keys) {
    setGenerateError('');
    const facts = byId('aiFacts').value.trim();
    if (!facts) { setGenerateError('请先填写商品原始事实'); return; }
    if (!paidConfirmed) {
      if (!window.confirm('将使用本租户 AI 账户余额生成候选，确认继续？')) return;
      paidConfirmed = true;
    }
    pendingGenerations += 1;
    refreshGenerateButtons();
    keys.forEach(function (key) { setCard(key, '生成中…', '正在按系统管理员规则生成候选'); });
    try {
      const out = await api(CONTENT_URL, { method: 'POST', body: JSON.stringify({ facts: facts, items: keys }) });
      keys.forEach(function (key) {
        if (out.candidates && typeof out.candidates[key] === 'string') setCard(key, '已生成（未采用）', out.candidates[key]);
        else if (out.failures && out.failures[key]) setCard(key, '失败', readableChineseMessage(out.failures[key].message, 'AI候选未生成，请稍后重试。'), true);
        else setCard(key, '未生成', 'AI 候选将在这里显示', true);
      });
      stashContent(facts, out);
      if (window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach(byId('aiGenerateError'), out.diagnosticId, api);
    } catch (error) {
      const reason = message(error, 'AI 候选生成失败');
      keys.forEach(function (key) { setCard(key, '失败', reason, true); });
      setGenerateError(reason);
      if (window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach(byId('aiGenerateError'), error.body && error.body.diagnosticId, api);
    } finally {
      pendingGenerations -= 1;
      refreshGenerateButtons();
    }
  }
  function showExchanges(exchanges, summary) {
    let dialog = byId('aiTestLogDialog');
    if (dialog) dialog.remove();
    dialog = document.createElement('dialog');
    dialog.id = 'aiTestLogDialog';
    dialog.className = 'ai-test-log';
    const head = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = '功能测试收发内容（密钥已打码）';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ai-button';
    close.textContent = '关闭';
    close.addEventListener('click', function () { dialog.close(); });
    head.append(title, close);
    const bodyBox = document.createElement('div');
    const resultLine = document.createElement('p');
    resultLine.className = 'ai-help';
    resultLine.textContent = summary || '';
    bodyBox.append(resultLine);
    if (!exchanges.length) {
      const empty = document.createElement('p');
      empty.className = 'ai-help';
      empty.textContent = '本次没有发出任何供应商请求（未产生费用）。';
      bodyBox.append(empty);
    }
    exchanges.forEach(function (item) {
      const block = document.createElement('pre');
      block.textContent = [
        item.kind + '（' + item.method + '）',
        '地址：' + item.url,
        '发送：' + item.request,
        '响应状态：' + item.status,
        '回复：' + item.response
      ].join('\n');
      bodyBox.append(block);
    });
    dialog.append(head, bodyBox);
    dialog.addEventListener('cancel', function () {});
    document.body.append(dialog);
    dialog.showModal();
  }
  async function functionalTest(rows, button) {
    setGenerateError('');
    if (!window.confirm('功能测试会发起真实请求并可能产生费用（文字模型发送“你好”，图片模型做一次文生图），确认继续？')) return;
    setBusy(button, true, '正在功能测试…');
    try {
      const targets = rows.filter(function (row) { return row.credentialsConfigured; });
      if (!targets.length) throw new Error('请先保存密钥');
      const outcomes = [];
      const exchanges = [];
      let failed = 0;
      for (const row of targets) {
        try {
          const outcome = await api(CONFIGURATIONS_URL + '/' + row.id + '/test', { method: 'POST', body: JSON.stringify({ kind: 'functional', confirmed: true }) });
          ((outcome && outcome.exchanges) || []).forEach(function (item) { exchanges.push(item); });
          outcomes.push(row.name + '：' + (row.section === 'product' ? '文字模型已回复' : '文生图已返回结果'));
        } catch (error) {
          failed += 1;
          ((error.body && error.body.exchanges) || []).forEach(function (item) { exchanges.push(item); });
          outcomes.push(row.name + '：' + message(error, '功能测试失败'));
        }
      }
      if (failed) flashIn('aiConfigListError', outcomes.join('；'), true);
      else flashIn('aiConfigListError', outcomes.join('；'));
      showExchanges(exchanges, outcomes.join('；'));
    } catch (error) {
      flashIn('aiConfigListError', message(error, '功能测试未完成'), true);
    } finally {
      setBusy(button, false);
    }
  }

  const REFERENCE_MAX = 8;
  const REFERENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const referenceImages = [];
  function setReferenceError(text) {
    const box = byId('aiReferenceError');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
  }
  function renderReferenceList() {
    const grid = byId('aiReferenceList');
    byId('aiReferenceCount').textContent = referenceImages.length + '/' + REFERENCE_MAX;
    grid.replaceChildren();
    referenceImages.forEach(function (item, index) {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.src = item.dataUrl;
      image.alt = item.name;
      image.title = '点击放大查看细节';
      image.classList.add('is-clickable');
      image.addEventListener('click', function () { openImageViewer(item); });
      const caption = document.createElement('figcaption');
      const label = document.createElement('span');
      label.textContent = item.name;
      label.dataset.aiTip = '文件名：' + item.name + '\n大小：' + Math.round(item.size / 1024) + ' KB';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ai-button';
      remove.textContent = '移除';
      remove.addEventListener('click', function () { referenceImages.splice(index, 1); renderReferenceList(); });
      caption.append(label, remove);
      figure.append(image, caption);
      grid.append(figure);
    });
    stashReferences();
  }
  function addReferenceFiles(files) {
    setReferenceError('');
    const list = Array.from(files || []);
    list.forEach(function (file) {
      if (referenceImages.length >= REFERENCE_MAX) { setReferenceError('最多上传 ' + REFERENCE_MAX + ' 张参考图'); return; }
      if (!REFERENCE_TYPES.includes(file.type)) { setReferenceError(file.name + '：只支持 JPG、PNG、WEBP'); return; }
      if (file.size > 10 * 1024 * 1024) { setReferenceError(file.name + '：单张不能超过 10MiB'); return; }
      const reader = new FileReader();
      reader.onload = function () {
        const dataUrl = String(reader.result || '');
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(dataUrl)) { setReferenceError(file.name + '：读取失败，请换一张'); return; }
        referenceImages.push({ name: file.name, size: file.size, type: file.type, dataUrl: dataUrl });
        renderReferenceList();
      };
      reader.onerror = function () { setReferenceError(file.name + '：读取失败'); };
      reader.readAsDataURL(file);
    });
  }
  function fusionDialog(base, selling, fused, out) {
    const old = byId('aiFusionDialog');
    if (old) old.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'aiFusionDialog';
    dialog.className = 'ai-test-log';
    const head = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = '融合结果预览（尚未发送，不产生费用）';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ai-button';
    close.textContent = '关闭';
    close.addEventListener('click', function () { dialog.close(); });
    head.append(title, close);
    const body = document.createElement('div');
    const summary = document.createElement('p');
    summary.className = 'ai-help';
    summary.textContent = '参考图 ' + referenceImages.length + ' 张 · 比例 1:1 · 模板 ' + base.length + ' 字 · 卖点 ' + selling.length + ' 字 · 融合后 ' + fused.length + ' 字' + (out && out.model ? ' · 融合模型 ' + out.model : '') + (out && out.unfilled && out.unfilled.length ? ' · 仍未填：' + out.unfilled.join('、') : '') + (out && out.drift ? ' · 注意：模型改动了模板文字，请对照①③核对' : '');
    body.append(summary);
    [['① 主图提示词模板（生效中的）', base], ['② 卖点提炼（商品优化暂存）', selling], ['③ 融合后将要原样发送的完整提示词', fused]].forEach(function (item) {
      const pre = document.createElement('pre');
      pre.textContent = item[0] + '\n' + item[1];
      body.append(pre);
    });
    const steps = document.createElement('p');
    steps.className = 'ai-help';
    steps.textContent = '注意：到这里还只是预览，没有生图。要出图必须点下面的蓝色按钮；出图通常需要 1-4 分钟，成功后图片会出现在「参考图」列表最后一张。';
    body.append(steps);
    const actions = document.createElement('div');
    actions.className = 'ai-upload-actions';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ai-button is-primary';
    go.textContent = '④ 就按这段提示词生图（点这里才会真的出图，消耗余额）';
    go.addEventListener('click', function () { dialog.close(); runMainImageGeneration(fused); });
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'ai-button';
    later.textContent = '先不生图（只是看融合结果）';
    later.addEventListener('click', function () { dialog.close(); });
    actions.append(go, later);
    body.append(actions);
    dialog.append(head, body);
    document.body.append(dialog);
    dialog.showModal();
  }
  async function runMainImageGeneration(fused) {
    const button = byId('aiReferenceGenerate');
    const startedAt = Date.now();
    setReferenceError('已提交生图，正在等待供应商返回（单次请求最长 120 秒，总计最长 5 分钟）…');
    const ticker = window.setInterval(function () {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      setReferenceError('生图进行中：已等待 ' + seconds + ' 秒（总计上限 5 分钟）。这一步会扣积分，请勿重复点击。');
    }, 10000);
    const watchdog = window.setTimeout(function () {
      setReferenceError('超过 5 分半仍未收到 ERP 服务响应：请到供应商控制台核对任务是否已完成，再决定是否重试（重试会再次扣积分）');
    }, 330000);
    if (button) { button.disabled = true; button.textContent = '生图中，已计时…'; }
    try {
      const out = await api('/api/domain/commands/ai-image-generate', { method: 'POST', body: JSON.stringify({ prompt: fused, aspectRatio: '1:1', images: referenceImages.map(function (item) { return item.dataUrl; }) }) });
      if (out && out.imageUrl) {
        referenceImages.push({ name: '生成候选 ' + new Date().toLocaleTimeString(), size: Math.round(out.imageUrl.length * 0.75), type: 'image/png', dataUrl: out.imageUrl, temp: true });
        renderReferenceList();
        setReferenceError('已生成 1 张候选图，已放进下方参考图列表，请看图是否有异常（模型 ' + out.model + '，用时 ' + out.seconds + ' 秒）');
      }
      showExchanges(out.exchanges || [], '本次实际发送与供应商回复（密钥已打码）');
    } catch (error) {
      setReferenceError('生图失败：' + message(error, '未知原因'));
      if (error.body && error.body.exchanges) showExchanges(error.body.exchanges, '本次请求与回复（密钥已打码）');
    } finally {
      window.clearInterval(ticker);
      window.clearTimeout(watchdog);
      if (button) { button.disabled = false; button.textContent = '融合预览并生图'; }
    }
  }
  async function generateMainImage() {
    setReferenceError('');
    let selling = '';
    let base = '';
    selling = readSellingStash();
    base = mainPromptDraft();
    if (!base) { setReferenceError('请先在「图片提示词」里新增并让主图提示词生效'); return; }
    if (!selling) { setReferenceError('读不到卖点提炼：先到「商品优化」生成一次，让卖点进入暂存'); return; }
    if (!referenceImages.length) { setReferenceError('请先在上方上传至少 1 张参考图'); return; }
    const button = byId('aiReferenceGenerate');
    if (button) { button.disabled = true; button.textContent = '正在用文字模型融合…'; }
    try {
      const out = await fuseWithModel(base);
      fusionDialog(base, selling, out.prompt, out);
    } catch (error) {
      setReferenceError('融合失败：' + message(error, '未知原因'));
    } finally {
      if (button) { button.disabled = false; button.textContent = '融合预览并生图'; }
    }
  }
  function setupReferenceUploads() {
    const input = byId('aiReferenceInput');
    byId('aiReferenceAdd').addEventListener('click', function () { input.click(); });
    byId('aiReferenceClear').addEventListener('click', function () { referenceImages.length = 0; setReferenceError(''); renderReferenceList(); });
    const generate = byId('aiReferenceGenerate');
    if (generate) generate.addEventListener('click', function () { generateMainImage(this); });
    input.addEventListener('change', function () { addReferenceFiles(this.files); this.value = ''; });
    const taskInput = byId('aiReferenceTask');
    const taskButton = byId('aiReferenceFetch');
    if (taskButton) taskButton.addEventListener('click', function () { fetchByTaskId(taskButton); });
    if (taskInput) taskInput.addEventListener('keydown', function (event) { if (event.key === 'Enter') { event.preventDefault(); fetchByTaskId(taskButton); } });
    restoreReferenceStash();
    renderReferenceList();
  }
  document.addEventListener('DOMContentLoaded', async function () {
    setupModals();
    byId('aiModuleNav').addEventListener('click', function (event) {
      const button = event.target.closest('button[data-module]');
      if (button) selectModule(button.dataset.module);
    });
    if (new URLSearchParams(location.search).get('preview') !== '1') {
      try { await readIdentity(); }
      catch (error) { flashIn('aiConfigListError', message(error, '无法确认登录身份'), true); return; }
      const sidebar = document.createElement('script');
      sidebar.src = '../assets/sidebar.js';
      document.body.appendChild(sidebar);
      byId('aiConfigAdd').addEventListener('click', function () { if (!configState.customizationAllowed && !configState.systemAdmin) return flashIn('aiConfigListError', '当前权限不允许修改AI服务', true); if (configState.standalone) return openLocalAiDialog(null); openConfigDialog(false); });
      byId('localAiPlatform').addEventListener('change', function () { const suggestion = LOCAL_PROVIDER_URLS[this.value]; if (suggestion) byId('localAiUrl').value = suggestion; });
      byId('localAiSave').addEventListener('click', saveLocalAiDialog);
      setupQuickImport();
      setupVendorDialog();
      byId('cfgSaveBtn').addEventListener('click', async function () {
        const saved = await saveConfig();
        if (!saved) return;
        closeModal('aiConfigDialog');
        await loadConfigurations();
        flashIn('aiConfigListError', 'AI 配置已保存');
      });
      byId('cfgTestBtn').addEventListener('click', async function () {
        const saved = await saveConfig();
        if (!saved) return;
        flashIn('cfgError', '已保存，正在测试连接…');
        await loadConfigurations();
        const grsRows = configState.configurations.filter(function (row) { return String(row.template || '').indexOf('grsai-') === 0; });
        try {
          const outcomes = await runConnectionTests(grsRows, byId('cfgTestBtn'));
          const failed = outcomes.filter(function (item) { return !item.ok; });
          flashIn('cfgError', outcomes.map(function (item) { return (item.ok ? '✓ ' : '✗ ') + item.text; }).join('；'), Boolean(failed.length));
        } catch (error) {
          flashIn('cfgError', message(error, '连接测试失败'), true);
        }
      });
      byId('cfgFunctionalTestBtn').addEventListener('click', async function () {
        const saved = await saveConfig();
        if (!saved) return;
        flashIn('cfgError', '已保存，正在执行功能测试…');
        await loadConfigurations();
        const grsRows = configState.configurations.filter(function (row) { return String(row.template || '').indexOf('grsai-') === 0; });
        await functionalTest(grsRows, byId('cfgFunctionalTestBtn'));
      });
      byId('aiPromptAdd').addEventListener('click', function () { openPromptDialog(null, null); });
      byId('ptSaveBtn').addEventListener('click', savePromptDialog);
      setupReferenceUploads();
      restoreStash();
      setupAnalysisRules();
      setupFusePreview();
      byId('aiRuleSave').addEventListener('click', function () { saveRules(); });
      byId('aiPricingSave').addEventListener('click', function () { savePricing(); });
      ['priceImageOriginal','priceImageDiscount','priceAnalysisOriginal','priceAnalysisDiscount'].forEach(function (id) { byId(id).addEventListener('input', renderPricingEffective); });
      byId('aiGenerateAll').addEventListener('click', function () { generate(ITEM_ORDER); });
      byId('aiFacts').addEventListener('input', function () {
        const length = this.value.trim().length;
        byId('aiFactsBadge').textContent = length ? length + ' 字' : '未输入';
      });
      document.querySelectorAll('[data-generate]').forEach(function (button) {
        button.addEventListener('click', function () { generate([this.dataset.generate]); });
      });
      try { erpStorage.init([]).catch(function () {}); } catch (error) { void error; }
      loadConfigurations().catch(function (error) {
        flashIn('aiConfigListError', message(error, '无法读取 AI 配置'), true);
      });
      loadPrompts().catch(function (error) {
        flashIn('aiPromptListError', message(error, '提示词读取失败'), true);
      });
      loadRules();
      loadPricing();
    }
  });
})();