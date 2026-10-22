'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, KEY_LENGTH);
  return `scrypt-v1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [version, saltHex, hashHex] = String(encoded || '').split('$');
    if (!['scrypt-v1', 'scrypt-legacy-v1'].includes(version) || !/^[a-f0-9]{32}$/i.test(saltHex) || !/^[a-f0-9]{128}$/i.test(hashHex)) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const salt = version === 'scrypt-legacy-v1' ? saltHex : Buffer.from(saltHex, 'hex');
    const actual = await scrypt(String(password), salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (error) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
