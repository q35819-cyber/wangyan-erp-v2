(function (root, factory) {
  'use strict';
  var api = factory(typeof module === 'object' && module.exports ? require('./searchable-select') : root.WYERP_SEARCHABLE_SELECT,
    typeof module === 'object' && module.exports ? require('./product-option-labels') : root.WYERP_PRODUCT_OPTION_LABELS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_PRODUCT_ATTRIBUTE_OPTIONS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (searchable, optionLabels) {
  'use strict';
  var controlSequence = 0;
  function dictionary(a) { return a.dictionaryId != null ? a.dictionaryId : a.dictionary_id; }
  function collection(a) { return Boolean(a.collection != null ? a.collection : a.is_collection); }
  function maximum(a) { return Number(a.maxValueCount != null ? a.maxValueCount : a.max_value_count) || 0; }
  function kind(a) { return Number(dictionary(a)) > 0 ? 'dictionary' : (/^boolean$/i.test(a.type || '') ? 'boolean' : ''); }
  function isColor(a) { return String(a.id || a.attribute_id) === '10096'; }
  function multiple(a) { return collection(a) && maximum(a) !== 1; }
  function serialize(items, multi) {
    return items.map(function (item) { var value = String(item.value); return multi && /[;；"\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value; }).join('; ');
  }
  function split(value) {
    var result = [], part = '', quoted = false;
    for (var i = 0; i < value.length; i++) {
      var char = value[i];
      if (char === '"') { if (quoted && value[i + 1] === '"') { part += '"'; i++; } else quoted = !quoted; }
      else if (!quoted && /[;；]/.test(char)) { if (part.trim()) result.push(part.trim()); part = ''; }
      else part += char;
    }
    if (quoted) return [value];
    if (part.trim()) result.push(part.trim());
    return result;
  }
  function selection(a, value) {
    value = String(value == null ? '' : value);
    if (!value) return [];
    var old = Array.isArray(a.values) ? a.values : [];
    if ((a.value == null || String(a.value) === value) && old.length && serialize(old.map(function (item) { return { value: item.value == null ? item.dictionary_value_id : item.value }; }), multiple(a) || old.length > 1) === value) {
      return old.map(function (item) { return { id: item.dictionary_value_id == null ? '' : String(item.dictionary_value_id), value: String(item.value == null ? item.dictionary_value_id : item.value) }; });
    }
    return (multiple(a) ? split(value) : [value]).map(function (text) {
      var match = old.find(function (item) { return String(item.value) === text; });
      return { id: match && match.dictionary_value_id != null ? String(match.dictionary_value_id) : '', value: text };
    });
  }
  function applySelection(a, items) {
    var old = Array.isArray(a.values) ? a.values : [];
    a.value = serialize(items, multiple(a) || items.length > 1);
    a.values = items.map(function (item) {
      var existing = old.find(function (v) { return item.id ? String(v.dictionary_value_id) === String(item.id) : v.dictionary_value_id == null && String(v.value) === item.value; });
      var value = Object.assign({}, existing || {}, { value: String(item.value) });
      if (item.id) value.dictionary_value_id = existing ? existing.dictionary_value_id : identifier(item.id);
      else delete value.dictionary_value_id;
      return value;
    });
    return a.value;
  }
  function identifier(value) {
    if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('类目或属性编号无效，请重新载入类目');
    return Number(value);
  }
  function parsePage(data, cursor, searching) {
    if (!data || !Array.isArray(data.result)) throw new Error('平台未返回有效的选项列表');
    var seen = new Set(), items = [];
    data.result.forEach(function (item) {
      var id = identifier(item.id), value = item.value == null ? '' : String(item.value);
      if (!value || seen.has(id)) return;
      seen.add(id); items.push({ id: String(id), value: value, info: String(item.info || ''), evidenceToken: typeof item.evidenceToken === 'string' ? item.evidenceToken : '' });
    });
    var hasNext = !searching && data.has_next === true;
    var next = data.result.length ? identifier(data.result[data.result.length - 1].id) : 0;
    if (hasNext && (!items.length || next === Number(cursor))) throw new Error('平台选项分页未前进，请重试');
    return { items: items, hasNext: hasNext, cursor: next };
  }
  function createLoader(request, settings) {
    settings = settings || {};
    var cache = new Map(), queue = [], running = 0;
    function russianPage(data, cursor, searching) {
      var parsed = data && Array.isArray(data.items) ? { items: data.items.slice(), hasNext: data.hasNext === true, cursor: Number(data.cursor || 0) } : parsePage(data, cursor, searching);
      if (parsed.items.some(function (item) { return optionLabels.chinese(item.value); })) throw new Error('平台未返回有效的俄文选项原值，请重试；未映射的中文值不会显示或保存');
      parsed.items = parsed.items.map(function (item) { return Object.assign({}, item, { sourceLanguage: 'RU' }); });
      return parsed;
    }
    function pairChineseLabels(a, russian, chineseData, cursor) {
      var chinesePage = parsePage(chineseData, cursor, false), byId = new Map();
      chinesePage.items.forEach(function (item) {
        if (optionLabels.chinese(item.value)) byId.set(String(item.id), item.value);
      });
      russian.items = russian.items.map(function (item) {
        return Object.assign({}, item, { labelZh: byId.get(String(item.id)) || optionLabels.lookup(item.value, 'zh', a) || '' });
      });
      return russian;
    }
    function pump() {
      while (running < 3 && queue.length) {
        var task = queue.shift(); running++;
        Promise.resolve().then(task.run).then(task.resolve, task.reject).finally(function () { running--; pump(); });
      }
    }
    function loadColors(a, context, page) {
      var body, key;
      try {
        body = { attribute_id: identifier(a.id || a.attribute_id), description_category_id: identifier(context.descriptionCategoryId), type_id: identifier(context.typeId), limit: 1000 };
        key = JSON.stringify([context.scope || '', 'color-RU-ZH-v1', context.version || '', body.description_category_id, body.type_id, body.attribute_id, dictionary(a)]);
        if (context.alive && !context.alive()) throw new Error('账号或类目已切换');
      } catch (error) { return Promise.reject(error); }
      // Color searches filter this complete paired dictionary locally; search responses without a language cannot replace Russian originals.
      if (cache.has(key) && !(page && page.force)) return cache.get(key);
      var local = settings.cache && !(page && page.force) ? settings.cache.get('colorOptions', key).catch(function () { return null; }) : Promise.resolve(null);
      function check() { if (context.alive && !context.alive()) throw new Error('账号或类目已切换'); }
      function scan(language) {
        var result = [], seen = new Set(), pages = 0;
        function next(cursor) {
          check();
          if (++pages > 100) throw new Error('颜色字典分页过多，请重试或检查平台响应');
          return request('/v1/description-category/attribute/values', Object.assign({}, body, { language: language, last_value_id: cursor }), context).then(function (data) {
            check(); var parsed = parsePage(data, cursor, false);
            if (parsed.hasNext && seen.has(parsed.cursor)) throw new Error('颜色字典分页未前进，请重试');
            seen.add(parsed.cursor); result = result.concat(parsed.items);
            return parsed.hasNext ? next(parsed.cursor) : result;
          });
        }
        return next(0);
      }
      var promise = local.then(function (saved) {
        check(); if (saved) return saved;
        if (!context.shop) throw new Error('本地暂无俄文颜色字典，且没有可用店铺读取，请检查店铺配置后重试');
        return new Promise(function (resolve, reject) {
          queue.push({ resolve: resolve, reject: reject, run: function () {
            return scan('RU').then(function (russian) {
              if (!russian.length || russian.some(function (item) { return /[\u3400-\u9fff]/.test(item.value); })) throw new Error('平台未返回有效的俄文颜色原值，请重试；已有内容保留');
              return scan('ZH_HANS').then(function (chinese) {
                var byId = new Map(); chinese.forEach(function (item) { if (optionLabels.chinese(item.value)) byId.set(item.id, item.value); });
                var unique = new Map(); russian.forEach(function (item) {
                  unique.set(item.id, Object.assign({}, item, { sourceLanguage: 'RU', labelZh: byId.get(item.id) || optionLabels.lookup(item.value, 'zh', a) || '' }));
                });
                var result = { items: Array.from(unique.values()), hasNext: false, cursor: 0 };
                check();
                return (settings.cache ? settings.cache.put('colorOptions', key, result) : Promise.resolve()).then(function () { return result; });
              });
            });
          } }); pump();
        });
      }).catch(function (error) { if (cache.get(key) === promise) cache.delete(key); throw error; });
      cache.set(key, promise); if (cache.size > 120) cache.delete(cache.keys().next().value); return promise;
    }
    return {
      load: function (a, context, page) {
        if (isColor(a)) return loadColors(a, context, page);
        if (kind(a) === 'boolean') return Promise.resolve({ items: [{ id: '', value: 'true', label: '是' }, { id: '', value: 'false', label: '否' }], hasNext: false, cursor: 0 });
        page = page || {};
        var query = String(page.query || '').trim(), cursor = Number(page.cursor || 0), body;
        try {
          if (context.alive && !context.alive()) throw new Error('账号或类目已切换');
          body = { attribute_id: identifier(a.id || a.attribute_id), description_category_id: identifier(context.descriptionCategoryId), type_id: identifier(context.typeId), limit: query ? 100 : 1000 };
          if (query) { if (query.length < 2) throw new Error('搜索选项至少输入两个字符'); body.value = query; }
          else { body.last_value_id = cursor; body.language = 'RU'; }
        } catch (error) { return Promise.reject(error); }
        var parts = [context.scope || '', 'public-dictionary-ru-zh-v4', context.version || '', body.description_category_id, body.type_id, body.attribute_id, dictionary(a), query, cursor];
        var key = JSON.stringify(parts);
        if (cache.has(key) && !page.force) return cache.get(key);
        function readLocal() {
          if (!settings.cache || page.force) return Promise.resolve(null);
          return settings.cache.get('options', key).then(function (saved) { return saved ? russianPage(saved, cursor, Boolean(query)) : null; }).catch(function () { return null; });
        }
        // IndexedDB hits never wait behind slow platform requests or require a selected listing shop.
        var promise = readLocal().then(function (cached) {
          if (context.alive && !context.alive()) throw new Error('账号或类目已切换');
          if (cached) return cached;
          if (!context.shop) throw new Error('本地暂无这些选项，且没有可用店铺读取公共字典，请检查店铺配置后重试');
          return new Promise(function (resolve, reject) {
            queue.push({ resolve: resolve, reject: reject, run: function () {
              if (context.alive && !context.alive()) throw new Error('账号或类目已切换');
              return request(query ? '/v1/description-category/attribute/values/search' : '/v1/description-category/attribute/values', body, context).then(function (data) {
                var result = russianPage(data, cursor, Boolean(query));
                if (!query) {
                  return request('/v1/description-category/attribute/values', Object.assign({}, body, { language: 'ZH_HANS' }), context).then(function (chineseData) {
                    return pairChineseLabels(a, result, chineseData, cursor);
                  });
                }
                return result;
              }).then(function (result) {
                if (!result.items.length && !query && !cursor) throw new Error('平台暂未返回可选值，请重试；已有值保留');
                if (settings.cache) return settings.cache.put('options', key, result).then(function () { return result; });
                return result;
              });
            } }); pump();
          });
        }).catch(function (error) { if (cache.get(key) === promise) cache.delete(key); throw error; });
        cache.set(key, promise);
        if (cache.size > 120) cache.delete(cache.keys().next().value);
        return promise;
      }
    };
  }
  function isNoBrand(item) { return /^(无品牌|無品牌|нет\s+бренда|без\s+бренда|no\s*brand|unbranded)$/i.test(String(item && (item.value || item.labelZh || item.label) || '').trim()); }
  function identifiedNoBrand(item) { return isNoBrand(item) && /^\d+$/.test(String(item.id)) && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0; }
  function mount(input, a, settings) {
    if (!input.id) input.id = 'product-choice-input-' + (++controlSequence);
    var selected = selection(settings.stored || a, input.value), items = [], cursor = 0, hasNext = false, started = false, disposed = false, busy = false, searching = false;
    var query = '', errorText = '', timer = null, queryRevision = 0, noBrandDone = false, noBrandMissing = false;
    var isMulti = multiple(a), brand = settings.brand === true, originalType = input.type, canChangeType = input.tagName === 'INPUT';
    // A saved no-brand choice with its real dictionary ID stays available when it
    // falls outside the loaded public page. Keep it private to this control.
    var knownNoBrand = brand && selected.find(identifiedNoBrand);
    function noBrandChoice() { return items.find(isNoBrand) || knownNoBrand; }
    function alive() { return !disposed && (!settings.context.alive || settings.context.alive()); }
    function display(item) {
      if (brand && isNoBrand(item)) return Object.assign({}, item, { label: '无品牌' });
      if (kind(a) === 'boolean' && /^(true|false)$/.test(item.value)) return Object.assign({}, item, { label: item.value === 'true' ? '是' : '否' });
      if (optionLabels) return optionLabels.display(a, item, items);
      return item;
    }
    function resolveUnidentifiedSelection() {
      var changed = false;
      var rendered = combo && typeof combo.selectedItems === 'function' ? combo.selectedItems() : selected;
      var resolved = selected.map(function (chosen, index) {
        if (String(chosen.value || '').trim()) return chosen;
        var visible = rendered[index] || chosen;
        var expected = String(visible.labelZh || visible.label || chosen.labelZh || chosen.label || '').trim();
        if (!expected) return chosen;
        var matches = items.filter(function (candidate) {
          var shown = display(candidate);
          return candidate.id && String(candidate.value || '').trim() && String(shown.label || shown.value || '').trim() === expected;
        });
        if (matches.length !== 1) return chosen;
        changed = true;
        return matches[0];
      });
      if (!changed) return;
      selected = resolved;
      input.value = serialize(selected, isMulti || selected.length > 1);
      settings.change(selected, input.value);
    }
    function merge(incoming) {
      incoming.forEach(function (item) {
        var old = items.find(function (v) { return item.id ? String(v.id) === String(item.id) : !v.id && v.value === item.value; });
        if (!old) items.push(item);
        else if (isColor(a)) Object.assign(old, item);
        else if (optionLabels.chinese(item.labelZh)) old.labelZh = item.labelZh;
        else if (optionLabels.chinese(item.value)) old.labelZh = item.value;
      });
      // Some drafts created by the old tag UI retained only a Chinese display
      // label. Repair only an exact, unique match from the current RU dictionary.
      resolveUnidentifiedSelection();
      if (isColor(a)) {
        // Upgrade legacy selections by ID only. Never infer a Russian original from a Chinese label.
        var resolved = selected.map(function (item) { return items.find(function (v) { return item.id && v.id === item.id && v.sourceLanguage === 'RU'; }) || item; });
        if (resolved.some(function (item, i) { return item !== selected[i]; })) {
          selected = resolved; input.value = serialize(selected, isMulti || selected.length > 1); settings.change(selected, input.value);
        }
        if (settings.resolved) settings.resolved();
        return;
      }
      var resolved = selected.map(function (item) { return items.find(function (v) { return item.id && v.id === item.id && v.sourceLanguage === 'RU'; }) || item; });
      if (resolved.some(function (item, i) { return item !== selected[i]; })) {
        selected = resolved; input.value = serialize(selected, isMulti || selected.length > 1); settings.change(selected, input.value);
      }
      if (!settings.localizer) return;
      settings.localizer.localize(a, incoming, settings.context, false).then(function (localized) {
        if (!alive()) return;
        localized.forEach(function (item) {
          var old = items.find(function (v) { return String(v.id) === String(item.id); });
          if (old && item.labelZh) old.labelZh = item.labelZh;
          if (old) old.translationError = item.translationError || '';
        }); resolveUnidentifiedSelection(); render();
      }).catch(function (error) { if (alive()) { errorText = error.message || '中文映射读取失败'; render(); } });
    }
    function retryLabels() {
      if (!settings.localizer) return Promise.resolve();
      var oldSelected = selected;
      return Promise.all([settings.localizer.localize(a, items, settings.context, true), settings.localizer.selectionLabels(a, selected, settings.context, true)]).then(function (results) {
        if (!alive()) return;
        results[0].forEach(function (item) { var old = items.find(function (v) { return String(v.id) === String(item.id); }); if (old) Object.assign(old, { labelZh: item.labelZh || old.labelZh, translationError: item.translationError || '' }); });
        if (selected === oldSelected) selected = results[1]; render();
      });
    }
    function render() {
      if (disposed) return;
      // The visible chips are the selected value, while `input` is the hidden
      // source consumed by draft/submit collection. Keep both synchronized
      // after restore and asynchronous label refreshes.
      input.value = serialize(selected, isMulti || selected.length > 1);
      var displayed = items.map(display), chosen = selected.map(display);
      if (brand) {
        var none = noBrandChoice();
        displayed = displayed.filter(function (item) { return !isNoBrand(item); });
        displayed.unshift(none ? display(none) : { id: '', value: '无品牌', label: '无品牌', disabled: true, info: noBrandDone ? '当前字典暂未匹配到无品牌，请重试读取选项' : '正在匹配平台无品牌选项' });
      }
      var unmapped = items.concat(selected).filter(function (item) { return item.translationError && !item.labelZh && !optionLabels.lookup(item.value, 'zh', a) && !items.some(function (v) { return v.id === item.id && v.labelZh; }); });
      var mappingError = unmapped.length ? unmapped.length + ' 项尚未完成中文翻译：' + unmapped[0].translationError : '';
      combo.update({ items: displayed, selected: chosen, hasNext: hasNext, busy: busy || searching, error: errorText || (noBrandMissing ? '平台暂未匹配到无品牌选项，可重试；其他品牌仍可选择' : '') || mappingError, disabled: !alive() });
    }
    function write(next) {
      if (!alive()) { errorText = '账号、店铺或类目已变化，请重新载入选项'; render(); return; }
      selected = next; errorText = ''; input.value = serialize(selected, isMulti || selected.length > 1);
      if (brand) knownNoBrand = selected.find(identifiedNoBrand) || knownNoBrand;
      settings.change(selected, input.value); input.dispatchEvent(new Event('input', { bubbles: true })); render();
    }
    function choose(choice) {
      if (isColor(a) && choice.sourceLanguage !== 'RU') { errorText = '该颜色的俄文原值尚未加载，请重试读取颜色字典'; render(); return; }
      if (!isMulti) return write([choice]);
      if (isColor(a) && selected.some(function (item) { return item.sourceLanguage !== 'RU'; })) { errorText = '请先移除未匹配俄文字典 ID 的旧颜色，再选择新颜色'; render(); return; }
      var next = selected.slice(), legacy = next.findIndex(function (item) { return !item.id && item.value === choice.value; });
      if (maximum(a) > 0 && next.length >= maximum(a) && legacy < 0) { errorText = '此属性最多选择 ' + maximum(a) + ' 项'; render(); return; }
      if (legacy >= 0) next[legacy] = choice;
      else if (!next.some(function (item) { return item.id ? item.id === choice.id : item.value === choice.value; })) next.push(choice);
      write(next);
    }
    function resolveNoBrand(force) {
      if (!brand || noBrandDone || !alive()) return Promise.resolve();
      noBrandDone = true; noBrandMissing = false;
      var terms = ['无品牌', 'Нет бренда', 'Без бренда', 'No brand'];
      function next() {
        if (!alive() || noBrandChoice() || !terms.length) { noBrandMissing = alive() && !noBrandChoice(); render(); return Promise.resolve(); }
        return settings.loader.load(a, settings.context, { query: terms.shift(), force: force }).then(function (page) { if (alive()) merge(page.items.filter(isNoBrand)); }).catch(function () {}).then(next);
      }
      return next();
    }
    function load(next, force) {
      if (busy || !alive()) return Promise.resolve();
      busy = true; started = true; errorText = ''; render();
      return settings.loader.load(a, settings.context, { cursor: next ? cursor : 0, force: force }).then(function (page) {
        if (!alive()) return;
        merge(page.items); cursor = page.cursor; hasNext = page.hasNext;
      }).catch(function (error) { if (alive()) errorText = error.message || '读取选项失败'; }).finally(function () {
        busy = false; if (items.some(isNoBrand)) noBrandMissing = false; render(); resolveNoBrand(force);
        // A one-character fuzzy query is local; read subsequent pages automatically while the list stays open.
        if (alive() && combo.isOpen() && (query.trim().length === 1 || items.length < 80) && hasNext && !errorText) timer = setTimeout(function () { load(true); }, 250);
      });
    }
    function search(text) {
      query = text; clearTimeout(timer); var revision = ++queryRevision; searching = false; errorText = ''; render();
      if (!text.trim()) return;
      if (text.trim().length === 1) { if (hasNext) timer = setTimeout(function () { load(true); }, 250); return; }
      if (!hasNext && started && !busy) return;
      timer = setTimeout(function () {
        if (!alive()) return; searching = true; render();
        settings.loader.load(a, settings.context, { query: text.trim() }).then(function (page) { if (alive() && revision === queryRevision) merge(page.items); }).catch(function (error) { if (alive() && revision === queryRevision) errorText = error.message || '搜索选项失败'; }).finally(function () { if (revision === queryRevision) { searching = false; render(); } });
      }, 250);
    }
    var colorInVariant = Boolean(isColor(a) && input.closest('.variant-table'));
    var combo = searchable.mount(input, { label: input.getAttribute('aria-label') || a.name || '属性', multiple: isMulti, maxVisibleTags: 0, compactSelection: colorInVariant,
      onPick: choose, onRemove: function (index) { write(selected.filter(function (_, i) { return index !== i; })); }, onClear: function () { write([]); },
      onSelectionRendered: function (visible) { input.value = serialize(visible, isMulti || visible.length > 1); },
      onOpen: function () { if (!started) load(false); else if (hasNext && items.length < 80) load(true); }, onClose: function () { clearTimeout(timer); query = ''; queryRevision++; searching = false; },
      onQuery: search, onMore: function () { if (hasNext) load(true); }, onRetry: function () {
        if (brand && noBrandMissing) { noBrandDone = false; resolveNoBrand(true); return; }
        if (!errorText && !noBrandMissing && items.concat(selected).some(function (item) { return item.translationError; })) { retryLabels().catch(function (error) { if (alive()) { errorText = error.message; render(); } }); return; }
        noBrandDone = false; if (query.trim().length > 1) search(query); else load(hasNext, true);
      }
    });
    var searchableHost = input.previousElementSibling;
    if (isColor(a) && searchableHost && searchableHost.classList && searchableHost.classList.contains('searchable-select')) searchableHost.classList.add('searchable-select-color');
    if (canChangeType) input.type = 'hidden'; input.dataset.choiceInput = 'true'; input.dataset.choiceMultiple = String(isMulti); render();
    if (!isColor(a) && settings.localizer && settings.localizer.selectionLabels) {
      var originalSelection = selected;
      settings.localizer.selectionLabels(a, selected, settings.context).then(function (localized) { if (alive() && selected === originalSelection) { selected = localized; render(); } });
    }
    return { input: input, syncInput: function () {
      // Read the same state that rendered the visible chips. This also protects
      // collection when a late label refresh has replaced the displayed item.
      var visible = typeof combo.selectedItems === 'function' ? combo.selectedItems() : selected;
      input.value = serialize(visible, isMulti || visible.length > 1);
      return input.value;
    }, needsResolution: function () { return selected.some(function (item) { return !String(item.value || '').trim(); }); }, colorSelection: function () { return selected.map(function (item) { return items.find(function (v) { return item.id && v.id === item.id && v.sourceLanguage === 'RU'; }) || item; }); }, activate: function () { if (!started && alive() && input.isConnected) load(false); }, destroy: function () { disposed = true; clearTimeout(timer); queryRevision++; combo.destroy(); if (canChangeType) input.type = originalType; delete input.dataset.choiceInput; delete input.dataset.choiceMultiple; } };
  }
  return { kind: kind, multiple: multiple, serialize: serialize, selection: selection, applySelection: applySelection, parsePage: parsePage, createLoader: createLoader, mount: mount };
});
