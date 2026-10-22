'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sha256File } = require('./private-object-store');

const MAGIC = Buffer.from('WYERP-P2-AES256GCM\0', 'ascii');

function parseArchiveKey(value) {
  const text = String(value || '').trim();
  let key;
  if (/^[a-f0-9]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  else {
    try { key = Buffer.from(text, 'base64'); } catch (_) { key = Buffer.alloc(0); }
  }
  if (key.length !== 32) throw new Error('ERP_MIGRATION_ARCHIVE_KEY must be exactly 32 bytes encoded as hex or base64');
  return key;
}

function derivedKey(masterKey, salt) {
  return crypto.hkdfSync('sha256', masterKey, salt, Buffer.from('wyerp-p2-file-archive', 'ascii'), 32);
}

async function encryptFile(source, target, masterKey) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(masterKey, salt), iv);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    output.write(MAGIC); output.write(salt); output.write(iv);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(source);
      input.on('error', reject); cipher.on('error', reject); output.on('error', reject);
      output.on('finish', resolve);
      input.pipe(cipher).pipe(output, { end: false });
      cipher.on('end', () => { output.write(cipher.getAuthTag()); output.end(); });
    });
  } catch (error) {
    try { fs.unlinkSync(target); } catch (_) { /* failed output only */ }
    throw error;
  }
  return { ciphertextSha256: await sha256File(target), bytes: fs.statSync(target).size };
}

async function decryptFile(source, target, masterKey) {
  const stat = fs.statSync(source);
  const overhead = MAGIC.length + 16 + 12 + 16;
  if (stat.size < overhead) throw new Error('encrypted archive file is truncated');
  const descriptor = fs.openSync(source, 'r');
  try {
    const header = Buffer.alloc(MAGIC.length + 16 + 12);
    fs.readSync(descriptor, header, 0, header.length, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('encrypted archive magic is invalid');
    const salt = header.subarray(MAGIC.length, MAGIC.length + 16);
    const iv = header.subarray(MAGIC.length + 16);
    const tag = Buffer.alloc(16);
    fs.readSync(descriptor, tag, 0, 16, stat.size - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(masterKey, salt), iv);
    decipher.setAuthTag(tag);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (stat.size === overhead) {
      const plaintext = decipher.final();
      fs.writeFileSync(target, plaintext, { flag: 'wx', mode: 0o600 });
      return;
    }
    const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(source, { start: header.length, end: stat.size - 17 });
      input.on('error', reject); decipher.on('error', reject); output.on('error', reject); output.on('finish', resolve);
      input.pipe(decipher).pipe(output);
    });
  } catch (error) {
    try { fs.unlinkSync(target); } catch (_) { /* failed restored output only */ }
    throw error;
  } finally { fs.closeSync(descriptor); }
}

module.exports = { MAGIC, parseArchiveKey, encryptFile, decryptFile };
