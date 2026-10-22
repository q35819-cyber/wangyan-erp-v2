'use strict';

const combination = require('../assets/product-combination');

const arr = value => Array.isArray(value) ? value : [];
const text = value => String(value == null ? '' : value).trim();

function collectionRef(value) {
  const id = text(value);
  return id ? 'collection:' + id : '';
}

function bundleCollectionId(bundle) {
  return text(bundle && (bundle.collectionId || bundle.collection_id));
}

function collectionImageCandidates(item) {
  item = item && typeof item === 'object' ? item : {};
  const capture = item.capture && typeof item.capture === 'object' && !Array.isArray(item.capture) ? item.capture : {};
  const out = [], seen = new Set();
  function add(value) {
    if (value && typeof value === 'object') value = value.url || value.imageUrl || value.image || value.src || value.thumbnailUrl;
    const url = text(value);
    if (!/^https:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url); out.push(url);
  }
  add(item.referenceImage); add(item.image); arr(item.images).forEach(add);
  add(capture.primarySkuImage);
  arr(capture.skuImages).forEach(add);
  arr(capture.variants).forEach(add);
  arr(capture.media).forEach(entry => {
    if (!entry || text(entry.kind).toLowerCase() !== 'image') return;
    add(entry);
  });
  return out;
}

function bundleImageCandidates(bundle) {
  bundle = bundle && typeof bundle === 'object' ? bundle : {};
  const values = [bundle.referenceImage].concat(arr(bundle.imageCandidates));
  if (bundle.sourceSnapshot && typeof bundle.sourceSnapshot === 'object') {
    values.push(...collectionImageCandidates(bundle.sourceSnapshot));
  }
  return values.map(text).filter(url => /^https:\/\//i.test(url));
}

function resolveReferenceUrls(input) {
  input = input && typeof input === 'object' ? input : {};
  const variant = input.variant && typeof input.variant === 'object' ? input.variant : {};
  const product = input.product && typeof input.product === 'object' ? input.product : {};
  const collections = arr(input.collections);
  const maxReferences = Math.max(0, Math.min(7, Number(input.maxReferences) || 7));
  if (!maxReferences) return [];

  const bundles = combination.normalizeBundles(product.sourceBundles || []);
  const bundleById = new Map(bundles.map(bundle => [bundle.id, bundle]));
  const bundleByCollection = new Map(bundles.filter(bundleCollectionId).map(bundle => [bundleCollectionId(bundle), bundle]));
  const collectionById = new Map(collections.map(item => [text(item && item.id), item]).filter(row => row[0]));
  const relations = combination.normalizeRelations(arr(input.relations).concat(arr(product.combinationRelations)));
  const aliases = combination.normalizeAliases(input.aliases || []);
  const relationGraph = combination.validateGraph(relations, aliases);
  if (!relationGraph.ok) {
    const error = new Error('组合关系存在循环，无法为AI重绘准备参考图：' + arr(relationGraph.path).join(' → '));
    error.publicCode = 'combination_cycle';
    error.status = 409;
    throw error;
  }

  const parentRef = text(variant.erpVariantRef) ? 'variant:' + text(variant.erpVariantRef) : '';
  const startRefs = [];
  arr(variant.sourceBundleIds).forEach(id => {
    const bundle = bundleById.get(text(id));
    const ref = bundle && bundleCollectionId(bundle) ? collectionRef(bundleCollectionId(bundle)) : '';
    if (ref && !startRefs.includes(ref)) startRefs.push(ref);
  });
  if (parentRef) relations.filter(relation => relation.parentRef === parentRef).forEach(relation => {
    if (relation.childRef && !startRefs.includes(relation.childRef)) startRefs.push(relation.childRef);
  });

  const byParent = new Map(), aliasByCollection = new Map(aliases.map(alias => ['collection:' + alias.collectionId, 'variant:' + alias.variantRef]));
  relations.forEach(relation => {
    if (!byParent.has(relation.parentRef)) byParent.set(relation.parentRef, []);
    byParent.get(relation.parentRef).push(relation);
  });
  function outgoing(ref) {
    const direct = arr(byParent.get(ref));
    if (direct.length) return direct;
    const alias = aliasByCollection.get(ref);
    return alias ? arr(byParent.get(alias)) : [];
  }

  const urls = [], seenUrls = new Set(), visitedRefs = new Set();
  function addUrl(url) {
    url = text(url);
    if (!/^https:\/\//i.test(url) || seenUrls.has(url) || urls.length >= maxReferences) return;
    seenUrls.add(url); urls.push(url);
  }
  function visit(ref, depth) {
    if (!ref || depth > 10 || visitedRefs.has(ref) || urls.length >= maxReferences) return;
    visitedRefs.add(ref);
    if (ref.startsWith('collection:')) {
      const id = ref.slice('collection:'.length);
      const item = collectionById.get(id);
      if (item) {
        const trusted = collectionImageCandidates(item), trustedSet = new Set(trusted);
        const bundle = bundleByCollection.get(id);
        if (bundle) bundleImageCandidates(bundle).filter(url => trustedSet.has(url)).forEach(addUrl);
        trusted.forEach(addUrl);
      }
    }
    outgoing(ref).forEach(relation => visit(relation.childRef, depth + 1));
  }
  startRefs.forEach(ref => visit(ref, 1));
  return urls.slice(0, maxReferences);
}

module.exports = { collectionImageCandidates, resolveReferenceUrls };
