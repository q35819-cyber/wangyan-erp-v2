'use strict';
// Restricted, declarative vendor program. No eval/vm/Function or user-code execution.
// The ERP owns HTTP/TLS, credentials, DNS checks, timeouts and response size limits.
const fail = msg => { throw Object.assign(new Error(msg),{publicCode:'invalid_ai_vendor_adapter',status:400}); };
const TOKEN = /^\{\{(model|system|inputJson|prompt|image|images|mask|taskId)\}\}$/;
const ALLOWED = new Set(['model','system','inputJson','prompt','image','images','mask','taskId']);
const PATH = /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/;
const DISALLOWED = new Set(['__proto__','constructor','prototype']);
function safePath(path) {
 if(typeof path !== 'string'||path.length>200||!PATH.test(path)||path.split('.').some(x=>DISALLOWED.has(x)))fail('响应字段路径格式不正确');
 return path;
}
function pathValue(payload,path) {
 if(!path)return undefined;
 return safePath(path).split('.').reduce((val,key)=>(val&&typeof val==='object'&&Object.prototype.hasOwnProperty.call(val,key))?val[key]:undefined,payload);
}
function endpoint(value,poll=false){
 if(typeof value!=='string'||value.length>220||!value.startsWith('/')||value.startsWith('//')||
    /(?:\\|%|[?#]|\.\.|[\u0000-\u001f])/.test(value))fail('接口路径必须是同一平台域名下的安全相对路径');
 if(!/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*(?:\{\{taskId\}\}[A-Za-z0-9._~!$&'()*+,;=:@/-]*)?$/.test(value))fail('接口路径不支持动态代码；仅查询路径可插入{{taskId}}');
 if(value.includes('{{taskId}}')&&!poll)fail('任务编号占位符只能用于轮询接口');
 return value;
}
function validateNode(value,depth=0,tracker={count:0}){
 tracker.count++;if(tracker.count>180||depth>9)fail('请求体过大或嵌套层数超过限制');
 if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
 if(typeof value==='string'){
   if(value.length>16000)fail('请求体静态文本过长');
   for(const found of value.matchAll(/\{\{([^}]+)\}\}/g)){if(!ALLOWED.has(found[1]))fail('请求体存在不支持的变量 '+found[1]);}
   if(/\{\{|\}\}/.test(value.replace(/\{\{(?:model|system|inputJson|prompt|image|images|mask|taskId)\}\}/g,'')))fail('请求体包含未知占位符');
   return;
 }
 if(Array.isArray(value)){if(value.length>35)fail('请求体数组太长');value.forEach(item=>validateNode(item,depth+1,tracker));return;}
 if(typeof value==='object'&&value&&!Array.isArray(value)){
  const entries=Object.entries(value);if(entries.length>35)fail('请求体字段过多');
  for(const [key,item] of entries){if(!/^[A-Za-z_$][\w$-]{0,70}$/.test(key)||DISALLOWED.has(key))fail('请求体包含不安全字段名');validateNode(item,depth+1,tracker);}
  return;
 }
 fail('请求体只允许JSON常量与变量占位符');
}
function validateResponse(value,type){
 if(!value||typeof value!=='object'||Array.isArray(value))fail('响应解析配置缺失');
 const allowed=type==='text'?['textPath']:['imagePath','taskPath','statusPath','errorPath'];
 for(const k of Object.keys(value))if(!allowed.includes(k))fail('响应配置中存在未知字段');
 if(type==='text'&&!value.textPath)fail('文字模型需要textPath');
 if(type==='image'&&!value.imagePath&&!value.taskPath)fail('图片模型至少配置imagePath或taskPath');
 for(const key of allowed)if(value[key]!==undefined)safePath(value[key]);
 return JSON.parse(JSON.stringify(value));
}
function validate(adapter,section){
 if(!adapter||typeof adapter!=='object'||Array.isArray(adapter))fail('请提供供应商适配器JSON对象');
 const raw=JSON.stringify(adapter);
 if(!raw||raw.length>30000)fail('适配器不得超过30KB');
 if(Object.keys(adapter).some(k=>!['version','request','response','poll'].includes(k)))fail('适配器包含未授权的顶层字段');
 if(adapter.version!==1)fail('当前只支持v1适配器规范');
 const request=adapter.request;
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!['method','path','auth','body'].includes(k)))fail('请求结构只允许method/path/auth/body');
 if(!['POST','GET'].includes(request.method))fail('目前只支持POST或GET');
 if(!['bearer','x-api-key'].includes(request.auth))fail('认证类型只能bearer或x-api-key');
 endpoint(request.path);
 if(request.method==='POST'&&!request.body)fail('POST接口必须配置JSON请求体');
 if(request.body!==undefined)validateNode(request.body);
 const kind=section==='product'?'text':section==='image'?'image':null;
 if(!kind)fail('供应商类型不正确');
 const response=validateResponse(adapter.response,kind);
 let poll=null;
 if(adapter.poll!==undefined && adapter.poll!==null){
  if(kind!=='image')fail('文字适配器不需要异步任务轮询');
  if(!adapter.poll||typeof adapter.poll!=='object'||Array.isArray(adapter.poll)||Object.keys(adapter.poll).some(k=>!['path','response'].includes(k)))fail('轮询配置只允许path/response');
  poll={path:endpoint(adapter.poll.path,true),response:validateResponse(adapter.poll.response,'image')};
  if(!poll.path.includes('{{taskId}}'))fail('轮询路径必须包含{{taskId}}');
 }
 return Object.freeze({version:1,request:{method:request.method,path:request.path,auth:request.auth,...(request.body!==undefined?{body:JSON.parse(JSON.stringify(request.body))}:{})},response,poll});
}
function render(node,vars){
 if(typeof node==='string'){
   const match=TOKEN.exec(node);
   if(match)return vars[match[1]]??null;
   return node.replace(/\{\{(model|system|inputJson|prompt|image|images|mask|taskId)\}\}/g,(_,key)=>String(vars[key]??''));
 }
 if(Array.isArray(node))return node.map(item=>render(item,vars));
 if(node&&typeof node==='object'){const result=Object.create(null);for(const [k,v]of Object.entries(node))result[k]=render(v,vars);return result;}
 return node;
}
async function call({configuration,apiKey,adapter,vars,stage='request',requestJson,fetchImpl,lookup}){
 const section=configuration.section;const validated=validate(adapter,section);
 const spec=stage==='poll'?validated.poll:validated.request;
 if(!spec)fail('未配置异步轮询协议');
 let path=spec.path;
 if(stage==='poll')path=path.replace('{{taskId}}',encodeURIComponent(String(vars.taskId||'')));
 const base=String(configuration.base_url||configuration.baseUrl||'').replace(/\/$/,'');
 const url=base+path;
 const headers={Accept:'application/json',...(stage==='request'&&spec.method==='POST'?{'Content-Type':'application/json'}:{})};
 const auth=stage==='poll'?validated.request.auth:spec.auth;
 headers[auth==='bearer'?'Authorization':'X-API-Key']=auth==='bearer'?'Bearer '+apiKey:apiKey;
 const response=await requestJson(url,{method:stage==='poll'?'GET':spec.method,headers,
   ...(stage==='request'&&spec.body!==undefined?{body:JSON.stringify(render(spec.body,vars))}:{}),
   timeoutMs:Math.min(Number(configuration.timeout_ms||configuration.timeoutMs)||30000,60000)},fetchImpl,lookup);
 if(!response.ok)throw Object.assign(new Error('供应商请求失败，HTTP '+response.status),{publicCode:'ai_provider_rejected',status:502});
 return {data:response.payload,response:stage==='poll'?validated.poll.response:validated.response};
}
function imageResult(data,response,taskId=''){
 const status=String(pathValue(data,response.statusPath)||'').toLowerCase();
 if(['failed','error','cancelled','canceled','rejected'].includes(status))throw Object.assign(new Error('供应商报告图片任务失败'),{publicCode:'ai_image_generate_failed'});
 const raw=pathValue(data,response.imagePath);
 const image=typeof raw==='string'?raw:'';
 if(image && !(image.startsWith('https://') || /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)))fail('图片结果必须是HTTPS URL或合法图片Data URL');
 const id=String(pathValue(data,response.taskPath)||taskId||'');
 if(!image&&!id)fail('图片接口未返回图像或任务编号');
 if(id&&!/^[A-Za-z0-9._:-]{1,200}$/.test(id))fail('图片任务编号不合法');
 return {state:image?'succeeded':taskId?'pending':'submitted',resultUrl:image||null,taskId:id||null};
}
module.exports={validate,pathValue,render,call,imageResult};
