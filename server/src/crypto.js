import crypto from 'node:crypto';
import { config } from './config.js';

const ALGORITHM = 'aes-256-gcm';

function getMasterKey() {
  const raw = config.security.masterKey;
  const candidates = [
    Buffer.from(raw || '', 'base64'),
    Buffer.from(raw || '', 'base64url'),
    Buffer.from(raw || '', 'hex')
  ];
  const key = candidates.find((item) => item.length === 32);
  if (!key) {
    throw new Error('APP_MASTER_KEY deve conter exatamente 32 bytes em base64, base64url ou hex.');
  }
  return key;
}

export function encryptSecret(value) {
  const text = value == null ? '' : String(value);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const [version, ivText, tagText, dataText] = payload.split(':');
  if (version !== 'v1' || !ivText || !tagText || !dataText) {
    throw new Error('Payload criptografado invalido.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getMasterKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataText, 'base64url')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

export function tryDecryptSecret(payload, fallback = '') {
  try {
    return {
      value: decryptSecret(payload),
      ok: true
    };
  } catch (error) {
    return {
      value: fallback,
      ok: false,
      error: error.message
    };
  }
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
