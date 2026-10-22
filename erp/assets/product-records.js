/* 网研ERP — 新增商品上架提交记录 + 下架重上投影（浏览器 / Node 共用） */
(function (root, factory) {
  var statusModel = root && root.WYERP_ONLINE_STATUS;
  if (typeof module === 'object' && module.exports) statusModel = require('./online-product-status');
  var api = factory(statusModel);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_RECORDS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (statusModel) {
  'use strict';
  function text(value) { return value == null ? '' : String(value).trim(); }
  function array(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
  function number(value) { if (value === '' || value == null) return null; var n=Number(String(value).replace(/[,，￥¥₽\s]/g,'')); return Number.isFinite(n)?n:null; }
  function hasOnlineStatusShape(p) {
    p = p || {};
    return !!(p.statuses || text(p.visibility) || p.is_archived != null || p.archived != null || text(p.statusKey || p.key) || text(p.ozonStatusName || p.ozonStatus) || text(p.delistReason || p.statusReason || p.status_reason || p.archiveReason));
  }
  function onlineInfo(p) {
    p = p || {};
    if (!hasOnlineStatusShape(p)) return null;
    var label = text(p.status || p.ozonStatusName || p.ozonStatus), key = text(p.statusKey || p.key).toLowerCase();
    if (statusModel) {
      if (key || /^(?:销售中|准备出售|错误|待修改|已下架|已归档)$/.test(label)) return statusModel.display({ statusKey:key, status:label, reason:p.reason, statusReason:p.statusReason || p.status_reason || p.delistReason, codes:p.codes });
      return statusModel.derive(p);
    }
    var combined = [label, p.visibility].map(text).join(' ').toLowerCase();
    if (p.is_archived || p.archived || /archiv|归档/.test(combined)) return { key:'archived', label:'已归档', reason:'商品已归档' };
    if (/не продается|убран из продажи|not selling|removed from sale|banned|disabled|下架|禁售/.test(combined)) return { key:'offline', label:'已下架', reason:'' };
    return { key:key || 'pending', label:label || '待修改', reason:'' };
  }
  function normalize(p) {
    p=p||{};
    var info=onlineInfo(p), rawStatus=text(p.status||p.ozonStatusName||p.ozonStatus), rawDelistReason=text(p.delistReason||p.statusReason||p.status_reason), archiveReason=text(p.archiveReason);
    var statusKey=info&&text(info.key).toLowerCase()||text(p.statusKey||p.key).toLowerCase();
    var archived=statusKey==='archived'||!!p.is_archived||!!p.archived;
    var reason=statusKey==='offline'?(rawDelistReason||text(info&&info.reason)||'平台已标记下架，但未返回更具体原因'):(archived?(archiveReason||text(info&&info.reason)):rawDelistReason);
    if(statusKey==='offline'&&reason==='商品已从销售中移除')reason='平台已标记下架，但未返回更具体原因';
    return {
      id:text(p.id),sku:text(p.sku),offerId:text(p.offerId||p.offer_id),productId:text(p.productId||p.product_id),queueId:text(p.queueId),source:text(p.source),
      name:text(p.name||p.title),image:text(p.img||p.image||p.imageUrl),shop:text(p.shop||p.shopName),clientId:text(p.clientId||p.client_id),category:text(p.cat3||p.cat2||p.cat1||p.category),status:info&&info.label||rawStatus,statusKey:statusKey,
      submittedAt:text(p.submittedAt||p.submitted_at),createdAt:text(p.createdAt||p.created_at||p.submittedAt||p.submitted_at),publishedAt:text(p.publishedAt||p.platformCreatedAt||p.platform_created_at||p.submittedAt||p.submitted_at),platformCreatedAt:text(p.platformCreatedAt||p.platform_created_at),platformUpdatedAt:text(p.platformUpdatedAt||p.platform_updated_at),platformStatus:text(p.platformStatus||p.platform_status),updatedAt:text(p.updatedAt||p.updated_at),completedAt:text(p.completedAt||p.completed_at),message:text(p.message),price:number(p.priceSell!=null?p.priceSell:p.price),
      originalPrice:number(p.priceOriginal),suggestedPrice:number(p.suggestedPrice),stock:number(p.stock),archived:archived,
      visibility:text(p.visibility),reason:reason,relistedAt:text(p.relistedAt)
    };
  }
  function all(value){return array(value).map(normalize).filter(function(p){return p.sku||p.name;});}
  function isArchived(p){p=p||{};return p.archived===true||text(p.statusKey).toLowerCase()==='archived'||/归档|archiv/i.test(text(p.status));}
  function isDelisted(p){p=p||{};return !isArchived(p)&&text(p.statusKey).toLowerCase()==='offline';}
  function listingRows(value){return all(value).filter(function(p){return !isArchived(p)&&!isDelisted(p);});}
  function relistingRows(value){return all(value).filter(isDelisted);}
  function filter(rows,c){c=c||{};var q=text(c.keyword).toLowerCase(),shop=text(c.shop),cat=text(c.category),status=text(c.status),reason=text(c.reason);
    return (rows||[]).filter(function(p){if(q&&(p.name+' '+p.sku).toLowerCase().indexOf(q)<0)return false;if(shop&&p.shop!==shop)return false;if(cat&&p.category!==cat)return false;if(status&&p.status!==status)return false;if(reason&&p.reason!==reason)return false;return true;});}
  function timestamp(v){var n=Date.parse(v||'');return Number.isFinite(n)?n:0;}
  function sort(rows){return (rows||[]).slice().sort(function(a,b){return timestamp(b.submittedAt||b.createdAt||b.updatedAt)-timestamp(a.submittedAt||a.createdAt||a.updatedAt);});}
  function sameDay(value,date){if(!value)return false;var d=new Date(value);return !isNaN(d)&&d.getFullYear()===date.getFullYear()&&d.getMonth()===date.getMonth()&&d.getDate()===date.getDate();}
  function listingStats(rows,now){now=now||new Date();var dateOf=function(p){return p.submittedAt||p.createdAt||p.updatedAt;};var month=rows.filter(function(p){var d=new Date(dateOf(p));return !isNaN(d)&&d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth();}).length;
    return {today:rows.filter(function(p){return sameDay(dateOf(p),now);}).length,month:month,success:rows.filter(function(p){return /新增成功/.test(p.status);}).length,pending:rows.filter(function(p){return /已提交|校验|提交中|处理中|确认中|待核对|失败/.test(p.status);}).length};}
  return {all:all,filter:filter,isArchived:isArchived,isDelisted:isDelisted,listingRows:listingRows,listingStats:listingStats,normalize:normalize,relistingRows:relistingRows,sort:sort};
});
