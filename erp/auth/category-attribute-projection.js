'use strict';

const crypto = require('crypto');

const PROJECTION_SCHEMA_VERSION = 1;
const ATTRIBUTE_FIELDS = [
  'id', 'name', 'type', 'aspect', 'groupId', 'groupName', 'collection',
  'description', 'dictionaryId', 'maxValueCount', 'categoryDependent',
  'complexId', 'complexCollection'
];

function text(value) { return String(value == null ? '' : value).trim(); }

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function projectAttribute(attribute, required) {
  const source = attribute && typeof attribute === 'object' ? attribute : {};
  const projected = {};
  for (const field of ATTRIBUTE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  projected.id = text(projected.id);
  projected.name = text(projected.name);
  projected.required = Boolean(required);
  if (!/^\d+$/.test(projected.id) || !projected.name) throw new Error('category attribute id and name are required');
  return projected;
}

function projectPath(pathValue) {
  return (Array.isArray(pathValue) ? pathValue : []).map((item, index) => ({
    id: text(item && item.id),
    name: text(item && item.name),
    level: Number(item && item.level) || index + 1
  })).filter(item => item.id && item.name);
}

function projectCategory(category, fallbackKey) {
  const source = category && typeof category === 'object' ? category : {};
  const descriptionCategoryId = text(source.descriptionCategoryId);
  const typeId = text(source.typeId);
  if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) {
    throw new Error(`category ${fallbackKey || '<unknown>'} lacks deterministic platform ids`);
  }
  const key = `${descriptionCategoryId}:${typeId}`;
  const path = projectPath(source.path);
  return {
    key,
    descriptionCategoryId,
    typeId,
    disabled: Boolean(source.disabled),
    path,
    pathText: text(source.pathText || path.map(item => item.name).join(' > ')),
    required: (Array.isArray(source.required) ? source.required : []).map(item => projectAttribute(item, true)),
    optional: (Array.isArray(source.optional) ? source.optional : []).map(item => projectAttribute(item, false))
  };
}

function projectLibrary(library, options = {}) {
  const source = library && typeof library === 'object' && !Array.isArray(library) ? library : {};
  if (source.status !== 'done' || (Array.isArray(source.failures) && source.failures.length)) {
    throw new Error('only a completed category library without failures can be projected');
  }
  const categories = Object.entries(source.categories || {}).map(([key, item]) => projectCategory(item, key));
  categories.sort((left, right) => left.key.localeCompare(right.key, 'en'));
  if (!categories.length || categories.length !== Number(source.totalCategories || categories.length)) {
    throw new Error('category projection count does not match the completed source library');
  }
  const requiredAttributes = categories.reduce((total, item) => total + item.required.length, 0);
  const optionalAttributes = categories.reduce((total, item) => total + item.optional.length, 0);
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    platform: 'ozon',
    source: text(source.source || 'OZON Seller API'),
    sourceUpdatedAt: source.updatedAt || source.completedAt || null,
    generatedAt: options.generatedAt || new Date().toISOString(),
    sourceSnapshotSha256: text(options.sourceSnapshotSha256),
    counts: {
      categories: categories.length,
      requiredAttributes,
      optionalAttributes,
      totalAttributes: requiredAttributes + optionalAttributes
    },
    categories
  };
}

function projectionContentSha256(projection) {
  return sha256Text(canonicalJson(projection));
}

module.exports = {
  PROJECTION_SCHEMA_VERSION,
  ATTRIBUTE_FIELDS,
  projectAttribute,
  projectCategory,
  projectLibrary,
  projectionContentSha256
};
