'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ai = require('./auth/ai-config');
const { canUseAiConfiguration } = require('./auth/ai-config-store');
const key = crypto.randomBytes(32);
const tenantId='11111111-1111-4111-8111-111111111111';
const ownerUserId='22222222-2222-4222-8222-222222222222';
const sample={
 name:'客户自选 DeepSeek',section:'product',template:'custom-product',
 protocol:'openai-chat-completions',baseUrl:'https://api.deepseek.com/v1',
 model:{name:'deepseek-custom-2026'},apiKey:'qa-never-real-token',
 capabilities:['product-translation','title-optimization','description-optimization',
 'selling-point-generation','attribute-text-optimization'],enabled:true
};
test('SaaS keeps rejecting custom provider configs without standalone flag',()=>{
 assert.throws(()=>ai.normalize(sample,{tenantId,ownerUserId,key}),e=>e.publicCode==='invalid_ai_template');
});
test('standalone accepts arbitrary OpenAI-compatible model ID, encrypts key and redacts output',()=>{
 const row=ai.normalize(sample,{tenantId,ownerUserId,key,allowCustom:true});
 assert.equal(row.model.name,'deepseek-custom-2026');
 assert.equal(row.baseUrl,'https://api.deepseek.com/v1');
 assert.ok(row.encryptedApiKey && JSON.stringify(row.encryptedApiKey).indexOf(sample.apiKey)===-1);
 const mock={...row,tenant_id:tenantId,owner_user_id:ownerUserId,encrypted_api_key:row.encryptedApiKey};
 assert.equal(ai.decrypt(mock,key),sample.apiKey);
 const safe=ai.redact(mock);
 assert.equal(safe.credentialsConfigured,true);
 assert.equal('encrypted_api_key' in safe,false);
 assert.equal('apiKey' in safe,false);
 assert.equal(JSON.stringify(safe).includes(sample.apiKey),false);
 assert.equal(canUseAiConfiguration({...mock,ai_allowed:true},['title-optimization'],{isOwner:true,allowCustom:true}),true);
 assert.equal(canUseAiConfiguration({...mock,ai_allowed:true},['title-optimization'],{isOwner:true}),false);
});
test('custom image protocol, arbitrary model and encrypted credential supported',()=>{
 const row=ai.normalize({...sample,section:'image',template:'custom-image',protocol:'openai-image',
   model:{name:'customer-image-model-id'},capabilities:['image-translation','image-redraw','image-repair']},
   {tenantId,ownerUserId,key,allowCustom:true});
 assert.equal(row.model.name,'customer-image-model-id');
 assert.equal(canUseAiConfiguration({...row,encrypted_api_key:row.encryptedApiKey},['image-redraw'],{isOwner:true,allowCustom:true}),true);
});
test('invalid insecure URLs, protocols and unsupported templates are rejected',()=>{
 for(const patch of [
  {baseUrl:'http://localhost:9000/v1'},
  {baseUrl:'https://127.0.0.1/v1'},
  {protocol:'grsai-gemini-generate'},
  {template:'agentrouter-product'}
 ]){
  assert.throws(()=>ai.normalize({...sample,...patch},{tenantId,ownerUserId,key,allowCustom:true}));
 }
});
test('editing retains encrypted key when password input is empty',()=>{
 const initial=ai.normalize(sample,{tenantId,ownerUserId,key,allowCustom:true});
 const existing={...initial,encrypted_api_key:initial.encryptedApiKey};
 const updated=ai.normalize({...sample,apiKey:'',name:'已修改',model:{name:'new-user-model'}},
  {tenantId,ownerUserId,key,allowCustom:true,existing});
 assert.deepEqual(updated.encryptedApiKey,initial.encryptedApiKey);
 assert.equal(updated.model.name,'new-user-model');
 assert.equal(updated.name,'已修改');
});

test('custom OpenAI-compatible image adapter accepts base64 result without paid network request',async()=>{
 const provider=require('./auth/ai-provider');
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxI8AAAAASUVORK5CYII=';
 const source='data:image/png;base64,'+png;
 const config={section:'image',protocol:'openai-image',base_url:'https://provider.example/v1',
   model:{name:'customer-image-model'},capabilities:['image-redraw'],timeout_ms:5000};
 const called=[];
 const result=await provider.generateImage({
   configuration:config,apiKey:'synthetic-only',input:{capability:'image-redraw',image:source,prompt:'QA synthetic image'},
   lookup:async()=>[{address:'8.8.8.8',family:4}],
   fetchImpl:async (url,options)=>{
     called.push({url,method:options.method,type:options.headers['Content-Type']});
     return new Response(JSON.stringify({data:[{b64_json:png}]}),{status:200,headers:{'content-type':'application/json'}});
   }
 });
 assert.equal(called.length,1);
 assert.equal(called[0].url,'https://provider.example/v1/images/edits');
 assert.equal(called[0].method,'POST');
 assert.match(called[0].type,/multipart\/form-data/);
 assert.equal(result.state,'succeeded');
 const downloaded=await provider.downloadImage(result.resultUrl);
 assert.equal(downloaded.mime,'image/png');
 assert.ok(downloaded.buffer.length>50);
});
