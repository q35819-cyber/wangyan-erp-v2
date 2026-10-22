'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function pathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class PrivateObjectStore {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.encryptionKey = normalizeEncryptionKey(options.encryptionKey);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  encryptionAvailable() {
    return Boolean(this.encryptionKey);
  }

  async putFile({ tenantId, kind, sourceFile, sha256 }) {
    if (!/^\d+$/.test(String(tenantId))) throw new Error('private object tenant id is required');
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(kind))) throw new Error('private object kind is invalid');
    const actualHash = await sha256File(sourceFile);
    if (sha256 && actualHash !== sha256) throw new Error('private object source hash changed');
    const extension = path.extname(sourceFile).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const objectKey = `${tenantId}/${kind}/${actualHash.slice(0, 2)}/${actualHash}${extension}`;
    const target = path.resolve(this.root, ...objectKey.split('/'));
    if (!pathInside(this.root, target)) throw new Error('private object path escaped root');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      if (await sha256File(target) !== actualHash) throw new Error('private object hash collision');
    } else {
      const temporary = target + '.' + crypto.randomUUID() + '.partial';
      try {
        fs.copyFileSync(sourceFile, temporary, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(temporary, 0o600);
        if (await sha256File(temporary) !== actualHash) throw new Error('private object copy hash mismatch');
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_) { /* temporary output only */ }
        throw error;
      }
    }
    return { backend: 'private-filesystem', objectKey, sha256: actualHash, size: fs.statSync(target).size };
  }

  async putBuffer({ tenantId, kind, body, extension = '' }) {
    if (!Buffer.isBuffer(body)) throw new Error('private object body must be a buffer');
    if (!/^\d+$/.test(String(tenantId))) throw new Error('private object tenant id is required');
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(kind))) throw new Error('private object kind is invalid');
    const safeExtension = String(extension).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const objectKey = `${tenantId}/${kind}/${digest.slice(0, 2)}/${digest}${safeExtension}`;
    const target = path.resolve(this.root, ...objectKey.split('/'));
    if (!pathInside(this.root, target)) throw new Error('private object path escaped root');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      if (await sha256File(target) !== digest) throw new Error('private object hash collision');
    } else {
      const temporary = target + '.' + crypto.randomUUID() + '.partial';
      try {
        fs.writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
        if (await sha256File(temporary) !== digest) throw new Error('private object write hash mismatch');
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_) { /* temporary output only */ }
        throw error;
      }
    }
    return { backend: 'private-filesystem', objectKey, sha256: digest, size: body.length };
  }

  async putEncryptedBuffer({ tenantId, kind, body }) {
    if (!this.encryptionKey) throw Object.assign(new Error('加密密钥尚未就绪，无法保存私有文件，请联系管理员检查密钥配置。'), { publicCode: 'private_object_encryption_unavailable' });
    if (!Buffer.isBuffer(body) || !body.length) throw new Error('private object body must be a non-empty buffer');
    if (!/^\d+$/.test(String(tenantId))) throw new Error('private object tenant id is required');
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(String(kind))) throw new Error('private object kind is invalid');
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const objectKey = `${tenantId}/${kind}/${digest.slice(0, 2)}/${digest}.enc`;
    const target = path.resolve(this.root, ...objectKey.split('/'));
    if (!pathInside(this.root, target)) throw new Error('private object path escaped root');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) {
      const existing = await this.readEncryptedBuffer(objectKey);
      if (crypto.createHash('sha256').update(existing).digest('hex') !== digest) throw new Error('private object hash collision');
    } else {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
      const envelope = Buffer.concat([Buffer.from('WYERPOBJ1'), iv, cipher.getAuthTag(), encrypted]);
      const temporary = target + '.' + crypto.randomUUID() + '.partial';
      try {
        fs.writeFileSync(temporary, envelope, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch (_) { /* temporary output only */ }
        throw error;
      }
    }
    return { backend: 'private-filesystem-encrypted', objectKey, sha256: digest, size: body.length };
  }

  async readEncryptedBuffer(objectKey) {
    if (!this.encryptionKey) throw Object.assign(new Error('加密密钥尚未就绪，无法保存私有文件，请联系管理员检查密钥配置。'), { publicCode: 'private_object_encryption_unavailable' });
    const target = path.resolve(this.root, ...String(objectKey || '').split('/'));
    if (!pathInside(this.root, target)) throw new Error('private object path escaped root');
    const envelope = fs.readFileSync(target);
    if (envelope.length < 38 || envelope.subarray(0, 9).toString('ascii') !== 'WYERPOBJ1') throw new Error('private object envelope invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, envelope.subarray(9, 21));
    decipher.setAuthTag(envelope.subarray(21, 37));
    return Buffer.concat([decipher.update(envelope.subarray(37)), decipher.final()]);
  }

  async deleteEncryptedBuffer(objectKey) {
    const target = path.resolve(this.root, ...String(objectKey || '').split('/'));
    if (!pathInside(this.root, target) || !target.endsWith('.enc')) throw new Error('private object path escaped root');
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function normalizeEncryptionKey(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  if (/^[a-f0-9]{64}$/i.test(source)) return Buffer.from(source, 'hex');
  try {
    const decoded = Buffer.from(source, 'base64');
    if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === source.replace(/=+$/, '')) return decoded;
  } catch (_) { /* invalid key */ }
  throw new Error('ERP_PRIVATE_OBJECT_KEY must decode to exactly 32 bytes');
}

module.exports = { PrivateObjectStore, pathInside, sha256File, normalizeEncryptionKey };
