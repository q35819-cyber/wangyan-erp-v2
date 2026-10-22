/* 跨页传递SKU/店铺ID等业务标识时只在sessionStorage保存原值，URL仅携带随机ref。 */
(function(root,factory){
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.WYERP_NAV_REF=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  var PREFIX='wyerp_nav_ref:',TTL=2*60*60*1000;
  function storage(){try{return root&&root.sessionStorage||null}catch(error){return null}}
  function token(){
    if(root&&root.crypto&&typeof root.crypto.randomUUID==='function')return root.crypto.randomUUID().replace(/-/g,'');
    var bytes=new Uint8Array(18);
    if(root&&root.crypto&&typeof root.crypto.getRandomValues==='function')root.crypto.getRandomValues(bytes);
    else for(var i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
    return Array.prototype.map.call(bytes,function(v){return v.toString(16).padStart(2,'0')}).join('');
  }
  function cleanup(now){
    var box=storage();if(!box)return;
    for(var i=box.length-1;i>=0;i--){var key=box.key(i);if(!key||key.indexOf(PREFIX)!==0)continue;try{var row=JSON.parse(box.getItem(key)||'null');if(!row||!row.createdAt||now-row.createdAt>TTL)box.removeItem(key)}catch(error){box.removeItem(key)}}
  }
  function put(value){
    var box=storage(),id=token(),now=Date.now();if(!box)return '';
    cleanup(now);box.setItem(PREFIX+id,JSON.stringify({createdAt:now,value:value&&typeof value==='object'?value:{}}));return id;
  }
  function get(id){
    var box=storage();id=String(id||'').trim();if(!box||!/^[a-f0-9]{24,64}$/i.test(id))return null;
    try{var row=JSON.parse(box.getItem(PREFIX+id)||'null');if(!row||Date.now()-Number(row.createdAt||0)>TTL){box.removeItem(PREFIX+id);return null}return row.value&&typeof row.value==='object'?row.value:null}catch(error){return null}
  }
  function href(path,value,extra){
    var id=put(value),params=new URLSearchParams(extra||{});if(id)params.set('ref',id);
    return String(path||'')+(params.toString()?'?'+params.toString():'');
  }
  function fromSearch(search){var params=new URLSearchParams(search||'');return get(params.get('ref'))}
  return{put:put,get:get,href:href,fromSearch:fromSearch};
});
