'use strict';
const assert = require('node:assert/strict');
async function withQa22Database(callback) {
  if (process.env.PGPORT !== '55467' || process.env.PGDATABASE !== 'wyerp_community_local')
    throw Error('QA22 PostgreSQL credentials and isolated DB identity required');
  const { Client } = require('pg');
  const client = new Client();
  await client.connect();
  try { return await callback(client); } finally { await client.end(); }
}
async function purgeQa22SyntheticArchivedShop(shop) {
  return withQa22Database(async client => {
    await client.query('BEGIN');
    try {
      const match = await client.query(
        'SELECT id, tenant_id, name, status, credential_ciphertext FROM shops WHERE external_shop_id=$1 FOR UPDATE',
        [shop.clientId]);
      if (match.rows.length > 1) throw Error('Multiple matching QA shops: refuse cleanup');
      if (!match.rows.length) { await client.query('COMMIT'); return; }
      const record = match.rows[0];
      if (record.name !== shop.name && record.name !== shop.name + '-edited')
        throw Error('Unexpected shop name: refuse cleanup');
      if (record.status !== 'archived' || record.credential_ciphertext !== null)
        throw Error('QA shop not safely archived without credentials: refuse cleanup');
      const scopes = await client.query(
        'SELECT COUNT(*)::int AS n FROM member_shop_scopes WHERE tenant_id=$1 AND shop_id=$2',
        [record.tenant_id, record.id]);
      if (scopes.rows[0].n !== 0) throw Error('QA shop has scope references: refuse cleanup');
      const result = await client.query(
        'DELETE FROM shops WHERE id=$1 AND tenant_id=$2 AND status=$3 RETURNING id',
        [record.id, record.tenant_id, 'archived']);
      if (result.rowCount !== 1) throw Error('QA shop deletion count mismatch');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
async function runBusinessQA({ context, base }) {
  // Only isolated synthetic QA installations with verified, explicitly assigned ports.
  if (!['http://127.0.0.1:18787', 'http://127.0.0.1:18792'].includes(base)) throw Error('Refusing non-isolated QA');
  if (base === 'http://127.0.0.1:18792' && (process.env.PGPORT !== '55467' || process.env.PGDATABASE !== 'wyerp_community_local')) throw Error('Refusing QA22 business writes without isolated DB cleanup credentials');
  const api=context.request, out=[], mark='QA-FULL-'+Date.now();
  const check=async(name,fn)=>{
    try{const detail=await fn();out.push({name,status:'PASS',detail});console.log('PASS '+name+(detail?' '+detail:''));}
    catch(error){out.push({name,status:'FAIL',reason:String(error.message).slice(0,500)});console.error('FAIL '+name+' '+(error.stack||error));}
  };
  const json=async response=>({status:response.status(),version:response.headers()['x-data-version'],data:await response.json().catch(()=>null)});
  const who=await json(await api.get(base+'/api/auth/me'));
  assert.equal(who.status,200);
  const headers={origin:base,'x-csrf-token':who.data.csrfToken};
  const read=async key=>{
    const result=await json(await api.get(base+'/api/data/'+key));
    if(result.status===404)return {data:[],version:0,status:404};
    assert.equal(result.status,200,key+' '+JSON.stringify(result.data));
    return {...result,version:Number(result.version||0)};
  };
  const save=async(key,data,version)=>json(await api.post(base+'/api/data/'+key,{headers:{...headers,'if-match':String(version)},data}));
  const rows=async(key,data,version)=>json(await api.post(base+'/api/domain/commands/business-rows',{headers,data:{key,expectedVersion:version,payload:data,source:'manual'}}));
  await check('unauthenticated business reads blocked',async()=>{
    const fresh=await context.browser().newContext();
    try{assert.equal((await fresh.request.get(base+'/api/data/erp_orders_data')).status(),401);}
    finally{await fresh.close();}
  });
  await check('business CSRF rejects missing proof',async()=>{
    assert.equal((await api.post(base+'/api/data/erp_shops_data',{data:[]})).status(),403);
  });
  await check('invalid shop row is rejected',async()=>{
    const r=await json(await api.post(base+'/api/data/erp_shops_data',{headers,data:[{name:'no-client-id'}]}));
    assert.equal(r.status,400,JSON.stringify(r.data));
  });
  await check('shop add, credential mask, update, delete',async()=>{
    const initial=await read('erp_shops_data');
    assert.deepEqual(initial.data,[],'Refuse to overwrite existing shops');
    const s={id:mark+'-S',clientId:mark+'-C',name:mark+'-shop',apiKey:'qa-local-placeholder',status:'正常'};
    try{
      const created=await save('erp_shops_data',[s],initial.version);
      assert.equal(created.status,200,JSON.stringify(created.data));
      const one=await read('erp_shops_data');
      assert.equal(one.data.length,1);
      assert.equal(one.data[0].name,s.name);
      assert.equal(one.data[0].apiKey,undefined);
      assert.equal(one.data[0].credentialsConfigured,true);
      const edit=await save('erp_shops_data',[{id:s.id,clientId:s.clientId,name:s.name+'-edited'}],one.version);
      assert.equal(edit.status,200,JSON.stringify(edit.data));
      const two=await read('erp_shops_data');
      assert.equal(two.data[0].name,s.name+'-edited');
      assert.equal(two.data[0].credentialsConfigured,true);
    }finally{
      try {
        const current=await read('erp_shops_data');
        if(current.data.length===1&&current.data[0].clientId===s.clientId){
          const cleanup=await save('erp_shops_data',[],current.version);
          assert.equal(cleanup.status,200,JSON.stringify(cleanup.data));
        }
      } finally {
        // Public delete archives by design; purge only verified synthetic QA22 rows.
        if (base === 'http://127.0.0.1:18792') await purgeQa22SyntheticArchivedShop(s);
      }
    }
    assert.deepEqual((await read('erp_shops_data')).data,[]);
  });
  for(const [key,entry] of [
    ['erp_online_products',{id:mark+'-product',clientId:mark+'-C',sku:mark+'-sku',name:'QA商品',price:100,stock:5,status:'active'}],
    ['erp_orders_data',{id:mark+'-order',posting:mark+'-order',posting_number:mark+'-order',clientId:mark+'-C',status:'delivered',price:100,quantity:1}]
  ]){
    await check(key+' create/update/409 conflict/delete',async()=>{
      const initial=await read(key);
      assert.deepEqual(initial.data,[],'Refuse overwrite');
      try{
        const created=await rows(key,[entry],initial.version);
        assert.equal(created.status,200,JSON.stringify(created.data));
        const found=await read(key);
        assert.equal(found.data.length,1);
        const edited={...entry,name:'QA-UPDATED',price:123};
        const update=await rows(key,[edited],found.version);
        assert.equal(update.status,200,JSON.stringify(update.data));
        const latest=await read(key);
        assert.equal(latest.data[0].price,123);
        const conflict=await rows(key,[entry],found.version);
        assert.equal(conflict.status,409,JSON.stringify(conflict.data));
        assert.equal((await read(key)).data[0].price,123);
      }finally{
        const final=await read(key);
        if(final.data.length===1&&
          String(final.data[0].id||final.data[0].posting).startsWith(mark)){
          const cleanup=await rows(key,[],final.version);
          assert.equal(cleanup.status,200,JSON.stringify(cleanup.data));
        }
      }
      assert.deepEqual((await read(key)).data,[]);
    });
  }
  await check('invalid external supplier host refused without mutation',async()=>{
    const key='erp_online_products',before=await read(key);
    assert.deepEqual(before.data,[]);
    const entry={id:mark+'-bad',clientId:mark+'-C',sourceUrl:'https://wrong.invalid/supplier'};
    const result=await rows(key,[entry],before.version);
    assert.equal(result.status,400,JSON.stringify(result.data));
    assert.deepEqual((await read(key)).data,[]);
  });
  await check('legacy business collection write methods denied',async()=>{
    assert.equal((await api.post(base+'/api/data/erp_orders_data',{headers,data:[]})).status(),405);
    assert.equal((await api.delete(base+'/api/data/erp_online_products',{headers})).status(),405);
  });
  await check('unknown document key is unavailable',async()=>{
    assert.equal((await api.get(base+'/api/data/__qa17_no_such_key__')).status(),404);
  });
  await check('standalone SaaS-only routes disabled',async()=>{
    const all=['/api/membership/current','/api/system/ai-beans/accounts','/api/system/contracts',
      '/api/auth/profile/email','/pages/membership.html','/pages/ai-beans.html',
      '/pages/agent-center.html','/pages/contract-terms.html','/pages/accounts.html'];
    for(const url of all)assert.equal((await api.get(base+url)).status(),404,url);
    return all.length+' routes';
  });
  await check('auth response has basic security headers',async()=>{
    const r=await api.get(base+'/login.html');
    assert.equal(r.status(),200);
    assert.equal(r.headers()['x-content-type-options'],'nosniff');
    assert.ok(r.headers()['content-security-policy']);
  });
  await check('30 concurrent authorized business reads',async()=>{
    const requests=Array.from({length:30},()=>api.get(base+'/api/data/erp_orders_data',{timeout:15000}));
    const results=await Promise.all(requests);
    const counts=results.reduce((acc,r)=>{acc[r.status()]=(acc[r.status()]||0)+1;return acc;},{});
    assert.equal(counts[200],30,JSON.stringify(counts));
    return '30/30 HTTP200';
  });
  return out;
}
module.exports={runBusinessQA};