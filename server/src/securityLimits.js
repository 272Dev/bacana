import crypto from 'node:crypto';
import { config, missingEnv } from './config.js';
import { db, nowIso } from './db.js';

function secret() {
  const value = String(config.loader?.ticketSigningSecret || '');
  if (missingEnv(value) || value.length < 32) {
    const error = new Error('LOADER_TICKET_SECRET precisa ter pelo menos 32 caracteres.');
    error.code = 'SECURITY_NOT_CONFIGURED';
    throw error;
  }
  return value;
}

export function secureHash(value, purpose = 'generic') {
  return crypto
    .createHmac('sha256', secret())
    .update(`${purpose}\0${String(value || '')}`)
    .digest('hex');
}

export function rateLimitError(retryAfterSeconds) {
  const error = new Error('Muitas tentativas. Tente novamente mais tarde.');
  error.status = 429;
  error.code = 'RATE_LIMITED';
  error.retryAfterSeconds = Math.max(1, Number(retryAfterSeconds || 1));
  return error;
}

export async function consumeSecurityLimit({
  scope,
  subject,
  max,
  windowSeconds,
  store = db
}) {
  const cleanScope = String(scope || '').trim().slice(0, 80);
  const subjectHash = secureHash(subject, `rate:${cleanScope}`);
  const limit = Math.max(1, Number(max || 1));
  const windowMs = Math.max(1, Number(windowSeconds || 1)) * 1000;
  const operation = async (tx) => {
    const timestamp = Date.now();
    const now = new Date(timestamp).toISOString();
    const row = await tx.prepare(`
      SELECT * FROM nexus_rate_limits WHERE scope = ? AND subject_hash = ?
    `).get(cleanScope, subjectHash);
    const resetTimestamp = Date.parse(row?.reset_at || '');
    if (!row || !Number.isFinite(resetTimestamp) || resetTimestamp <= timestamp) {
      const resetAt = new Date(timestamp + windowMs).toISOString();
      await tx.prepare(`
        INSERT INTO nexus_rate_limits (
          scope, subject_hash, window_started_at, reset_at, attempts
        ) VALUES (?, ?, ?, ?, 1)
        ON CONFLICT (scope, subject_hash) DO UPDATE SET
          window_started_at = excluded.window_started_at,
          reset_at = excluded.reset_at,
          attempts = 1
      `).run(cleanScope, subjectHash, now, resetAt);
      return { allowed: true, remaining: limit - 1, resetAt };
    }
    const attempts = Number(row.attempts || 0);
    if (attempts >= limit) {
      throw rateLimitError(Math.ceil((resetTimestamp - timestamp) / 1000));
    }
    const update = await tx.prepare(`
      UPDATE nexus_rate_limits SET attempts = attempts + 1
      WHERE scope = ? AND subject_hash = ? AND attempts = ?
    `).run(cleanScope, subjectHash, attempts);
    if (Number(update.changes || 0) !== 1) {
      throw rateLimitError(Math.ceil((resetTimestamp - timestamp) / 1000));
    }
    return {
      allowed: true,
      remaining: Math.max(0, limit - attempts - 1),
      resetAt: row.reset_at
    };
  };
  return typeof store.transaction === 'function'
    ? store.transaction(operation)
    : operation(store);
}

export async function cleanupSecurityLimits() {
  await db.prepare('DELETE FROM nexus_rate_limits WHERE reset_at <= ?').run(nowIso());
}
