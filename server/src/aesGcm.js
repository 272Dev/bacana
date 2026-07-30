import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

export function encryptAes256Gcm(value, key, keyId = 'primary') {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Chave AES-256 inválida.');
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(String(keyId || ''))) throw new Error('ID da chave de cifragem inválido.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value ?? ''), 'utf8'), cipher.final()]);
  return [
    'v2',
    keyId,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
}

export function decryptAes256Gcm(payload, resolveKey) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 5 || parts[0] !== 'v2') throw new Error('Payload AES-256-GCM inválido.');
  const [, keyId, ivText, tagText, dataText] = parts;
  const key = resolveKey(keyId);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Chave AES-256 indisponível.');
  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Metadados AES-256-GCM inválidos.');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

