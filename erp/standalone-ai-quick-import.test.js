'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, publicPreview } = require('./assets/ai-quick-import');
const sample = {name:'QA JSON 文本',type:'text',baseUrl:'https://api.example.com/v1',model:'sample-chat',apiKey:'qa-secret-do-not-display',default:true};
test('JSON one and batch import normalize client fields safely',()=>{
 const single = parse(JSON.stringify(sample));
 assert.equal(single.length,1);
 assert.equal(single[0].section,'product');
 assert.equal(single[0].model,'sample-chat');
 const rows = parse(JSON.stringify({providers:[sample,{name:'QA图片',type:'image',baseUrl:'https://another.example.com/v1',model:'another-model',apiKey:'qa-img-secret'}]}));
 assert.equal(rows.length,2);
 assert.equal(rows[1].protocol,'openai-image');
 assert.ok(!JSON.stringify(rows.map(publicPreview)).includes('qa-secret-do-not-display'));
 assert.ok(!JSON.stringify(rows.map(publicPreview)).includes('qa-img-secret'));
});
test('markdown fenced JSON and restricted export default JSON code supported',()=>{
 const src=JSON.stringify({providers:[sample]});
 const tick=String.fromCharCode(96).repeat(3);
 assert.equal(parse(tick+'json\n'+src+'\n'+tick)[0].model,'sample-chat');
 assert.equal(parse('export default '+src+';')[0].name,sample.name);
 assert.equal(parse(tick+'typescript\nexport default '+src+';\n'+tick)[0].name,sample.name);
});
test('OpenAI curl chat auto-identifies endpoint, model and secret',()=>{
 const src="curl 'https://api.deepseek.com/v1/chat/completions' -H 'Authorization: Bearer sk-test-not-real-123' -H 'Content-Type: application/json' -d '{\"model\":\"deepseek-chat\",\"messages\":[]}'";
 const row=parse(src)[0];
 assert.equal(row.baseUrl,'https://api.deepseek.com/v1');
 assert.equal(row.model,'deepseek-chat');
 assert.equal(row.apiKey,'sk-test-not-real-123');
 assert.equal(row.section,'product');
 assert.equal(publicPreview(row).key,'已填写（不回显）');
 assert.equal(JSON.stringify(publicPreview(row)).includes('sk-test'),false);
});
test('OpenAI curl image editing recognized but incompatible image generations rejected',()=>{
 const src="curl https://api.openai.com/v1/images/edits -H 'Authorization: Bearer sk-fake-xyz' -d '{\"model\":\"gpt-image-edit\"}'";
 assert.equal(parse(src)[0].section,'image');
 assert.throws(()=>parse(src.replace('images/edits','images/generations')),/仅识别/);
});
test('no executing JS/TS functions, no private or plain HTTP, no oversized or duplicate configs',()=>{
 assert.throws(()=>parse('export default {foo: () => process.exit() }'),/不执行/);
 assert.throws(()=>parse('const fs = require("fs")'),/仅接受/);
 assert.throws(()=>parse(JSON.stringify({...sample,baseUrl:'http://127.0.0.1:9999/v1'})),/HTTPS/);
 assert.throws(()=>parse(JSON.stringify({providers:[sample,sample]})),/重复/);
 assert.throws(()=>parse('x'.repeat(60001)),/不超过/);
 assert.throws(()=>parse(JSON.stringify({...sample,apiKey:''})),/名称、模型ID和密钥/);
 assert.throws(()=>parse(JSON.stringify({...sample,type:'video'})),/text 或 image/);
});