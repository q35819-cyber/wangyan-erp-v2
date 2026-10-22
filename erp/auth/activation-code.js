'use strict';

const crypto = require('crypto');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createActivationCode() {
  let value = '';
  while (value.length < 24) value += ALPHABET[crypto.randomInt(ALPHABET.length)];
  const code = value.match(/.{4}/g).join('-');
  return { code, digest: crypto.createHash('sha256').update(code).digest('hex'), mask: code.slice(0, 4) + '-****-****-****-****-' + code.slice(-4) };
}

module.exports = { createActivationCode };
