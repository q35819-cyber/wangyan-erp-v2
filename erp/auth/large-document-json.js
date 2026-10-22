'use strict';

// A category catalog can exceed 100 MB. JSON.stringify(library) in a database
// transaction blocks the HTTP event loop and holds a pooled PG connection for
// the entire serialization. Serialize one category at a time and yield so
// health requests, DB sockets and other tenants can make progress.
async function stringifyLargeCategoryDocument(library, options = {}) {
  if (!library || typeof library !== 'object' || Array.isArray(library)
      || !library.categories || typeof library.categories !== 'object' || Array.isArray(library.categories)) {
    return JSON.stringify(library);
  }
  const sliceMs = Math.max(1, Math.min(25, Number(options.sliceMs) || 8));
  const parts = ['{'];
  let firstRoot = true;
  let lastYield = Date.now();
  const yieldToHttp = async () => {
    if (Date.now() - lastYield < sliceMs) return;
    await new Promise(resolve => setImmediate(resolve));
    lastYield = Date.now();
  };
  for (const key of Object.keys(library)) {
    const value = library[key];
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    if (!firstRoot) parts.push(',');
    firstRoot = false;
    parts.push(JSON.stringify(key), ':');
    if (key !== 'categories') {
      parts.push(JSON.stringify(value));
      await yieldToHttp();
      continue;
    }
    parts.push('{');
    let firstCategory = true;
    let processedCategories = 0;
    for (const categoryKey of Object.keys(value)) {
      const category = value[categoryKey];
      if (category === undefined || typeof category === 'function' || typeof category === 'symbol') continue;
      if (!firstCategory) parts.push(',');
      firstCategory = false;
      parts.push(JSON.stringify(categoryKey), ':', JSON.stringify(category));
      processedCategories += 1;
      // Also yield by item count on fast machines where elapsed milliseconds
      // alone would otherwise skip every yield in a moderately large batch.
      if (processedCategories % 64 === 0) {
        await new Promise(resolve => setImmediate(resolve));
        lastYield = Date.now();
      } else await yieldToHttp();
    }
    parts.push('}');
  }
  parts.push('}');
  await yieldToHttp();
  // Joining only happens after independent category strings have been built.
  // The output is byte-for-byte equivalent to compact JSON.stringify for the
  // JSON-shaped Ozon catalog; no business fields are converted or discarded.
  return parts.join('');
}

module.exports = { stringifyLargeCategoryDocument };
