'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const adapter=require('./auth/ai-vendor-adapter');
const config=require('./auth/ai-config');
const provider=require('./auth/ai-provider');
const tenantId='11111111-1111-4111-8111-111111111111',ownerUserId='22222222-2222-4222-8222-222222222222',key=crypto.randomBytes(32);
const textProgram={version:1,request:{method:'POST',path:'/v2/custom/text',auth:'x-api-key',body:{engine:'{{model}}',payload:{prompt:'{{system}}',details:'{{inputJson}}'}}},response:{textPath:'result.message'}};
const imageProgram={version:1,request:{method:'POST',path:'/v2/media/submit',auth:'bearer',body:{engine:'{{model}}',image:'{{image}}',prompt:'{{prompt}}'}},response:{imagePath:'data.url',taskPath:'data.job_id',statusPath:'data.status'},poll:{path:'/v2/media/result/{{taskId}}',response:{imagePath:'data.url',statusPath:'data.status'}}};
const source=(section,program)=>({name:'QA customer custom vendor',section,protocol:'custom-structured',template:section==='product'?'custom-product':'custom-image',baseUrl:'https://platform.example.com',apiKey:'qa-synthetic-secret',enabled:true,model:{name:'their-private-model-id',adapter:program},capabilities:section==='product'?['title-optimization']:['image-redraw']});
const opts={key,tenantId,ownerUserId,allowCustom:true};
const lookup=async()=>[{address:'8.8.8.8',family:4}];
test('structured vendor keeps AES encrypted and redacts key with arbitrary protocol',()=>{
 const out=config.normalize(source('product',textProgram),opts);
 assert.equal(out.protocol,'custom-structured');
 assert.equal(out.model.adapter.request.path,'/v2/custom/text');
 assert.equal(config.decrypt({...out,tenant_id:tenantId,owner_user_id:ownerUserId,encrypted_api_key:out.encryptedApiKey},key),'qa-synthetic-secret');
 assert.equal(JSON.stringify(config.redact(out)).includes('qa-synthetic-secret'),false);
 assert.throws(()=>config.normalize(source('product',textProgram),{...opts,allowCustom:false}),/单机版|模板/);
});
test('a model outside OpenAI protocol receives customized HTTP request and custom response path',async()=>{
 const row=config.normalize(source('product',textProgram),opts);
 let called;
 const reply=await provider.chat({configuration:{...row,base_url:row.baseUrl,timeout_ms:5000},apiKey:'qa-test-secret',system:'Explain brief',input:{title:'Item'},capabilities:['title-optimization'],lookup,
 fetchImpl:async(url,init)=>{called={url,method:init.method,headers:init.headers,body:JSON.parse(init.body)};return new Response(JSON.stringify({result:{message:'{"title":"OK"}'}}),{status:200,headers:{'content-type':'application/json'}})}});
 assert.equal(reply,'{"title":"OK"}');
 assert.equal(called.url,'https://platform.example.com/v2/custom/text');
 assert.equal(called.headers['X-API-Key'],'qa-test-secret');
 assert.equal(called.body.payload.details,'{"title":"Item"}');
 assert.equal(called.body.engine,'their-private-model-id');
});
test('image custom provider handles asynchronous submit and poll with safe public URL',async()=>{
 const row=config.normalize(source('image',imageProgram),opts);
 const configuration={...row,base_url:row.baseUrl,timeout_ms:5000};
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxI8AAAAASUVORK5CYII=';
 const requests=[];
 const mock=async (url,init)=>{requests.push({url,method:init.method,headers:init.headers,body:init.body&&JSON.parse(init.body)});return new Response(JSON.stringify(url.includes('/submit')?{data:{job_id:'j123',status:'pending'}}:{data:{url:'https://cdn.example.com/abc.png',status:'succeeded'}}),{status:200,headers:{'content-type':'application/json'}})};
 const submitted=await provider.submitImage({configuration,apiKey:'qa-test-secret',input:{capability:'image-redraw',image:png,prompt:'enhance'},fetchImpl:mock,lookup});
 assert.equal(submitted.state,'submitted');assert.equal(submitted.taskId,'j123');
 const polled=await provider.pollImage({configuration,apiKey:'qa-test-secret',taskId:'j123',fetchImpl:mock,lookup});
 assert.equal(polled.state,'succeeded');assert.equal(polled.resultUrl,'https://cdn.example.com/abc.png');
 assert.equal(requests[0].url,'https://platform.example.com/v2/media/submit');
 assert.equal(requests[1].url,'https://platform.example.com/v2/media/result/j123');
});

test('paid custom image functional test requires explicit consent and verifies async result',async()=>{
 const row=config.normalize(source('image',imageProgram),opts);
 const configuration={...row,base_url:row.baseUrl,timeout_ms:5000};
 const mock=async url=>new Response(JSON.stringify(url.includes('submit')?{data:{job_id:'j123',status:'pending'}}:{data:{url:'https://cdn.example.com/test.png',status:'succeeded'}}),{status:200,headers:{'content-type':'application/json'}});
 await assert.rejects(()=>provider.functionalTest({configuration,apiKey:'qa-secret',confirmed:false,fetchImpl:mock,lookup}),/明确确认|付费|费用/);
 const result=await provider.functionalTest({configuration,apiKey:'qa-secret',confirmed:true,fetchImpl:mock,lookup,pollIntervalMs:1,maxWaitMs:10});
 assert.equal(result.ok,true);
 assert.equal(result.resultType,'image-generated');
});

test('custom structured image generation accepts a prompt and async task without reference image',async()=>{
 const row=config.normalize(source('image',imageProgram),opts);
 const configuration={...row,base_url:row.baseUrl,timeout_ms:5000};
 const result=await provider.generateImage({configuration,apiKey:'qa-no-real-key',input:{prompt:'synthetic text-to-image',capability:'image-redraw'},lookup,
 fetchImpl:async (url,init)=>new Response(JSON.stringify({data:{job_id:'mock-4321',status:'pending'}}),{status:200,headers:{'content-type':'application/json'}})});
 assert.equal(result.taskId,'mock-4321');
 assert.equal(result.state,'submitted');
 assert.equal(result.protocol,'custom-structured');
});
test('unsafe adapter paths, response fields, arbitrary vars and wrong protocol blocked',()=>{
 const bad=[
 {...textProgram,request:{...textProgram.request,path:'//evil.com/attack'}},
 {...textProgram,request:{...textProgram.request,path:'/../../private'}},
 {...textProgram,request:{...textProgram.request,path:'/v2/{{apiKey}}'}},
 {...textProgram,request:{...textProgram.request,body:{a:'{{apiKey}}'}}},
 {...textProgram,response:{textPath:'constructor.prototype'}},
 {...textProgram,response:{textPath:'__proto__'}},
 {...textProgram,request:{...textProgram.request,auth:'none'}},
 {...textProgram,request:{...textProgram.request,method:'DELETE'}},
 {...textProgram,request:{...textProgram.request,body:{__proto__:null,process:'{{process}}'}}}
 ];
 for(const spec of bad)assert.throws(()=>adapter.validate(spec,'product'));
 assert.throws(()=>config.normalize({...source('product',textProgram),baseUrl:'https://127.0.0.1:9443'},opts),/HTTPS/);
 assert.throws(()=>config.normalize({...source('product',textProgram),baseUrl:'https://platform.example.com',model:{name:'x',adapter:undefined}},opts),/适配器/);
});