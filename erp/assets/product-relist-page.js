(function () {
  'use strict';

  var PRODUCT_KEY = 'erp_online_products';
  var SHOP_KEY = 'erp_shops_data';
  var model = window.WYERP_PRODUCT_RECORDS;
  var permissionModel = window.WYERP_ONLINE_PRODUCT_PERMISSIONS;
  var navRef = window.WYERP_NAV_REF;
  var syncStream = window.WYERP_SYNC_STREAM;
  var skuMask = window.WYERP_SKU_MASK;
  var ozonLink = window.WYERP_OZON_PRODUCT_LINK;
  var products = [], shops = [], rows = [], visibleRows = [], canWrite = false, busy = false;
  var ozonWait = syncStream && syncStream.createThrottlePool ? syncStream.createThrottlePool({ minDelay: 2000, maxDelay: 4000 }) : function () { return Promise.resolve(); };

  if (!model || !permissionModel || !navRef || !syncStream || !skuMask || !ozonLink) throw new Error('下架重上页面依赖模块加载失败');

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function toast(message, failed) {
    var node = document.createElement('div');
    node.className = 'toast' + (failed ? ' toast-error' : '');
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(function () { node.remove(); }, 3500);
  }

  function options(id, label, values) {
    var select = document.getElementById(id), current = select.value;
    var unique = values.filter(Boolean).filter(function (value, index, all) { return all.indexOf(value) === index; });
    select.innerHTML = '<option value="">' + label + '</option>' + unique.map(function (value) { return '<option>' + esc(value) + '</option>'; }).join('');
    if (unique.indexOf(current) >= 0) select.value = current;
  }

  function rawProduct(row) {
    var rowClient = String(row && row.clientId || ''), rowProduct = String(row && (row.productId || row.id) || '');
    return products.find(function (product) {
      var clientId = String(product && (product.clientId || product.client_id || product.externalShopId || product.shopId) || '');
      var productId = String(product && (product.productId || product.product_id || product.id) || '');
      return rowClient && rowProduct && clientId === rowClient && productId === rowProduct;
    }) || products.find(function (product) {
      return String(product && product.sku || '') === String(row && row.sku || '') && String(product && (product.shop || product.shopName) || '') === String(row && row.shop || '');
    }) || null;
  }

  function productShop(product, row) {
    var clientId = String(row && row.clientId || product && (product.clientId || product.client_id || product.externalShopId || product.shopId) || '');
    return shops.find(function (shop) { return String(shop && (shop.clientId || shop.externalShopId || shop.id) || '') === clientId; }) ||
      shops.find(function (shop) { return String(shop && shop.name || '') === String(row && row.shop || product && (product.shop || product.shopName) || ''); }) ||
      { clientId: clientId, name: row && row.shop || '当前店铺' };
  }

  function relistHref(row, product) {
    return navRef.href('product-detail.html', {
      kind: 'product-detail',
      productId: String(product && (product.productId || product.product_id || product.id) || row.productId || row.id || ''),
      sku: String(row.sku || ''),
      shop: String(row.shop || ''),
      clientId: String(row.clientId || product && (product.clientId || product.client_id) || '')
    }, { mode: 'relist', load: 'full' });
  }

  function callArchive(product, row) {
    var shop = productShop(product, row), clientId = String(shop && (shop.clientId || shop.externalShopId) || row.clientId || '');
    var productId = Number(product && (product.productId || product.product_id || product.id) || row.productId || row.id);
    if (!clientId) return Promise.reject(new Error('无法确认原商品所属店铺'));
    if (!Number.isSafeInteger(productId) || productId <= 0) return Promise.reject(new Error('原商品缺少有效 Ozon 商品编号'));
    if (shop.credentialsConfigured === false) return Promise.reject(new Error('当前店铺未配置有效 Ozon 凭证'));
    var command = erpStorage.ozonCommandForEndpoint('/v1/product/archive');
    var idempotencyKey = erpStorage.createIdempotencyKey();
    return syncStream.requestJsonWithRetry(function () {
      return ozonWait(clientId).then(function () {
        return erpStorage.request('/api/integrations/ozon/commands', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify({ clientId: clientId, command: command.name, body: { product_id: [productId] } })
        });
      });
    }, { maxRetries: 5 }).then(function (data) {
      if (!data || data.result !== true) throw new Error('Ozon 未确认商品归档');
      if (product.status && product.status !== '已归档') product.statusBeforeArchive = product.status;
      product.archived = true;
      product.is_archived = true;
      product.status = '已归档';
      product.statusKey = 'archived';
      return erpStorage.set(PRODUCT_KEY, products);
    });
  }

  function refresh() {
    products = Array.isArray(erpStorage.get(PRODUCT_KEY)) ? erpStorage.get(PRODUCT_KEY) : [];
    rows = model.relistingRows(products);
    document.getElementById('allCount').textContent = rows.length;
    document.getElementById('pendingCount').textContent = rows.filter(function (row) { return !row.relistedAt; }).length;
    document.getElementById('relistedCount').textContent = rows.filter(function (row) { return !!row.relistedAt; }).length;
    options('reason', '全部下架原因', rows.map(function (row) { return row.reason; }));
    options('status', '全部状态', rows.map(function (row) { return row.status; }));
    render();
  }

  function render() {
    visibleRows = model.sort(model.filter(rows, {
      keyword: document.getElementById('keyword').value,
      reason: document.getElementById('reason').value,
      status: document.getElementById('status').value
    }));
    var body = document.getElementById('recordBody');
    document.getElementById('totalText').textContent = '共 ' + visibleRows.length + ' 条记录';
    if (!visibleRows.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty">暂无符合条件的下架商品<br>本页不会生成模拟下架原因或建议价格。</div></td></tr>';
      return;
    }
    body.innerHTML = visibleRows.map(function (row, index) {
      var image = row.image ? '<img class="product-img" src="' + esc(row.image) + '" alt="" onerror="this.style.display=\'none\'">' : '<div class="product-img"></div>';
      var noWrite = !canWrite || busy, alreadyRelisted = !!row.relistedAt;
      var relistTitle = !canWrite ? '当前账号没有商品修改权限' : alreadyRelisted ? '该原商品已经完成重新上架，不能重复创建' : '复制当前商品全部可复用信息，生成新货号后重新上架';
      return '<tr><td><div class="product-cell">' + image + '<div>' +
        ozonLink.titleHtml(row, row.name || '未命名商品', { className: 'product-name product-title-ellipsis ozon-product-title-link' }) +
        '<div class="sku">SKU：' + esc(skuMask.mask(row.sku)) + '</div></div></div></td>' +
        '<td>' + esc(row.shop || '--') + '</td><td>' + esc(row.reason || '平台已标记下架，但未返回更具体原因') + '</td>' +
        '<td><span class="badge badge-red">' + esc(row.status || '已下架') + '</span></td><td>' + esc(row.updatedAt || row.createdAt || '--') + '</td>' +
        '<td>' + (row.price == null ? '--' : '¥ ' + esc(row.price)) + '</td><td>' + (row.suggestedPrice == null ? '--' : '¥ ' + esc(row.suggestedPrice)) + '</td>' +
        '<td><div class="relist-actions"><button class="btn btn-primary" type="button" data-relist-index="' + index + '"' +
        (noWrite || alreadyRelisted ? ' disabled' : '') + ' title="' + esc(relistTitle) + '">下架重上</button>' +
        '<button class="btn" type="button" data-archive-index="' + index + '"' + (noWrite ? ' disabled' : '') +
        ' title="' + esc(canWrite ? '将当前下架商品归档' : '当前账号没有商品修改权限') + '">归档</button></div></td></tr>';
    }).join('');
  }

  function openRelist(index) {
    var row = visibleRows[index], product = rawProduct(row);
    if (!row || !product || row.relistedAt || !canWrite || busy) return;
    var href = relistHref(row, product);
    if (!href) { toast('无法生成安全的下架重上入口，请刷新后重试', true); return; }
    location.href = href;
  }

  function archive(index) {
    var row = visibleRows[index], product = rawProduct(row);
    if (!row || !product || !canWrite || busy) return;
    if (!window.confirm('确认归档“' + (row.name || '当前商品') + '”？归档成功后将从下架重上列表移除。')) return;
    busy = true; render();
    callArchive(product, row).then(function () {
      toast('商品已归档');
      refresh();
    }).catch(function (error) {
      toast(error && error.message || '商品归档失败', true);
    }).finally(function () {
      busy = false; render();
    });
  }

  document.getElementById('recordBody').addEventListener('click', function (event) {
    var relistButton = event.target.closest('[data-relist-index]');
    if (relistButton) { openRelist(Number(relistButton.dataset.relistIndex)); return; }
    var archiveButton = event.target.closest('[data-archive-index]');
    if (archiveButton) archive(Number(archiveButton.dataset.archiveIndex));
  });
  document.getElementById('searchBtn').addEventListener('click', render);
  document.getElementById('keyword').addEventListener('keydown', function (event) { if (event.key === 'Enter') render(); });

  (window.WYERP_RELIST_READY || erpStorage.init([PRODUCT_KEY, SHOP_KEY])).then(function () {
    shops = Array.isArray(erpStorage.get(SHOP_KEY)) ? erpStorage.get(SHOP_KEY) : [];
    return erpStorage.request('/api/auth/me');
  }).then(function (response) {
    return response && response.ok ? response.json() : null;
  }).then(function (account) {
    canWrite = permissionModel.canWriteProducts(account);
    refresh();
  }).catch(function (error) {
    canWrite = false;
    refresh();
    toast(error && error.message || '页面权限信息加载失败，写操作已禁用', true);
  });
})();
