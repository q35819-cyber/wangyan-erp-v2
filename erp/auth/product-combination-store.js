'use strict';
const crypto=require('node:crypto');
const combination=require('../assets/product-combination');

const DOCUMENT_KEY='erp_product_combination_graph';
const SCHEMA_VERSION=1;
const MAX_RELATIONS=10000;
const MAX_HISTORY=50000;

function problem(code,message,status=400){return Object.assign(new Error(message),{publicCode:code,status});}
function normalizePayload(value){
  const raw=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const relations=combination.normalizeRelations(raw.relations||raw.combinationRelations||[]);
  const aliases=combination.normalizeAliases(raw.aliases||raw.collectionVariantAliases||[]);
  const graph=combination.validateGraph(relations,aliases);
  if(!graph.ok) throw problem(graph.code==='combination_cycle'?'combination_cycle':'invalid_combination_relation',graph.code==='combination_cycle'?'租户组合关系存在循环：'+graph.path.join(' → '):'租户组合关系包含重复或无效关联',409);
  const history=combination.normalizeHistory(raw.history||raw.combinationHistory||[]).slice(-MAX_HISTORY);
  if(graph.relations.length>MAX_RELATIONS)throw problem('combination_relation_limit','组合关系数量超过租户上限',409);
  return{schemaVersion:SCHEMA_VERSION,relations:graph.relations,aliases:graph.aliases,history,updatedAt:String(raw.updatedAt||'')};
}
async function read(store,account){
  const document=await store.getDocument(account,DOCUMENT_KEY);
  const payload=normalizePayload(document&&document.payload);
  return{payload,version:document?Number(document.version):0,updatedAt:document&&document.updatedAt||null};
}
function eventFor(relation,action,account,source){
  return{id:'comb_evt_'+crypto.randomUUID(),relationId:relation.id,parentRef:relation.parentRef,childRef:relation.childRef,childCollectionId:relation.childCollectionId||'',action,operatorUserId:String(account&&account.userId||''),occurredAt:new Date().toISOString(),source:String(source||'商品编辑').slice(0,80)};
}
function relationInput(input){
  const now=new Date().toISOString();
  return combination.normalizeRelation({id:String(input&&input.id||'comb_rel_'+crypto.randomUUID()),parentRef:input&&input.parentRef,childRef:input&&input.childRef,childCollectionId:input&&input.childCollectionId,quantity:input&&input.quantity,createdAt:input&&input.createdAt||now,updatedAt:now,lastCombinedAt:now},0);
}
function conflict(error){return error&&error.publicCode==='document_version_conflict';}
async function link({store,account,relation,source}){
  for(let attempt=0;attempt<4;attempt+=1){
    const current=await read(store,account),nextRelation=relationInput(relation),checked=combination.addRelation(current.payload.relations,nextRelation,current.payload.aliases);
    if(!checked.ok){
      const code=checked.code==='combination_cycle'?'combination_cycle':checked.code==='combination_duplicate'?'combination_duplicate':'invalid_combination_relation';
      const message=code==='combination_cycle'?'该组合会形成循环关系，无法添加：'+checked.path.join(' → '):code==='combination_duplicate'?'该商品已经关联到当前父项，无需重复添加':'组合关系格式不正确';
      throw problem(code,message,409);
    }
    const event=eventFor(checked.relation,'linked',account,source);
    const payload={schemaVersion:SCHEMA_VERSION,relations:checked.relations,aliases:current.payload.aliases,history:current.payload.history.concat(event).slice(-MAX_HISTORY),updatedAt:event.occurredAt};
    try{const saved=await store.putDocument(account,DOCUMENT_KEY,payload,current.version);return{payload,relation:checked.relation,event,version:Number(saved.version),updatedAt:saved.updatedAt};}
    catch(error){if(conflict(error)&&attempt<3)continue;throw error;}
  }
  throw problem('combination_relation_conflict','组合关系刚被其他用户更新，请重试',409);
}
function validateReplacement(payload,parentRefs,nextRelations){
  const current=normalizePayload(payload),parents=new Set(combination.uniqueStrings(parentRefs));
  if(!parents.size)return{ok:true,relations:current.relations,aliases:current.aliases,targetRelations:[]};
  const requested=combination.normalizeRelations(nextRelations).filter(relation=>parents.has(relation.parentRef));
  const requestedRawCount=Array.isArray(nextRelations)?nextRelations.filter(relation=>relation&&parents.has(String(relation.parentRef||''))).length:0;
  if(requested.length!==requestedRawCount)throw problem('invalid_combination_relation','组合关系包含重复或无效关联',409);
  const merged=current.relations.filter(relation=>!parents.has(relation.parentRef)).concat(requested);
  const graph=combination.validateGraph(merged,current.aliases);
  if(!graph.ok)throw problem(graph.code==='combination_cycle'?'combination_cycle':'invalid_combination_relation',graph.code==='combination_cycle'?'该组合会形成循环关系，无法保存：'+graph.path.join(' → '):'组合关系包含重复或无效关联',409);
  return{ok:true,relations:graph.relations,aliases:current.aliases,targetRelations:requested,previousTargetRelations:current.relations.filter(relation=>parents.has(relation.parentRef))};
}
function buildReplacement(payload,parentRefs,relations,account,source){
  const current=normalizePayload(payload),checked=validateReplacement(current,parentRefs,relations||[]),key=relation=>relation.parentRef+'\u0000'+relation.childRef,oldMap=new Map(checked.previousTargetRelations.map(relation=>[key(relation),relation])),newMap=new Map(checked.targetRelations.map(relation=>[key(relation),relation])),events=[];
  oldMap.forEach((relation,k)=>{if(!newMap.has(k))events.push(eventFor(relation,'unlinked',account,source));});
  newMap.forEach((relation,k)=>{if(!oldMap.has(k))events.push(eventFor(relation,'linked',account,source));});
  const updatedAt=events.length?events[events.length-1].occurredAt:current.updatedAt||new Date().toISOString();
  return{payload:{schemaVersion:SCHEMA_VERSION,relations:checked.relations,aliases:current.aliases,history:current.history.concat(events).slice(-MAX_HISTORY),updatedAt},events,previousTargetRelations:checked.previousTargetRelations,targetRelations:checked.targetRelations};
}
async function replaceParents({store,account,parentRefs,relations,source}){
  const parents=combination.uniqueStrings(parentRefs);
  if(!parents.length)return read(store,account);
  for(let attempt=0;attempt<4;attempt+=1){
    const current=await read(store,account),built=buildReplacement(current.payload,parents,relations||[],account,source);
    if(!built.events.length&&built.payload.relations.length===current.payload.relations.length)return{payload:current.payload,version:current.version,updatedAt:current.updatedAt,events:[]};
    try{const saved=await store.putDocument(account,DOCUMENT_KEY,built.payload,current.version);return{payload:built.payload,version:Number(saved.version),updatedAt:saved.updatedAt,events:built.events};}
    catch(error){if(conflict(error)&&attempt<3)continue;throw error;}
  }
  throw problem('combination_relation_conflict','组合关系刚被其他用户更新，请重试',409);
}
async function unlink({store,account,relationId,parentRef,childRef,source}){
  for(let attempt=0;attempt<4;attempt+=1){
    const current=await read(store,account);
    const found=current.payload.relations.find(item=>relationId?item.id===String(relationId):item.parentRef===String(parentRef||'')&&item.childRef===String(childRef||''));
    if(!found)throw problem('combination_relation_not_found','未找到要解除的组合关系',404);
    const event=eventFor(found,'unlinked',account,source);
    const payload={schemaVersion:SCHEMA_VERSION,relations:current.payload.relations.filter(item=>item.id!==found.id),aliases:current.payload.aliases,history:current.payload.history.concat(event).slice(-MAX_HISTORY),updatedAt:event.occurredAt};
    try{const saved=await store.putDocument(account,DOCUMENT_KEY,payload,current.version);return{payload,relation:found,event,version:Number(saved.version),updatedAt:saved.updatedAt};}
    catch(error){if(conflict(error)&&attempt<3)continue;throw error;}
  }
  throw problem('combination_relation_conflict','组合关系刚被其他用户更新，请重试',409);
}
function replaceAliases(payload,replacements){
  const current=normalizePayload(payload),requested=Array.isArray(replacements)?replacements:[],now=new Date().toISOString(),byCollection=new Map(current.aliases.map(alias=>[alias.collectionId,alias]));
  for(const raw of requested){
    const collectionId=String(raw&&raw.collectionId||'').trim().slice(0,240),variantRef=String(raw&&raw.variantRef||raw&&raw.erpVariantRef||'').trim().replace(/^variant:/,'').slice(0,240);
    if(!collectionId)continue;
    if(!variantRef){byCollection.delete(collectionId);continue;}
    const previous=byCollection.get(collectionId);
    if(previous&&previous.variantRef!==variantRef)throw problem('combination_alias_conflict','该采集商品已经绑定到另一个父SKU，不能自动改绑；请先解除旧身份关系后再处理。',409);
    byCollection.set(collectionId,{collectionId,variantRef,createdAt:previous&&previous.createdAt||now,updatedAt:now});
  }
  const aliases=combination.normalizeAliases([...byCollection.values()]),graph=combination.validateGraph(current.relations,aliases);
  if(!graph.ok)throw problem(graph.code==='combination_cycle'?'combination_cycle':'invalid_combination_relation',graph.code==='combination_cycle'?'该组合身份会形成循环关系，无法保存：'+graph.path.join(' → '):'组合身份映射不正确',409);
  const changed=JSON.stringify(current.aliases)!==JSON.stringify(graph.aliases);
  return{payload:{schemaVersion:SCHEMA_VERSION,relations:graph.relations,aliases:graph.aliases,history:current.history,updatedAt:changed?now:current.updatedAt},changed};
}
function collectionRef(id){const value=String(id||'').trim();return value?'collection:'+value:'';}
function stats(payload,collectionId){
  const graph=normalizePayload(payload),id=String(collectionId||''),ref=collectionRef(id);
  const incoming=graph.relations.filter(r=>r.childRef===ref||r.childCollectionId===id);
  let outgoing=graph.relations.filter(r=>r.parentRef===ref);
  if(!outgoing.length){const alias=graph.aliases.find(item=>item.collectionId===id);if(alias)outgoing=graph.relations.filter(r=>r.parentRef==='variant:'+alias.variantRef);}
  const history=graph.history.map((event,index)=>({event,index})).filter(row=>row.event.childRef===ref||row.event.parentRef===ref||row.event.childCollectionId===id).sort((a,b)=>((Date.parse(b.event.occurredAt)||0)-(Date.parse(a.event.occurredAt)||0))||(b.index-a.index)).map(row=>row.event);
  return{protected:Boolean(incoming.length||outgoing.length),parentRefCount:incoming.length,childCount:outgoing.length,combinationEventCount:history.length,lastCombinedAt:history[0]&&history[0].occurredAt||'',history};
}
function calculatePurchaseTotalCost(payload,rootRef,resolver,rootCost){
  const graph=normalizePayload(payload);
  return combination.calculatePurchaseTotalCost(rootRef,graph.relations,resolver,rootCost,graph.aliases);
}
function protectedCollectionIds(payload){
  const graph=normalizePayload(payload),ids=new Set();
  for(const relation of graph.relations){
    if(String(relation.childRef||'').startsWith('collection:'))ids.add(String(relation.childRef).slice('collection:'.length));
    if(relation.childCollectionId)ids.add(String(relation.childCollectionId));
    if(String(relation.parentRef||'').startsWith('collection:'))ids.add(String(relation.parentRef).slice('collection:'.length));
  }
  for(const alias of graph.aliases){if(graph.relations.some(relation=>relation.parentRef==='variant:'+alias.variantRef))ids.add(alias.collectionId);}
  return[...ids].filter(Boolean);
}
function assertCollectionsRemovable(payload,ids){
  const protectedIds=new Set(protectedCollectionIds(payload)),blocked=combination.uniqueStrings(ids).filter(id=>protectedIds.has(id));
  if(blocked.length)throw problem('collection_product_in_combination','该采集商品正在参与商品组合，请先解除全部组合关系后再删除。',409);
  return true;
}
module.exports={DOCUMENT_KEY,SCHEMA_VERSION,normalizePayload,read,link,unlink,replaceParents,replaceAliases,validateReplacement,buildReplacement,stats,collectionRef,calculatePurchaseTotalCost,protectedCollectionIds,assertCollectionsRemovable};
