'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadRuntimeSecret(options = {}) {
  const envValue = String(options.envValue || '');
  if (envValue) return { secret: envValue, generated: false, source: 'environment' };
  if (options.production) return { secret: '', generated: false, source: 'missing' };
  const file = path.resolve(options.file);
  if (fs.existsSync(file)) {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length < 32) throw new Error('Runtime secret file is invalid: ' + file);
    return { secret: value, generated: false, source: 'file' };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const generated = crypto.randomBytes(32).toString('hex');
  var created = false;
  try {
    fs.writeFileSync(file, generated, { encoding: 'ascii', mode: 0o600, flag: 'wx' });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (value.length < 32) throw new Error('Runtime secret file is invalid: ' + file);
  return { secret: value, generated: created, source: 'file' };
}

module.exports = { loadRuntimeSecret };
