import crypto from 'node:crypto';
import { config } from './config.js';
import { decryptAes256Gcm, encryptAes256Gcm } from './aesGcm.js';

const ALGORITHM = 'aes-256-gcm';

function decodeKey(raw) {
  const candidates = [
    Buffer.from(raw || '', 'base64'),
    Buffer.from(raw || '', 'base64url'),
    Buffer.from(raw || '', 'hex')
  ];
  return candidates.find((item) => item.length === 32) || null;
}

function previousKeys() {
  const result = new Map();
  const raw = String(config.loader?.previousMasterKeys || '').trim();
  if (!raw) return result;
  let entries = [];
  try {
    entries = Object.entries(JSON.parse(raw));
  } catch {
    entries = raw.split(',').map((item) => {
      const separator = item.indexOf(':');
      return separator > 0 ? [item.slice(0, separator), item.slice(separator + 1)] : [];
    }).filter((entry) => entry.length === 2);
  }
  for (const [id, value] of entries) {
    const key = decodeKey(value);
    if (id && key) result.set(String(id), key);
  }
  return result;
}

function getMasterKey(keyId = config.loader?.encryptionKeyId || 'primary') {
  const currentId = config.loader?.encryptionKeyId || 'primary';
  const key = keyId === currentId
    ? decodeKey(config.security.masterKey)
    : previousKeys().get(keyId);
  if (!key) {
    throw new Error(`Chave de cifragem "${keyId}" indisponivel.`);
  }
  return key;
}

export function encryptSecret(value) {
  const text = value == null ? '' : String(value);
  const keyId = config.loader?.encryptionKeyId || 'primary';
  return encryptAes256Gcm(text, getMasterKey(keyId), keyId);
}

export function decryptSecret(payload) {
  if (!payload) return '';
  const parts = payload.split(':');
  const version = parts[0];
  const keyId = version === 'v2' ? parts[1] : config.loader?.encryptionKeyId || 'primary';
  const [ivText, tagText, dataText] = version === 'v2' ? parts.slice(2) : parts.slice(1);
  if (!['v1', 'v2'].includes(version) || !ivText || !tagText || !dataText) {
    throw new Error('Payload criptografado invalido.');
  }
  const decryptWithKey = (key) => {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataText, 'base64url')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  };
  if (version === 'v2') return decryptAes256Gcm(payload, (id) => getMasterKey(id));

  const legacyCandidates = [
    decodeKey(config.security.masterKey),
    ...previousKeys().values()
  ].filter(Boolean);
  for (const candidate of legacyCandidates) {
    try {
      return decryptWithKey(candidate);
    } catch {
      // Payload v1 nao carregava key id; tenta as chaves de rotacao configuradas.
    }
  }
  throw new Error('Payload criptografado invalido ou chave legada indisponivel.');
}

export function encryptedKeyId(payload) {
  const [version, keyId] = String(payload || '').split(':');
  return version === 'v2' ? keyId : 'legacy-v1';
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
