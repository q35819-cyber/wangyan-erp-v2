/* 网研ERP — 主要业务列表公共分页（无自有分页页面自动接入） */
(function () {
  'use strict';

  var SKIP_PAGES = new Set([
    'ai-beans.html','api-monitor.html','audit-log.html','category.html','goods-online.html',
    'logistics-config.html','membership-admin.html','orders.html','product-detail.html',
    'shops.html','task-center.html','user-monitor.html'
  ]);
  var PAGE_SIZES = [10, 20, 50, 100];
  var instances = [];

  function pageName() {
    var parts = String(location.pathname || '').split('/');
    return parts[parts.length - 1] || '';
  }
  function shouldSkipTable(table) {
    if (!table || !table.tBodies || !table.tBodies.length) return true;
    if (table.dataset.noAutoPagination === '1' || table.dataset.pagination === 'off') return true;
    if (table.closest('dialog,.modal-mask,.modal-box,.entity-history-box,.status-tooltip')) return true;
    return false;
  }
  function restorePagedRows(instance) {
    Array.prototype.forEach.call(instance.tbody.rows || [], function (row) {
      if (row.dataset.wyPaginationHidden === '1') {
        row.hidden = false;
        delete row.dataset.wyPaginationHidden;
      }
    });
  }
  function placeholderRow(row) {
    if (!row || !row.cells || row.cells.length !== 1) return false;
    var cell = row.cells[0];
    if (!cell || Number(cell.colSpan || 1) <= 1) return false;
    return /暂无|正在|加载|没有|无数据|空数据|读取中/.test(String(cell.textContent || '').trim());
  }
  function sourceRows(instance) {
    restorePagedRows(instance);
    return Array.prototype.filter.call(instance.tbody.rows || [], function (row) {
      if (row.dataset.paginationFixed === '1') return false;
      if (placeholderRow(row)) return false;
      if (row.hidden) return false;
      var display = '';
      try { display = getComputedStyle(row).display; } catch (error) {}
      return display !== 'none';
    });
  }
  function button(label, page, disabled, active) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'page' + (active ? ' on' : '') + (disabled ? ' disabled' : '') + (label === '上一页' || label === '下一页' ? ' page-nav' : '');
    node.textContent = label;
    node.dataset.pg = String(page);
    node.disabled = !!disabled;
    return node;
  }
  function renderNav(instance, pages) {
    var nav = instance.nav;
    nav.replaceChildren();
    nav.appendChild(button('上一页', instance.page - 1, instance.page <= 1, false));
    var from = 1, to = pages;
    if (pages > 7) {
      from = Math.max(1, instance.page - 2);
      to = Math.min(pages, instance.page + 2);
      if (from > 1) {
        nav.appendChild(button('1', 1, false, instance.page === 1));
        if (from > 2) {
          var leftEllipsis = document.createElement('span');
          leftEllipsis.className = 'page-ellipsis';
          leftEllipsis.textContent = '…';
          nav.appendChild(leftEllipsis);
        }
      }
    }
    for (var page = from; page <= to; page += 1) nav.appendChild(button(String(page), page, false, page === instance.page));
    if (to < pages) {
      if (to < pages - 1) {
        var rightEllipsis = document.createElement('span');
        rightEllipsis.className = 'page-ellipsis';
        rightEllipsis.textContent = '…';
        nav.appendChild(rightEllipsis);
      }
      nav.appendChild(button(String(pages), pages, false, instance.page === pages));
    }
    nav.appendChild(button('下一页', instance.page + 1, instance.page >= pages, false));
  }
  function render(instance) {
    if (!instance.table.isConnected || instance.rendering) return;
    instance.rendering = true;
    try {
      var rows = sourceRows(instance);
      var total = rows.length;
      var pages = Math.max(1, Math.ceil(total / instance.size));
      if (instance.page > pages) instance.page = pages;
      if (instance.page < 1) instance.page = 1;
      var start = (instance.page - 1) * instance.size;
      var end = start + instance.size;
      rows.forEach(function (row, index) {
        if (index >= start && index < end) return;
        row.hidden = true;
        row.dataset.wyPaginationHidden = '1';
      });
      instance.total.textContent = '共 ' + total + ' 条记录';
      renderNav(instance, pages);
    } finally {
      instance.rendering = false;
    }
  }
  function schedule(instance) {
    if (!instance || instance.scheduled) return;
    instance.scheduled = true;
    requestAnimationFrame(function () {
      instance.scheduled = false;
      render(instance);
    });
  }
  function hasOwnPagination(table) {
    var page = pageName();
    if (SKIP_PAGES.has(page)) return true;
    var anchor = table.closest('.table-wrap,.ana-table-wrap') || table;
    var parent = anchor.parentElement;
    if (!parent) return false;
    return !!parent.querySelector(':scope > .pagination:not(.wy-table-pagination), :scope > .footer, :scope > .beans-pager');
  }
  function initTable(table) {
    if (shouldSkipTable(table) || table.dataset.wyAutoPagination === '1' || hasOwnPagination(table)) return;
    var tbody = table.tBodies[0];
    var anchor = table.closest('.table-wrap,.ana-table-wrap') || table;
    if (!tbody || !anchor || !anchor.parentNode) return;
    var legacyFoot = anchor.nextElementSibling;
    if (legacyFoot && legacyFoot.classList.contains('foot')) legacyFoot.hidden = true;

    table.dataset.wyAutoPagination = '1';
    var footer = document.createElement('div');
    footer.className = 'pagination wy-table-pagination';

    var left = document.createElement('div');
    left.className = 'pagination-left';
    var total = document.createElement('span');
    total.className = 'wy-table-total';
    total.textContent = '共 0 条记录';
    var select = document.createElement('select');
    select.className = 'page-size-select';
    select.setAttribute('aria-label', '每页条数');
    PAGE_SIZES.forEach(function (size) {
      var option = document.createElement('option');
      option.value = String(size);
      option.textContent = size + '条/页';
      if (size === 10) option.selected = true;
      select.appendChild(option);
    });
    left.append(total, select);

    var nav = document.createElement('div');
    nav.className = 'pagination-right';
    footer.append(left, nav);
    anchor.insertAdjacentElement('afterend', footer);

    var instance = { table: table, tbody: tbody, footer: footer, total: total, select: select, nav: nav, page: 1, size: 10, scheduled: false, rendering: false };
    instances.push(instance);

    select.addEventListener('change', function () {
      instance.size = Number(select.value) || 10;
      instance.page = 1;
      schedule(instance);
    });
    nav.addEventListener('click', function (event) {
      var target = event.target.closest('[data-pg]');
      if (!target || target.disabled || target.classList.contains('disabled')) return;
      var page = Number(target.dataset.pg);
      if (!Number.isFinite(page)) return;
      instance.page = page;
      schedule(instance);
      var wrap = table.closest('.table-wrap,.ana-table-wrap');
      if (wrap) wrap.scrollTop = 0;
    });

    if ('MutationObserver' in window) {
      instance.observer = new MutationObserver(function () { schedule(instance); });
      instance.observer.observe(tbody, { childList: true, subtree: true });
    }
    schedule(instance);
  }
  function scan() {
    if (SKIP_PAGES.has(pageName())) return;
    document.querySelectorAll('table').forEach(initTable);
  }
  function scheduleAll() {
    instances.forEach(schedule);
    requestAnimationFrame(scan);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan, { once: true });
  else scan();

  if ('MutationObserver' in window && document.documentElement) {
    new MutationObserver(function (records) {
      if (records.some(function (record) { return record.addedNodes && record.addedNodes.length; })) requestAnimationFrame(scan);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener('input', scheduleAll, true);
  document.addEventListener('change', scheduleAll, true);
  window.WYERP_TABLE_PAGINATION = { scan: scan, refresh: scheduleAll };
})();