import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db, getAuthorizedUser, getUser, nowIso } from './db.js';
import { logAudit } from './audit.js';
import { safeEqual } from './crypto.js';

export const SESSION_COOKIE = 'nexus_session';
export const OAUTH_STATE_COOKIE = 'nexus_oauth_state';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.security.requireHttps,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs
  };
}

export function setSessionCookie(res, discordId) {
  const token = jwt.sign({ sub: discordId }, config.security.sessionSecret, { expiresIn: '7d' });
  res.cookie(SESSION_COOKIE, token, cookieOptions(7 * 24 * 60 * 60 * 1000));
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function setOAuthStateCookie(res, state) {
  res.cookie(OAUTH_STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
}

export function clearOAuthStateCookie(res) {
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
}

export function createOAuthState() {
  return crypto.randomBytes(32).toString('base64url');
}

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Sessao ausente.' });
    const payload = jwt.verify(token, config.security.sessionSecret);
    const user = getUser(payload.sub);
    const authorized = getAuthorizedUser(payload.sub);
    if (!user || !authorized || user.active !== 1) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Acesso nao autorizado.' });
    }
    req.user = {
      discordId: user.discord_id,
      username: user.username,
      globalName: user.global_name,
      avatarUrl: user.avatar_url,
      role: authorized.role
    };
    next();
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Sessao invalida.' });
  }
}

export function requireAdmin(req, res, next) {
  if (!['owner', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Permissao insuficiente.' });
  }
  next();
}

export function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    return res.status(403).json({ error: 'Apenas owners podem executar esta acao.' });
  }
  next();
}

export function validateOAuthStateValue(req, received) {
  const expected = req.cookies?.[OAUTH_STATE_COOKIE];
  return expected && received && safeEqual(expected, received);
}

export function validateOAuthState(req) {
  return validateOAuthStateValue(req, req.query?.state);
}

export function checkLoginBlocked(ip) {
  const row = db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  if (!row?.blocked_until) return null;
  if (new Date(row.blocked_until).getTime() > Date.now()) return row.blocked_until;
  return null;
}

export function recordFailedLogin(ip, reason) {
  const now = nowIso();
  const row = db.prepare('SELECT * FROM login_attempts WHERE ip = ?').get(ip);
  const attempts = (row?.attempts || 0) + 1;
  const blockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : row?.blocked_until || null;
  db.prepare(`
    INSERT INTO login_attempts (ip, attempts, blocked_until, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET
      attempts = excluded.attempts,
      blocked_until = excluded.blocked_until,
      updated_at = excluded.updated_at
  `).run(ip, attempts, blockedUntil, now);
  logAudit({ action: 'auth.failed', metadata: { reason, attempts }, ip });
}

export function resetFailedLogin(ip) {
  db.prepare('DELETE FROM login_attempts WHERE ip = ?').run(ip);
}

export async function exchangeDiscordCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.discord.redirectUri
  });

  const auth = Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString('base64');
  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload.error_description || payload.error || 'Falha ao trocar codigo OAuth2.');
    error.status = 401;
    error.oauthStep = 'token';
    error.oauthCode = payload.error || 'token_exchange_failed';
    throw error;
  }
  return response.json();
}

export async function fetchDiscordUser(accessToken) {
  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    const error = new Error('Falha ao obter usuario Discord.');
    error.status = 401;
    error.oauthStep = 'user';
    error.oauthCode = 'user_fetch_failed';
    throw error;
  }
  return response.json();
}

export function upsertDiscordUser(discordUser, role) {
  const now = nowIso();
  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(discordUser.discriminator || 0) % 5}.png`;

  db.prepare(`
    INSERT INTO users (
      discord_id, username, global_name, avatar_hash, avatar_url, role, active,
      created_at, updated_at, last_login_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      username = excluded.username,
      global_name = excluded.global_name,
      avatar_hash = excluded.avatar_hash,
      avatar_url = excluded.avatar_url,
      role = excluded.role,
      active = 1,
      updated_at = excluded.updated_at,
      last_login_at = excluded.last_login_at
  `).run(
    discordUser.id,
    discordUser.username,
    discordUser.global_name || null,
    discordUser.avatar || null,
    avatarUrl,
    role,
    now,
    now,
    now
  );
}
