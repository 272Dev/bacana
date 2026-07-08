import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SUPPORTED_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512']);

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeAlgorithm(value) {
  const algorithm = cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SUPPORTED_ALGORITHMS.has(algorithm) ? algorithm : 'SHA1';
}

function normalizeDigits(value) {
  const digits = Number(value || 6);
  return digits === 8 ? 8 : 6;
}

function normalizePeriod(value) {
  const period = Number(value || 30);
  return period >= 10 && period <= 120 ? Math.floor(period) : 30;
}

function decodeBase32(secret) {
  const clean = cleanText(secret).replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase();
  if (!clean) {
    const error = new Error('Informe o segredo do autenticador.');
    error.status = 400;
    throw error;
  }

  let bits = '';
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      const error = new Error('Segredo 2FA invalido. Use Base32 ou uma URI otpauth.');
      error.status = 400;
      throw error;
    }
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function parseOtpAuthUri(value) {
  const text = cleanText(value);
  if (!text.toLowerCase().startsWith('otpauth://')) return null;

  let url;
  try {
    url = new URL(text);
  } catch {
    const error = new Error('URI otpauth invalida.');
    error.status = 400;
    throw error;
  }

  if (url.hostname !== 'totp') {
    const error = new Error('Apenas codigos TOTP sao suportados.');
    error.status = 400;
    throw error;
  }

  const rawLabel = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [labelIssuer, labelAccount] = rawLabel.includes(':')
    ? rawLabel.split(/:(.*)/s)
    : ['', rawLabel];

  return {
    label: labelAccount || rawLabel,
    issuer: url.searchParams.get('issuer') || labelIssuer || '',
    username: labelAccount || rawLabel,
    secret: url.searchParams.get('secret') || '',
    algorithm: url.searchParams.get('algorithm') || 'SHA1',
    digits: url.searchParams.get('digits') || 6,
    period: url.searchParams.get('period') || 30
  };
}

export function parseAuthenticatorInput(payload) {
  const parsedUri = parseOtpAuthUri(payload.secret || payload.uri || '');
  const source = parsedUri || payload;
  const secret = cleanText(source.secret);
  decodeBase32(secret);

  const label = cleanText(payload.label) || cleanText(source.label) || cleanText(source.username) || 'Codigo 2FA';
  return {
    label: label.slice(0, 120),
    issuer: (cleanText(payload.issuer) || cleanText(source.issuer)).slice(0, 120),
    username: (cleanText(payload.username) || cleanText(source.username)).slice(0, 180),
    secret,
    algorithm: normalizeAlgorithm(source.algorithm),
    digits: normalizeDigits(source.digits),
    period: normalizePeriod(source.period),
    notes: cleanText(payload.notes).slice(0, 1000)
  };
}

function createTotpCode({ secret, algorithm = 'SHA1', digits = 6, period = 30, timestamp = Date.now() }) {
  const key = decodeBase32(secret);
  const counter = Math.floor(timestamp / 1000 / period);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac(algorithm.toLowerCase(), key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function mapAuthenticator(row, { includeCode = true } = {}) {
  const secretResult = includeCode ? tryDecryptSecret(row.secret_encrypted) : { value: '', ok: true };
  const notesResult = tryDecryptSecret(row.notes_encrypted);
  const period = normalizePeriod(row.period);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const secondsRemaining = period - (nowSeconds % period);
  const code = includeCode && secretResult.ok
    ? createTotpCode({
      secret: secretResult.value,
      algorithm: row.algorithm,
      digits: Number(row.digits || 6),
      period
    })
    : null;

  return {
    id: row.id,
    label: row.label,
    issuer: row.issuer,
    username: row.username,
    algorithm: row.algorithm,
    digits: Number(row.digits || 6),
    period,
    code,
    secondsRemaining,
    secretStatus: {
      secretOk: secretResult.ok,
      notesOk: notesResult.ok
    },
    notes: notesResult.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listAuthenticators({ search = '' } = {}) {
  const rows = await db.prepare(`
    SELECT *
    FROM authenticators
    ORDER BY updated_at DESC, label ASC
  `).all();
  const cleanSearch = cleanText(search).toLowerCase();
  return rows
    .filter((row) => {
      if (!cleanSearch) return true;
      return [row.label, row.issuer, row.username]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanSearch));
    })
    .map((row) => mapAuthenticator(row));
}

export async function createAuthenticator({ payload, actorDiscordId }) {
  const parsed = parseAuthenticatorInput(payload);
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`
    INSERT INTO authenticators (
      id, label, issuer, username, secret_encrypted, algorithm, digits, period,
      notes_encrypted, created_by, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    parsed.label,
    parsed.issuer || null,
    parsed.username || null,
    encryptSecret(parsed.secret),
    parsed.algorithm,
    parsed.digits,
    parsed.period,
    encryptSecret(parsed.notes || ''),
    actorDiscordId,
    now,
    now
  );
  const row = await db.prepare('SELECT * FROM authenticators WHERE id = ?').get(id);
  return mapAuthenticator(row);
}

export async function getAuthenticator(id) {
  const row = await db.prepare('SELECT * FROM authenticators WHERE id = ?').get(id);
  return row ? mapAuthenticator(row) : null;
}

export async function deleteAuthenticator(id) {
  const result = await db.prepare('DELETE FROM authenticators WHERE id = ?').run(id);
  return (result?.changes || 0) > 0;
}
