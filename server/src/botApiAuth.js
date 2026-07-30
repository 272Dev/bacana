import crypto from 'node:crypto';
import { config, missingEnv } from './config.js';
import { safeEqual } from './crypto.js';
import { db, nowIso } from './db.js';

const SIGNATURE_TTL_MS = 60_000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function signaturePayload({ botId, timestamp, nonce, operationId, method, path, body }) {
  return [
    botId,
    timestamp,
    nonce,
    operationId,
    String(method || 'GET').toUpperCase(),
    path,
    sha256(body)
  ].join('\n');
}

export function signBotApiRequest({ method = 'GET', path, body = '', operationId = crypto.randomUUID() }) {
  const botId = config.discordBot.apiId;
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(24).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.discordBot.apiSecret)
    .update(signaturePayload({ botId, timestamp, nonce, operationId, method, path, body }))
    .digest('base64url');
  return {
    'X-Nexus-Bot-Id': botId,
    'X-Nexus-Timestamp': timestamp,
    'X-Nexus-Nonce': nonce,
    'X-Nexus-Operation-Id': operationId,
    'X-Nexus-Signature': signature
  };
}

function authError(code = 'BOT_AUTH_INVALID') {
  const error = new Error('Autenticacao interna do bot recusada.');
  error.status = 401;
  error.code = code;
  return error;
}

export async function requireBotApiSignature(req, _res, next) {
  try {
    if (missingEnv(config.discordBot.apiSecret) || config.discordBot.apiSecret.length < 32) {
      throw authError('BOT_AUTH_NOT_CONFIGURED');
    }
    const botId = String(req.get('X-Nexus-Bot-Id') || '');
    const timestamp = String(req.get('X-Nexus-Timestamp') || '');
    const nonce = String(req.get('X-Nexus-Nonce') || '');
    const operationId = String(req.get('X-Nexus-Operation-Id') || '');
    const signature = String(req.get('X-Nexus-Signature') || '');
    if (
      botId !== config.discordBot.apiId
      || !/^\d{13}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{24,80}$/.test(nonce)
      || !/^[0-9a-f-]{36}$/i.test(operationId)
      || !signature
    ) throw authError();
    const age = Math.abs(Date.now() - Number(timestamp));
    if (age > SIGNATURE_TTL_MS) throw authError('BOT_AUTH_EXPIRED');
    const body = ['GET', 'HEAD'].includes(req.method) ? '' : JSON.stringify(req.body || {});
    const expected = crypto
      .createHmac('sha256', config.discordBot.apiSecret)
      .update(signaturePayload({
        botId,
        timestamp,
        nonce,
        operationId,
        method: req.method,
        path: req.originalUrl,
        body
      }))
      .digest('base64url');
    if (!safeEqual(signature, expected)) throw authError();

    const nonceHash = sha256(`${botId}\0${nonce}`);
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SIGNATURE_TTL_MS * 2).toISOString();
    try {
      await db.prepare(`
        INSERT INTO bot_api_nonces (nonce_hash, bot_id, created_at, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(nonceHash, botId, createdAt, expiresAt);
    } catch {
      throw authError('BOT_AUTH_REPLAYED');
    }
    req.botApi = { botId, operationId };
    next();
  } catch (error) {
    next(error);
  }
}

export async function cleanupBotApiNonces() {
  await db.prepare('DELETE FROM bot_api_nonces WHERE expires_at <= ?').run(nowIso());
}
