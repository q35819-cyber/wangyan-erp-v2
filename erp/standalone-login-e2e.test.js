'use strict';
// Isolated local QA only; operates the same login form a user sees, including the displayed SVG challenge.
// This test never bypasses CAPTCHA validation and never touches the user's regular ERP instances.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.WYERP_QA_BASE || 'http://127.0.0.1:18784';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Refusing non-loopback QA server');
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(base + '/login.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => (document.querySelector('#captchaImage')?.getAttribute('src') || '').startsWith('data:image/svg+xml;base64,'), null, { timeout: 20000 });
    const visibleChallenge = await page.locator('#captchaImage').evaluate(img => {
      const svg = atob(img.getAttribute('src').split(',')[1]);
      return [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(m => m[1]).join('');
    });
    assert.ok(visibleChallenge.length >= 4 && visibleChallenge.length <= 6, 'Visible CAPTCHA characters were not read');
    await page.locator('#identifier').fill('admin');
    await page.locator('#password').fill('123456');
    await page.locator('#captchaAnswer').fill(visibleChallenge);
    await page.locator('#submitBtn').click();
    await page.waitForURL(/\/workspace\.html/, { timeout: 25000 });
    const me = await page.evaluate(async () => {
      const resp = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      return { status: resp.status, data: await resp.json() };
    });
    assert.equal(me.status, 200, 'Session /api/auth/me must return 200');
    assert.equal(String(me.data.username).toLowerCase(), 'admin', 'Signed-in admin expected');
    await page.waitForTimeout(1000);
    assert.deepEqual(pageErrors, [], 'No uncaught browser JS exceptions after login');
    console.log('PASS Edge browser admin/123456, user CAPTCHA, redirect to workspace, session');
    for (const route of ['/pages/goods.html', '/pages/goods-online.html', '/pages/orders.html', '/pages/shops.html', '/pages/account-security.html']) {
      const response = await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
      assert.equal(response.status(), 200, route + ' should be a real authenticated page');
      assert.ok(!page.url().includes('/login.html'), route + ' unexpectedly redirected to login');
      await page.waitForTimeout(500);
      console.log('PASS authenticated basic page ' + route);
    }
    assert.deepEqual(pageErrors, [], 'No uncaught browser JS exceptions after basic navigation');
    console.log('PASS Edge smoke: all five basic ERP pages and zero page JS errors');


    // Test the actual workspace iframe, not the outer workspace shell.
    if (['http://127.0.0.1:18786', 'http://127.0.0.1:18787'].includes(base)) {
      await page.goto(base + '/workspace.html?open=pages%2Fgoods.html', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => [...document.querySelectorAll('iframe.workspace-frame')]
        .some(f => f.contentDocument?.getElementById('createBtn')), null, { timeout: 25000 });
      const goods = page.frameLocator('iframe.workspace-frame:not([hidden])');
      await goods.locator('#createBtn').waitFor({ state: 'visible', timeout: 20000 });
      await page.waitForFunction(() => {
        const f = document.querySelector('iframe.workspace-frame:not([hidden])');
        const button = f?.contentDocument?.getElementById('createBtn');
        return button && button.disabled === false;
      }, null, { timeout: 20000 });
      const label = await goods.locator('#collectionBoxMembershipQuota').innerText();
      assert.ok(!label.includes('读取失败'), 'collection quota must load');
      assert.ok(!label.includes('采集箱会员额度'), 'standalone must not require membership quota');
      await goods.locator('#createBtn').click();
      assert.ok(await goods.locator('#editor').evaluate(node => node.open), 'manual collection editor must open');
      await goods.locator('#cancelBtn').click();
      console.log('PASS Edge workspace collection: create enabled and editor opens without membership');

      if (process.env.WYERP_QA_COLLECTION_WRITE === '1') {
        const baseline = await goods.locator('body').evaluate(async () => {
          const r = await window.erpStorage.request('/api/data/erp_collected_products');
          return { status: r.status, rows: r.status === 404 ? [] : await r.json() };
        });
        assert.ok([200, 404].includes(baseline.status), 'empty new collection may not have a document yet');
        assert.ok(Array.isArray(baseline.rows), 'collection API must return an array');
        assert.ok(baseline.rows.every(item => String(item?.title || '').startsWith('QA16-临时复测商品-')),
          'refuse to modify QA16 when non-test collection data exists');
        for (const oldRow of baseline.rows) {
          page.once('dialog', dialog => dialog.accept());
          await goods.locator('#collectBody tr').filter({ hasText: oldRow.title }).locator('.remove-btn').click();
          await goods.locator('#collectBody tr').filter({ hasText: oldRow.title }).waitFor({ state: 'detached', timeout: 15000 });
        }
        console.log('PASS pre-test safety check: cleared only old QA16 synthetic markers');
        const marker = 'QA16-临时复测商品-' + Date.now();
        await goods.locator('#createBtn').click();
        await goods.locator('#editTitle').fill(marker);
        await goods.locator('#editPrice').fill('19.90');
        await goods.locator('#editSkuCount').fill('1');
        await goods.locator('#editorForm button[type=submit]').click();
        await goods.locator('#editor').waitFor({ state: 'hidden', timeout: 20000 });
        await goods.locator('body').evaluate(() => location.reload());
        await goods.locator('#collectBody tr').filter({ hasText: marker }).waitFor({ state: 'visible', timeout: 25000 });
        const stored = await goods.locator('body').evaluate(async (_body, name) => {
          const r = await window.erpStorage.request('/api/data/erp_collected_products');
          const rows = await r.json();
          return { status: r.status, matching: rows.filter(item => item.title === name), titles: rows.map(item => item.title), tenant: window.erpStorage.getSelectedTenantId() };
        }, marker);
        console.log('COLLECTION_STORED_DIAG ' + JSON.stringify(stored));
        assert.equal(stored.status, 200);
        assert.equal(stored.matching.length, 1, 'collection product persists after reload');
        page.once('dialog', dialog => dialog.accept());
        await goods.locator('#collectBody tr').filter({ hasText: marker }).locator('.remove-btn').click();
        await goods.locator('#collectBody tr').filter({ hasText: marker }).waitFor({ state: 'detached', timeout: 15000 });
        const afterDelete = await goods.locator('body').evaluate(async (_body, name) => {
          const r = await window.erpStorage.request('/api/data/erp_collected_products');
          const rows = await r.json();
          return { status: r.status, remaining: rows.filter(item => item.title === name).length };
        }, marker);
        assert.equal(afterDelete.status, 200);
        assert.equal(afterDelete.remaining, 0, 'QA test item must be deleted from database');
        console.log('PASS isolated QA16 GUI create, PostgreSQL persistence, GUI delete and cleanup');
      }
    }

    if (process.env.WYERP_QA_AI_CONFIG === '1' && ['http://127.0.0.1:18789', 'http://127.0.0.1:18790'].includes(base)) {
      await page.goto(base + '/workspace.html?open=pages%2Fai-config.html', { waitUntil: 'domcontentloaded' });
      const ai = page.frameLocator('iframe.workspace-frame:not([hidden])');
      await ai.locator('#aiConfigAdd').waitFor({ state: 'visible', timeout: 16000 });
      await page.waitForFunction(() => {
        const f = document.querySelector('iframe.workspace-frame:not([hidden])');
        return f?.contentDocument?.getElementById('aiConfigAdd')?.disabled === false;
      }, null, { timeout: 20000 });
      await ai.locator('#aiConfigAdd').click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'visible' });
      await ai.locator('#localAiName').fill('QA19_DYNAMIC_AI_TEXT');
      await ai.locator('#localAiType').selectOption('product');
      await ai.locator('#localAiPlatform').selectOption('deepseek');
      await ai.locator('#localAiUrl').fill('https://api.deepseek.com/v1');
      await ai.locator('#localAiModel').fill('qa-customer-custom-model');
      await ai.locator('#localAiKey').fill('qa-placeholder-not-a-real-credential');
      await ai.locator('#localAiSave').click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'hidden', timeout: 20000 });
      const configData = await page.evaluate(async () => {
        const response = await fetch('/api/integrations/ai/configurations', { credentials: 'same-origin' });
        return { status: response.status, value: await response.json() };
      });
      assert.equal(configData.status, 200);
      const row = configData.value.configurations.find(item => item.name === 'QA19_DYNAMIC_AI_TEXT');
      assert.ok(row, 'custom AI platform is persisted');
      assert.equal(row.template, 'custom-product');
      assert.equal(row.model.name, 'qa-customer-custom-model');
      assert.equal(row.credentialsConfigured, true);
      assert.ok(row.defaultCapabilities.includes('title-optimization'));
      assert.equal(JSON.stringify(configData.value).includes('qa-placeholder-not-a-real-credential'), false);
      console.log('PASS GUI self-configured provider URL, model, encrypted key and usage assignment');
      await ai.locator('#aiConfigList tr').filter({ hasText: 'QA19_DYNAMIC_AI_TEXT' }).getByRole('button', { name: '编辑' }).click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'visible' });
      assert.equal(await ai.locator('#localAiKey').inputValue(), '');
      await ai.locator('#localAiModel').fill('qa-customer-model-edited');
      await ai.locator('#localAiDefault').uncheck();
      await ai.locator('#localAiSave').click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'hidden', timeout: 15000 });
      const edited = await page.evaluate(async () => (await (await fetch('/api/integrations/ai/configurations')).json()).configurations.find(r => r.name === 'QA19_DYNAMIC_AI_TEXT'));
      assert.equal(edited.model.name, 'qa-customer-model-edited');
      assert.equal(edited.credentialsConfigured, true);
      console.log('PASS GUI edit model preserves existing hidden credential');
      await ai.locator('#aiConfigAdd').click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'visible' });
      await ai.locator('#localAiName').fill('QA19_DYNAMIC_AI_IMAGE');
      await ai.locator('#localAiType').selectOption('image');
      await ai.locator('#localAiPlatform').selectOption('openai');
      await ai.locator('#localAiUrl').fill('https://api.openai.com/v1');
      await ai.locator('#localAiModel').fill('qa-arbitrary-image-model');
      await ai.locator('#localAiKey').fill('qa-placeholder-image-credential');
      await ai.locator('#localAiSave').click();
      await ai.locator('#aiLocalConfigDialog').waitFor({ state: 'hidden', timeout: 15000 });
      const images = await page.evaluate(async () => (await (await fetch('/api/integrations/ai/configurations')).json()).configurations);
      const image = images.find(r => r.name === 'QA19_DYNAMIC_AI_IMAGE');
      assert.ok(image && image.protocol === 'openai-image');
      assert.equal(image.model.name, 'qa-arbitrary-image-model');
      assert.ok(image.defaultCapabilities.includes('image-redraw'));
      assert.equal(JSON.stringify(images).includes('qa-placeholder-image-credential'), false);
      console.log('PASS GUI image platform and customer model assigned');
      page.once('dialog', dialog => dialog.accept());
      await ai.locator('#aiConfigList tr').filter({ hasText: 'QA19_DYNAMIC_AI_IMAGE' }).getByRole('button', { name: '删除' }).click();
      await page.waitForFunction(async () => !(await (await fetch('/api/integrations/ai/configurations')).json()).configurations.some(r => r.name === 'QA19_DYNAMIC_AI_IMAGE'));
      page.once('dialog', dialog => dialog.accept());
      await ai.locator('#aiConfigList tr').filter({ hasText: 'QA19_DYNAMIC_AI_TEXT' }).getByRole('button', { name: '删除' }).click();
      await page.waitForFunction(async () => {
        const response = await fetch('/api/integrations/ai/configurations', { credentials: 'same-origin' });
        const data = await response.json();
        return !data.configurations.some(item => item.name === 'QA19_DYNAMIC_AI_TEXT');
      }, null, { timeout: 15000 });
      console.log('PASS GUI delete temporary QA19 AI provider');
    }

    if (process.env.WYERP_QA_AI_QUICK === '1' && ['http://127.0.0.1:18790','http://127.0.0.1:18791'].includes(base)) {
      await page.goto(base + '/workspace.html?open=pages%2Fai-config.html', { waitUntil: 'domcontentloaded' });
      const ai = page.frameLocator('iframe.workspace-frame:not([hidden])');
      await ai.locator('#aiQuickImport').waitFor({state:'visible',timeout:20000});
      const prefix = 'QA_QUICK_20261023_';
      const models = {
        providers: [
          {name:prefix+'TEXT',type:'text',baseUrl:'https://api.deepseek.com/v1',model:'test-quick-chat',apiKey:'qa-secret-fast-text',default:true},
          {name:prefix+'IMAGE',type:'image',baseUrl:'https://api.openai.com/v1',model:'test-quick-image',apiKey:'qa-secret-fast-image',default:true}
        ]
      };
      await ai.locator('#aiQuickImport').click();
      await ai.locator('#aiQuickImportDialog').waitFor({state:'visible'});
      await ai.locator('#aiQuickCode').fill(JSON.stringify(models));
      await ai.locator('#aiQuickPreview').click();
      const preview = await ai.locator('#aiQuickPreviewOutput').innerText();
      assert.ok(preview.includes(prefix+'TEXT') && preview.includes(prefix+'IMAGE'));
      assert.equal(preview.includes('qa-secret-fast'),false,'No keys should appear in import preview');
      await ai.locator('#aiQuickApply').click();
      await ai.locator('#aiQuickImportDialog').waitFor({state:'hidden',timeout:25000});
      const result = await page.evaluate(async()=>await (await fetch('/api/integrations/ai/configurations')).json());
      assert.equal(result.standalone,true);
      for(const expected of models.providers){
        const row=result.configurations.find(r=>r.name===expected.name);
        assert.ok(row, 'Imported model missing '+expected.name);
        assert.equal(row.model.name,expected.model);
        assert.equal(row.credentialsConfigured,true);
        assert.ok(row.defaultCapabilities.length>0, 'Default assignments missing');
      }
      assert.equal(JSON.stringify(result).includes('qa-secret-fast'),false,'Encrypted credentials not displayed');
      console.log('PASS Edge JSON batch import text+image, capabilities, credential redaction');
      await ai.locator('#aiQuickImport').click();
      const curl="curl https://api.deepseek.com/v1/chat/completions -H 'Authorization: Bearer sk-qa-curl-secret-1234' -d '{\"model\":\"deepseek-chat\"}'";
      await ai.locator('#aiQuickCode').fill(curl);
      await ai.locator('#aiQuickPreview').click();
      const curlPreview=await ai.locator('#aiQuickPreviewOutput').innerText();
      assert.ok(curlPreview.includes('deepseek-chat'));
      assert.equal(curlPreview.includes('sk-qa-curl'),false);
      await ai.locator('#aiQuickApply').click();
      await ai.locator('#aiQuickImportDialog').waitFor({state:'hidden',timeout:16000});
      assert.ok((await page.evaluate(async()=>await (await fetch('/api/integrations/ai/configurations')).json())).configurations.some(r=>r.name==='cURL 文本模型'));
      console.log('PASS Edge curl paste auto-identify and import');
      await ai.locator('#aiQuickImport').click();
      const file=JSON.stringify({name:prefix+'FILE_PREVIEW',type:'text',baseUrl:'https://api.example.com/v1',model:'file-model',apiKey:'qa-file-secret'});
      await ai.locator('#aiQuickFile').setInputFiles({name:'model.json',mimeType:'application/json',buffer:Buffer.from(file)});
      assert.ok((await ai.locator('#aiQuickPreviewOutput').innerText()).includes(prefix+'FILE_PREVIEW'));
      assert.equal((await ai.locator('#aiQuickPreviewOutput').innerText()).includes('qa-file-secret'),false);
      console.log('PASS Edge local JSON file input preview without disclosure');
      await ai.locator('#aiQuickImportDialog [data-modal-close]').first().click();
      await ai.locator('#aiQuickImportDialog').waitFor({state:'hidden'});
      const remaining=[prefix+'TEXT',prefix+'IMAGE','cURL 文本模型'];
      for(const name of remaining){
        page.once('dialog',dlg=>dlg.accept());
        await ai.locator('#aiConfigList tr').filter({hasText:name}).getByRole('button',{name:'删除'}).click();
        await page.waitForFunction(async name=>{
          const r=await fetch('/api/integrations/ai/configurations');
          const json=await r.json();
          return !(json.configurations||[]).some(item=>item.name===name);
        },name,{timeout:14000});
      }
      console.log('PASS Edge quick import cleanup temporary AI models');
    }

    if (process.env.WYERP_QA_AI_VENDOR === '1' && ['http://127.0.0.1:18791','http://127.0.0.1:18792'].includes(base)) {
      await page.goto(base+'/workspace.html?open=pages%2Fai-config.html',{waitUntil:'domcontentloaded'});
      const ai=page.frameLocator('iframe.workspace-frame:not([hidden])');
      await ai.locator('#aiVendorNew').waitFor({state:'visible',timeout:16000});
      await page.waitForFunction(()=>document.querySelector('iframe.workspace-frame:not([hidden])')?.contentDocument?.getElementById('aiVendorNew')?.disabled===false,null,{timeout:20000});
      const name='QA_VENDOR_TEXT_20261023';
      const textProgram={version:1,request:{method:'POST',path:'/v2/custom/text',auth:'x-api-key',body:{engine:'{{model}}',body:'{{inputJson}}',system:'{{system}}'}},response:{textPath:'result.answer'}};
      await ai.locator('#aiVendorNew').click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'visible'});
      await ai.locator('#vendorName').fill(name);
      await ai.locator('#vendorSection').selectOption('product');
      await ai.locator('#vendorUrl').fill('https://provider.example.com');
      await ai.locator('#vendorModel').fill('QA-CUSTOM-FUNCTION-MODEL');
      await ai.locator('#vendorKey').fill('QA-SYNTHETIC-TEST-NO-REAL-KEY');
      await ai.locator('#vendorCode').fill(JSON.stringify(textProgram));
      await ai.locator('#vendorJsonCheck').click();
      await ai.locator('#vendorSave').click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'hidden',timeout:16000});
      const getConfigs=()=>page.evaluate(async()=>await (await fetch('/api/integrations/ai/configurations')).json());
      let result=await getConfigs();
      let row=result.configurations.find(r=>r.name===name);
      assert.ok(row,'Vendor text row not persisted '+JSON.stringify(result));
      assert.equal(row.protocol,'custom-structured');
      assert.equal(row.model.adapter.request.path,'/v2/custom/text');
      assert.equal(row.credentialsConfigured,true);
      assert.ok(row.defaultCapabilities.includes('title-optimization'));
      assert.ok(!JSON.stringify(result).includes('QA-SYNTHETIC-TEST-NO-REAL-KEY'));
      console.log('PASS GUI vendor program saved securely and assigned to business capabilities');
      await ai.locator('#aiConfigList tr').filter({hasText:name}).getByRole('button',{name:'编辑'}).click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'visible'});
      assert.equal(await ai.locator('#vendorKey').inputValue(),'');
      await ai.locator('#vendorCode').fill(JSON.stringify({...textProgram,response:{textPath:'output.message'}}));
      await ai.locator('#vendorDefault').uncheck();
      await ai.locator('#vendorSave').click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'hidden',timeout:16000});
      result=await getConfigs();
      row=result.configurations.find(r=>r.name===name);
      assert.equal(row.model.adapter.response.textPath,'output.message');
      assert.equal(row.credentialsConfigured,true);
      console.log('PASS GUI edit vendor protocol without reentering encrypted key');
      await ai.locator('#aiVendorNew').click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'visible'});
      await ai.locator('#vendorName').fill('QA_VENDOR_IMAGE_20261023');
      await ai.locator('#vendorSection').selectOption('image');
      await ai.locator('#vendorUrl').fill('https://provider.example.com');
      await ai.locator('#vendorModel').fill('QA-CUSTOM-IMAGE');
      await ai.locator('#vendorKey').fill('QA-SYNTHETIC-IMAGE-NO-REAL-KEY');
      const imageProgram={version:1,request:{method:'POST',path:'/v2/jobs',auth:'bearer',body:{model:'{{model}}',input:'{{image}}',prompt:'{{prompt}}'}},response:{taskPath:'job.id',imagePath:'job.url'},poll:{path:'/v2/jobs/{{taskId}}',response:{imagePath:'image.url'}}};
      await ai.locator('#vendorCode').fill(JSON.stringify(imageProgram));
      await ai.locator('#vendorSave').click();
      await ai.locator('#aiVendorAdapterDialog').waitFor({state:'hidden',timeout:16000});
      result=await getConfigs();
      const img=result.configurations.find(r=>r.name==='QA_VENDOR_IMAGE_20261023');
      assert.ok(img);
      assert.equal(img.protocol,'custom-structured');
      assert.ok(img.defaultCapabilities.includes('image-redraw'));
      assert.ok(!JSON.stringify(result).includes('QA-SYNTHETIC-IMAGE-NO-REAL-KEY'));
      console.log('PASS GUI image vendor async submit and poll rules accepted');
      for(const target of [name,'QA_VENDOR_IMAGE_20261023']){
        page.once('dialog',dlg=>dlg.accept());
        await ai.locator('#aiConfigList tr').filter({hasText:target}).getByRole('button',{name:'删除'}).click();
        await page.waitForFunction(async n=>!(await (await fetch('/api/integrations/ai/configurations')).json()).configurations.some(r=>r.name===n),target,{timeout:12000});
      }
      console.log('PASS vendor QA records deleted');
    }
    if (process.env.WYERP_QA_FULL_BUSINESS === '1') {
      const { runBusinessQA } = require('./standalone-full-business-qa');
      const result = await runBusinessQA({ context, base });
      if (process.env.WYERP_QA_FULL_REPORT) {
        require('node:fs').writeFileSync(process.env.WYERP_QA_FULL_REPORT, JSON.stringify(result, null, 2), 'utf8');
      }
      const failed = result.filter(x => x.status === 'FAIL');
      console.log('FULL_BUSINESS_RESULTS ' + (result.length - failed.length) + '/' + result.length + ' PASS');
      if (failed.length) process.exitCode = 1;
    }
    if (process.env.WYERP_QA_FULL_PAGES === '1') {
      const { runPageAudit } = require('./standalone-full-pages-qa');
      const result = await runPageAudit({ context, base });
      if (process.env.WYERP_QA_PAGE_REPORT) require('node:fs').writeFileSync(
        process.env.WYERP_QA_PAGE_REPORT, JSON.stringify(result,null,2), 'utf8');
      if (result.some(x=>x.status==='FAIL')) process.exitCode = 1;
    }
  } finally { await browser.close(); }
})().catch(err => { console.error('FAIL QA browser login', String(err)); process.exitCode = 1; });