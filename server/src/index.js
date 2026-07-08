import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { config, getMissingRuntimeConfig, hasDiscordOAuthConfig, requireRuntimeConfig } from './config.js';
import { db, getAuthorizedUser, nowIso, seedAuthorizedUsers } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { destroyCloudinaryImage, isCloudinaryEnabled, uploadCloudinaryImage } from './cloudinary.js';
import { logAudit, writeAccountHistory } from './audit.js';
import { lookupRobloxUsername } from './roblox.js';
import {
  checkLoginBlocked,
  clearOAuthStateCookie,
  clearSessionCookie,
  createOAuthState,
  exchangeDiscordCode,
  fetchDiscordUser,
  recordFailedLogin,
  requireAdmin,
  requireAuth,
  requireOwner,
  resetFailedLogin,
  setOAuthStateCookie,
  setSessionCookie,
  upsertDiscordUser,
  validateOAuthState,
  validateOAuthStateValue
} from './auth.js';

requireRuntimeConfig();
seedAuthorizedUsers();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');
const uploadsDir = path.resolve(config.rootDir, 'data/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

app.set('trust proxy', config.security.trustProxy);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: config.clientUrl,
  credentials: true
}));
app.use(express.json({ limit: '8mb' }));
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
  next();
});

app.use((req, res, next) => {
  if (config.security.requireHttps && !req.secure && req.get('x-forwarded-proto') !== 'https') {
    return res.status(403).json({ error: 'HTTPS obrigatorio.' });
  }
  next();
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

app.use('/api', apiLimiter);

function setCookie(res, name, value, options) {
  const attrs = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`];
  if (options.httpOnly) attrs.push('HttpOnly');
  if (options.secure) attrs.push('Secure');
  if (options.sameSite) attrs.push(`SameSite=${options.sameSite}`);
  if (options.maxAge != null) attrs.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  res.append('Set-Cookie', attrs.join('; '));
}

app.use((req, res, next) => {
  res.cookie = (name, value, options = {}) => setCookie(res, name, value, options);
  res.clearCookie = (name, options = {}) => setCookie(res, name, '', { ...options, maxAge: 0 });
  next();
});

function clientRedirect(pathname, params = {}) {
  const url = new URL(pathname, config.clientUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.toString();
}

function normalizePlatform(platform) {
  const text = String(platform || '').trim();
  return text || 'Outro';
}

function mapAccount(row, { includePassword = false } = {}) {
  const loginResult = tryDecryptSecret(row.login_encrypted);
  const notesResult = tryDecryptSecret(row.notes_encrypted);
  const passwordResult = includePassword
    ? tryDecryptSecret(row.password_encrypted)
    : { value: null, ok: true };

  for (const [field, result] of [
    ['login_encrypted', loginResult],
    ['notes_encrypted', notesResult],
    ['password_encrypted', passwordResult]
  ]) {
    if (!result.ok) {
      logAudit({
        actorDiscordId: null,
        action: 'account.decrypt_failed',
        targetType: 'account',
        targetId: row.id,
        metadata: { field, reason: result.error }
      });
    }
  }

  return {
    id: row.id,
    ownerDiscordId: row.owner_discord_id,
    name: row.name,
    platform: row.platform,
    photoUrl: row.photo_url,
    login: loginResult.value,
    password: passwordResult.value,
    hasPassword: Boolean(row.password_encrypted),
    secretStatus: {
      loginOk: loginResult.ok,
      passwordOk: includePassword ? passwordResult.ok : true,
      notesOk: notesResult.ok
    },
    notes: notesResult.value,
    permission: row.permission || 'owner',
    canEdit: row.permission === 'owner' || row.permission === 'edit',
    canShare: row.permission === 'owner',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roblox: row.roblox_user_id ? {
      username: row.roblox_username,
      displayName: row.roblox_display_name,
      userId: row.roblox_user_id,
      profileUrl: row.roblox_profile_url,
      avatarUrl: row.roblox_avatar_url
    } : null
  };
}

function getAccountAccess(accountId, discordId) {
  const account = db.prepare(`
    SELECT *, 'owner' AS permission
    FROM accounts
    WHERE id = ? AND owner_discord_id = ? AND deleted_at IS NULL
  `).get(accountId, discordId);
  if (account) return { row: account, permission: 'owner', canEdit: true, canShare: true };

  const shared = db.prepare(`
    SELECT a.*, s.permission
    FROM accounts a
    JOIN account_shares s ON s.account_id = a.id
    WHERE a.id = ? AND s.shared_with_discord_id = ? AND a.deleted_at IS NULL
  `).get(accountId, discordId);
  if (!shared) return null;
  return {
    row: shared,
    permission: shared.permission,
    canEdit: shared.permission === 'edit',
    canShare: false
  };
}

function requireAccountAccess(permission = 'view') {
  return (req, res, next) => {
    const access = getAccountAccess(req.params.id, req.user.discordId);
    if (!access) return res.status(404).json({ error: 'Conta nao encontrada.' });
    if (permission === 'edit' && !access.canEdit) return res.status(403).json({ error: 'Sem permissao de edicao.' });
    if (permission === 'owner' && !access.canShare) return res.status(403).json({ error: 'Apenas o dono pode alterar compartilhamentos.' });
    req.accountAccess = access;
    next();
  };
}

const imageUrlSchema = z.string().trim().max(1000).refine((value) => {
  if (!value) return true;
  if (value.startsWith(`${config.apiPublicUrl}/api/images/`)) return true;
  if (value.startsWith('/api/images/')) return true;
  return /^https?:\/\//i.test(value);
}, 'URL de foto invalida.');

const accountCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  login: z.string().max(300).default(''),
  password: z.string().min(1).max(1000),
  platform: z.string().trim().min(1).max(80),
  photoUrl: imageUrlSchema.optional().or(z.literal('')),
  notes: z.string().max(5000).optional().default(''),
  robloxUsername: z.string().max(64).optional().or(z.literal(''))
});

const accountUpdateSchema = accountCreateSchema.partial().extend({
  password: z.string().min(1).max(1000).optional().or(z.literal(''))
});

const shareSchema = z.object({
  discordId: z.string().regex(/^\d{5,32}$/),
  permission: z.enum(['view', 'edit'])
});

const authorizedUserSchema = z.object({
  discordId: z.string().regex(/^\d{5,32}$/),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
  label: z.string().trim().max(120).optional().or(z.literal(''))
});

const folderSchema = z.object({
  name: z.string().trim().min(1).max(80)
});

const uploadImageSchema = z.object({
  folderId: z.string().uuid().optional().nullable().or(z.literal('')),
  name: z.string().trim().max(160).optional().or(z.literal('')),
  dataUrl: z.string().min(20)
});

const allowedImageTypes = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

function sanitizeFileBase(name) {
  const parsed = path.parse(String(name || 'imagem'));
  return (parsed.name || 'imagem')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'imagem';
}

function parseImageDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const error = new Error('Imagem invalida. Use PNG, JPG, WEBP ou GIF.');
    error.status = 400;
    throw error;
  }
  const mimeType = match[1].toLowerCase();
  const ext = allowedImageTypes.get(mimeType);
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
    const error = new Error('Imagem deve ter ate 5 MB.');
    error.status = 400;
    throw error;
  }
  return { mimeType, ext, buffer, dataUrl: `data:${mimeType};base64,${base64}` };
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    imageCount: row.image_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapImage(row) {
  const localUrl = `${config.apiPublicUrl}/api/images/${row.id}/file`;
  const url = row.url && !row.url.includes(`/api/images/${row.id}/file`)
    ? row.url
    : localUrl;

  return {
    id: row.id,
    folderId: row.folder_id,
    name: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isCloudinaryImage(row) {
  return /^https:\/\/res\.cloudinary\.com\//i.test(String(row.url || ''));
}

function getImageFilePath(row) {
  const filePath = path.resolve(uploadsDir, row.owner_discord_id, row.stored_name);
  const ownerDir = path.resolve(uploadsDir, row.owner_discord_id);
  if (!filePath.startsWith(ownerDir)) return null;
  return filePath;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'Nexus', time: nowIso() });
});

app.get('/api/config/status', (_req, res) => {
  if (config.nodeEnv === 'production') {
    return res.json({
      ok: true,
      cloudinaryEnabled: isCloudinaryEnabled(),
      oauthReady: hasDiscordOAuthConfig()
    });
  }

  res.json({
    ok: true,
    envPath: config.envPath,
    clientId: config.discord.clientId,
    oauthFlow: config.discord.oauthFlow,
    discordSecretConfigured: Boolean(config.discord.clientSecret),
    discordSecretLength: config.discord.clientSecret.length,
    redirectUri: config.discord.redirectUri,
    cloudinaryEnabled: isCloudinaryEnabled(),
    authorizedUsers: config.authorizedUsers.map((user) => ({ discordId: user.discordId, role: user.role })),
    missing: getMissingRuntimeConfig(),
    oauthReady: hasDiscordOAuthConfig()
  });
});

app.get('/api/auth/discord', authLimiter, (req, res) => {
  const blockedUntil = checkLoginBlocked(req.ip);
  if (blockedUntil) return res.redirect(clientRedirect('/login', { error: 'blocked' }));
  if (!hasDiscordOAuthConfig()) {
    return res.redirect(clientRedirect('/login', { error: 'oauth_config' }));
  }

  const state = createOAuthState();
  setOAuthStateCookie(res, state);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('response_type', config.discord.oauthFlow === 'implicit' ? 'token' : 'code');
  url.searchParams.set('client_id', config.discord.clientId);
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', config.discord.redirectUri);
  url.searchParams.set('prompt', 'consent');
  res.redirect(url.toString());
});

function implicitCallbackPage() {
  const clientUrl = JSON.stringify(config.clientUrl);
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Nexus - Discord</title>
  </head>
  <body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#08111f;color:#edf5ff;font-family:system-ui,sans-serif">
    <main style="display:grid;gap:12px;text-align:center">
      <strong>Conectando ao Nexus</strong>
      <span style="color:#96a7bd">Finalizando login com Discord...</span>
    </main>
    <script>
      const clientUrl = ${clientUrl};
      const params = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = params.get('access_token');
      const state = params.get('state');
      const error = params.get('error');

      async function finish() {
        if (error) {
          window.location.href = clientUrl + '/login?error=oauth';
          return;
        }
        if (!accessToken || !state) {
          window.location.href = clientUrl + '/login?error=missing_code';
          return;
        }
        const response = await fetch('/api/auth/discord/implicit', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken, state })
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          window.location.href = clientUrl + '/login?error=' + encodeURIComponent(payload.code || 'oauth');
          return;
        }
        window.location.href = clientUrl;
      }
      finish();
    </script>
  </body>
</html>`;
}

app.post('/api/auth/discord/implicit', authLimiter, async (req, res) => {
  try {
    const blockedUntil = checkLoginBlocked(req.ip);
    if (blockedUntil) return res.status(429).json({ error: 'Acesso bloqueado.', code: 'blocked' });
    if (!validateOAuthStateValue(req, req.body?.state)) {
      recordFailedLogin(req.ip, 'invalid_state');
      return res.status(401).json({ error: 'Sessao de login expirada.', code: 'invalid_state' });
    }
    if (!req.body?.accessToken) {
      recordFailedLogin(req.ip, 'missing_token');
      return res.status(400).json({ error: 'Token Discord ausente.', code: 'oauth' });
    }

    const discordUser = await fetchDiscordUser(String(req.body.accessToken));
    const authorized = getAuthorizedUser(discordUser.id);
    if (!authorized) {
      recordFailedLogin(req.ip, 'discord_id_not_allowed');
      clearOAuthStateCookie(res);
      return res.status(403).json({ error: 'Discord ID nao autorizado.', code: 'unauthorized' });
    }

    upsertDiscordUser(discordUser, authorized.role);
    resetFailedLogin(req.ip);
    clearOAuthStateCookie(res);
    setSessionCookie(res, discordUser.id);
    logAudit({
      actorDiscordId: discordUser.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: discordUser.id,
      metadata: { flow: 'implicit' },
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (error) {
    recordFailedLogin(req.ip, error.oauthCode || 'implicit_oauth_error');
    logAudit({
      action: 'auth.discord_oauth_error',
      targetType: 'oauth',
      metadata: { step: error.oauthStep || 'implicit', code: error.oauthCode || 'implicit_oauth_error' },
      ip: req.ip
    });
    res.status(401).json({ error: 'Nao foi possivel concluir login com Discord.', code: 'oauth_user' });
  }
});

app.get('/api/auth/discord/callback', authLimiter, async (req, res) => {
  try {
    if (config.discord.oauthFlow === 'implicit' && !req.query.code) {
      return res.type('html').send(implicitCallbackPage());
    }
    const blockedUntil = checkLoginBlocked(req.ip);
    if (blockedUntil) return res.redirect(clientRedirect('/login', { error: 'blocked' }));
    if (!validateOAuthState(req)) {
      recordFailedLogin(req.ip, 'invalid_state');
      return res.redirect(clientRedirect('/login', { error: 'invalid_state' }));
    }
    if (!req.query.code) {
      recordFailedLogin(req.ip, 'missing_code');
      return res.redirect(clientRedirect('/login', { error: 'missing_code' }));
    }

    const token = await exchangeDiscordCode(String(req.query.code));
    const discordUser = await fetchDiscordUser(token.access_token);
    const authorized = getAuthorizedUser(discordUser.id);
    if (!authorized) {
      recordFailedLogin(req.ip, 'discord_id_not_allowed');
      clearOAuthStateCookie(res);
      return res.redirect(clientRedirect('/login', { error: 'unauthorized' }));
    }

    upsertDiscordUser(discordUser, authorized.role);
    resetFailedLogin(req.ip);
    clearOAuthStateCookie(res);
    setSessionCookie(res, discordUser.id);
    logAudit({
      actorDiscordId: discordUser.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: discordUser.id,
      ip: req.ip
    });
    res.redirect(config.clientUrl);
  } catch (error) {
    const oauthCode = error.oauthCode || 'oauth_error';
    const reason = error.oauthStep === 'token' ? `discord_token_${oauthCode}` : oauthCode;
    recordFailedLogin(req.ip, reason);
    logAudit({
      action: 'auth.discord_oauth_error',
      targetType: 'oauth',
      metadata: { step: error.oauthStep || 'unknown', code: oauthCode },
      ip: req.ip
    });
    if (config.nodeEnv !== 'production') {
      console.warn('[nexus] Discord OAuth2 falhou:', { step: error.oauthStep || 'unknown', code: oauthCode });
    }
    const clientError = oauthCode === 'invalid_client'
      ? 'oauth_config'
      : oauthCode === 'invalid_grant'
        ? 'oauth_redirect'
        : error.oauthStep === 'user'
          ? 'oauth_user'
          : 'oauth';
    res.redirect(clientRedirect('/login', { error: clientError }));
  }
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  logAudit({ actorDiscordId: req.user.discordId, action: 'auth.logout', targetType: 'user', targetId: req.user.discordId, ip: req.ip });
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/image-folders', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, COUNT(i.id) AS image_count
    FROM image_folders f
    LEFT JOIN images i ON i.folder_id = f.id
    WHERE f.owner_discord_id = ?
    GROUP BY f.id
    ORDER BY f.updated_at DESC
  `).all(req.user.discordId);
  res.json({ folders: rows.map(mapFolder) });
});

app.post('/api/image-folders', requireAuth, (req, res, next) => {
  try {
    const payload = folderSchema.parse(req.body);
    const id = crypto.randomUUID();
    const now = nowIso();
    db.prepare(`
      INSERT INTO image_folders (id, owner_discord_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.user.discordId, payload.name, now, now);
    logAudit({ actorDiscordId: req.user.discordId, action: 'image_folder.created', targetType: 'image_folder', targetId: id, ip: req.ip });
    const row = db.prepare('SELECT *, 0 AS image_count FROM image_folders WHERE id = ?').get(id);
    res.status(201).json({ folder: mapFolder(row) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/image-folders/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM image_folders WHERE id = ? AND owner_discord_id = ?').get(req.params.id, req.user.discordId);
  if (!row) return res.status(404).json({ error: 'Pasta nao encontrada.' });
  db.prepare('UPDATE images SET folder_id = NULL, updated_at = ? WHERE folder_id = ?').run(nowIso(), req.params.id);
  db.prepare('DELETE FROM image_folders WHERE id = ?').run(req.params.id);
  logAudit({ actorDiscordId: req.user.discordId, action: 'image_folder.deleted', targetType: 'image_folder', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/images', requireAuth, (req, res) => {
  const folderId = String(req.query.folderId || '');
  const rows = folderId
    ? db.prepare(`
        SELECT *
        FROM images
        WHERE owner_discord_id = ? AND folder_id = ?
        ORDER BY created_at DESC
      `).all(req.user.discordId, folderId)
    : db.prepare(`
        SELECT *
        FROM images
        WHERE owner_discord_id = ? AND folder_id IS NULL
        ORDER BY created_at DESC
      `).all(req.user.discordId);
  res.json({ images: rows.map(mapImage) });
});

app.post('/api/images', requireAuth, async (req, res, next) => {
  try {
    const payload = uploadImageSchema.parse(req.body);
    const folderId = payload.folderId || null;
    if (folderId) {
      const folder = db.prepare('SELECT * FROM image_folders WHERE id = ? AND owner_discord_id = ?').get(folderId, req.user.discordId);
      if (!folder) return res.status(404).json({ error: 'Pasta nao encontrada.' });
    }

    const parsed = parseImageDataUrl(payload.dataUrl);
    const id = crypto.randomUUID();
    const baseName = sanitizeFileBase(payload.name || `imagem-${id}`);
    let storedName = `${id}-${baseName}.${parsed.ext}`;
    let url = `${config.apiPublicUrl}/api/images/${id}/file`;
    let sizeBytes = parsed.buffer.length;

    if (isCloudinaryEnabled()) {
      const publicId = `${req.user.discordId}/${id}-${baseName}`;
      const cloudinaryImage = await uploadCloudinaryImage({
        dataUrl: parsed.dataUrl,
        publicId
      });
      storedName = cloudinaryImage.public_id || publicId;
      url = cloudinaryImage.secure_url;
      sizeBytes = cloudinaryImage.bytes || parsed.buffer.length;
    } else {
      const folderPath = path.join(uploadsDir, req.user.discordId);
      fs.mkdirSync(folderPath, { recursive: true });
      const targetPath = path.join(folderPath, storedName);
      fs.writeFileSync(targetPath, parsed.buffer);
    }

    const now = nowIso();
    db.prepare(`
      INSERT INTO images (
        id, owner_discord_id, folder_id, original_name, stored_name, mime_type,
        size_bytes, url, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.user.discordId,
      folderId,
      payload.name || `${baseName}.${parsed.ext}`,
      storedName,
      parsed.mimeType,
      sizeBytes,
      url,
      now,
      now
    );
    if (folderId) {
      db.prepare('UPDATE image_folders SET updated_at = ? WHERE id = ?').run(now, folderId);
    }
    logAudit({
      actorDiscordId: req.user.discordId,
      action: 'image.uploaded',
      targetType: 'image',
      targetId: id,
      metadata: { folderId, mimeType: parsed.mimeType, storage: isCloudinaryEnabled() ? 'cloudinary' : 'local' },
      ip: req.ip
    });
    const row = db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    res.status(201).json({ image: mapImage(row) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/images/:id/file', (req, res) => {
  const row = db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Imagem nao encontrada.');
  if (isCloudinaryImage(row)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.redirect(row.url);
  }
  const filePath = getImageFilePath(row);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Arquivo nao encontrado.');
  res.type(row.mime_type);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath);
});

app.delete('/api/images/:id', requireAuth, async (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM images WHERE id = ? AND owner_discord_id = ?').get(req.params.id, req.user.discordId);
    if (!row) return res.status(404).json({ error: 'Imagem nao encontrada.' });
    if (isCloudinaryImage(row)) {
      await destroyCloudinaryImage(row.stored_name);
    } else {
      const filePath = getImageFilePath(row);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    db.prepare('DELETE FROM images WHERE id = ?').run(req.params.id);
    logAudit({ actorDiscordId: req.user.discordId, action: 'image.deleted', targetType: 'image', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/roblox/lookup', requireAuth, async (req, res, next) => {
  try {
    const result = await lookupRobloxUsername(req.body?.username);
    logAudit({ actorDiscordId: req.user.discordId, action: 'roblox.lookup', targetType: 'roblox', targetId: result.userId, ip: req.ip });
    res.json({ roblox: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/accounts', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, CASE WHEN a.owner_discord_id = ? THEN 'owner' ELSE s.permission END AS permission
    FROM accounts a
    LEFT JOIN account_shares s ON s.account_id = a.id AND s.shared_with_discord_id = ?
    WHERE a.deleted_at IS NULL
      AND (a.owner_discord_id = ? OR s.shared_with_discord_id IS NOT NULL)
    ORDER BY a.updated_at DESC
  `).all(req.user.discordId, req.user.discordId, req.user.discordId);

  const search = String(req.query.search || '').trim().toLowerCase();
  const platform = String(req.query.platform || '').trim().toLowerCase();
  const filtered = rows
    .map((row) => mapAccount(row))
    .filter((account) => {
      const matchesSearch = !search || [account.name, account.login, account.platform, account.roblox?.username, account.roblox?.displayName]
        .filter(Boolean)
        .some((item) => String(item).toLowerCase().includes(search));
      const matchesPlatform = !platform || account.platform.toLowerCase() === platform;
      return matchesSearch && matchesPlatform;
    });

  res.json({ accounts: filtered });
});

app.post('/api/accounts', requireAuth, async (req, res, next) => {
  try {
    const payload = accountCreateSchema.parse(req.body);
    const platform = normalizePlatform(payload.platform);
    let roblox = null;
    if (platform.toLowerCase() === 'roblox' && payload.robloxUsername) {
      roblox = await lookupRobloxUsername(payload.robloxUsername);
    }

    const id = crypto.randomUUID();
    const now = nowIso();
    const photoUrl = roblox?.avatarUrl || payload.photoUrl || '';
    db.prepare(`
      INSERT INTO accounts (
        id, owner_discord_id, name, platform, photo_url, login_encrypted, password_encrypted,
        notes_encrypted, roblox_username, roblox_display_name, roblox_user_id, roblox_profile_url,
        roblox_avatar_url, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      req.user.discordId,
      payload.name,
      platform,
      photoUrl,
      encryptSecret(payload.login),
      encryptSecret(payload.password),
      encryptSecret(payload.notes),
      roblox?.username || null,
      roblox?.displayName || null,
      roblox?.userId || null,
      roblox?.profileUrl || null,
      roblox?.avatarUrl || null,
      now,
      now
    );

    writeAccountHistory({
      accountId: id,
      actorDiscordId: req.user.discordId,
      action: 'created',
      metadata: { fields: ['name', 'login', 'password', 'platform', 'notes'].filter(Boolean) }
    });
    logAudit({ actorDiscordId: req.user.discordId, action: 'account.created', targetType: 'account', targetId: id, ip: req.ip });
    const row = getAccountAccess(id, req.user.discordId).row;
    res.status(201).json({ account: mapAccount(row) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/accounts/:id', requireAuth, requireAccountAccess('view'), (req, res) => {
  res.json({ account: mapAccount(req.accountAccess.row) });
});

app.patch('/api/accounts/:id', requireAuth, requireAccountAccess('edit'), async (req, res, next) => {
  try {
    const payload = accountUpdateSchema.parse(req.body);
    const previous = mapAccount(req.accountAccess.row, { includePassword: false });
    const nextValues = {
      name: payload.name ?? previous.name,
      login: payload.login ?? previous.login,
      platform: normalizePlatform(payload.platform ?? previous.platform),
      photoUrl: payload.photoUrl ?? previous.photoUrl ?? '',
      notes: payload.notes ?? previous.notes
    };

    let roblox = previous.roblox;
    const robloxUsername = payload.robloxUsername ?? previous.roblox?.username ?? '';
    if (nextValues.platform.toLowerCase() === 'roblox' && robloxUsername) {
      roblox = await lookupRobloxUsername(robloxUsername);
      nextValues.photoUrl = roblox.avatarUrl || nextValues.photoUrl;
    }
    if (nextValues.platform.toLowerCase() !== 'roblox') {
      roblox = null;
    }

    const passwordChanged = typeof payload.password === 'string' && payload.password.length > 0;
    const changedFields = [];
    for (const key of ['name', 'login', 'platform', 'photoUrl', 'notes']) {
      if ((previous[key] || '') !== (nextValues[key] || '')) changedFields.push(key);
    }
    if (passwordChanged) changedFields.push('password');
    if (JSON.stringify(previous.roblox || null) !== JSON.stringify(roblox || null)) changedFields.push('roblox');

    db.prepare(`
      UPDATE accounts SET
        name = ?,
        platform = ?,
        photo_url = ?,
        login_encrypted = ?,
        password_encrypted = CASE WHEN ? IS NULL THEN password_encrypted ELSE ? END,
        notes_encrypted = ?,
        roblox_username = ?,
        roblox_display_name = ?,
        roblox_user_id = ?,
        roblox_profile_url = ?,
        roblox_avatar_url = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      nextValues.name,
      nextValues.platform,
      nextValues.photoUrl,
      encryptSecret(nextValues.login),
      passwordChanged ? payload.password : null,
      passwordChanged ? encryptSecret(payload.password) : null,
      encryptSecret(nextValues.notes),
      roblox?.username || null,
      roblox?.displayName || null,
      roblox?.userId || null,
      roblox?.profileUrl || null,
      roblox?.avatarUrl || null,
      nowIso(),
      req.params.id
    );

    if (changedFields.length > 0) {
      writeAccountHistory({
        accountId: req.params.id,
        actorDiscordId: req.user.discordId,
        action: 'updated',
        metadata: { fields: changedFields }
      });
    }
    logAudit({ actorDiscordId: req.user.discordId, action: 'account.updated', targetType: 'account', targetId: req.params.id, metadata: { fields: changedFields }, ip: req.ip });
    res.json({ account: mapAccount(getAccountAccess(req.params.id, req.user.discordId).row) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id', requireAuth, requireAccountAccess('owner'), (req, res) => {
  const now = nowIso();
  db.prepare('UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, req.params.id);
  writeAccountHistory({ accountId: req.params.id, actorDiscordId: req.user.discordId, action: 'deleted' });
  logAudit({ actorDiscordId: req.user.discordId, action: 'account.deleted', targetType: 'account', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/accounts/:id/secret/password', requireAuth, requireAccountAccess('view'), (req, res) => {
  logAudit({ actorDiscordId: req.user.discordId, action: 'account.password_revealed', targetType: 'account', targetId: req.params.id, ip: req.ip });
  const password = tryDecryptSecret(req.accountAccess.row.password_encrypted);
  if (!password.ok) {
    return res.status(422).json({ error: 'Senha antiga nao pode ser descriptografada. Edite a conta e salve uma nova senha.' });
  }
  res.json({ password: password.value });
});

app.get('/api/accounts/:id/history', requireAuth, requireAccountAccess('view'), (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, u.username, u.avatar_url
    FROM account_history h
    LEFT JOIN users u ON u.discord_id = h.actor_discord_id
    WHERE h.account_id = ?
    ORDER BY h.created_at DESC
  `).all(req.params.id);
  res.json({
    history: rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      actorDiscordId: row.actor_discord_id,
      actorUsername: row.username,
      actorAvatarUrl: row.avatar_url,
      action: row.action,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at
    }))
  });
});

app.get('/api/accounts/:id/shares', requireAuth, requireAccountAccess('owner'), (req, res) => {
  const shares = db.prepare(`
    SELECT s.*, au.label, au.role, u.username, u.avatar_url
    FROM account_shares s
    JOIN authorized_users au ON au.discord_id = s.shared_with_discord_id
    LEFT JOIN users u ON u.discord_id = s.shared_with_discord_id
    WHERE s.account_id = ?
    ORDER BY s.updated_at DESC
  `).all(req.params.id);
  res.json({
    shares: shares.map((share) => ({
      discordId: share.shared_with_discord_id,
      permission: share.permission,
      label: share.label,
      role: share.role,
      username: share.username,
      avatarUrl: share.avatar_url,
      createdAt: share.created_at,
      updatedAt: share.updated_at
    }))
  });
});

app.put('/api/accounts/:id/shares', requireAuth, requireAccountAccess('owner'), (req, res, next) => {
  try {
    const payload = shareSchema.parse(req.body);
    if (payload.discordId === req.user.discordId) return res.status(400).json({ error: 'A conta ja pertence a voce.' });
    const authorized = getAuthorizedUser(payload.discordId);
    if (!authorized) return res.status(404).json({ error: 'Discord ID nao autorizado.' });
    const now = nowIso();
    db.prepare(`
      INSERT INTO account_shares (account_id, shared_with_discord_id, permission, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, shared_with_discord_id) DO UPDATE SET
        permission = excluded.permission,
        updated_at = excluded.updated_at
    `).run(req.params.id, payload.discordId, payload.permission, req.user.discordId, now, now);
    writeAccountHistory({
      accountId: req.params.id,
      actorDiscordId: req.user.discordId,
      action: 'shared',
      metadata: { discordId: payload.discordId, permission: payload.permission }
    });
    logAudit({ actorDiscordId: req.user.discordId, action: 'account.shared', targetType: 'account', targetId: req.params.id, metadata: payload, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id/shares/:discordId', requireAuth, requireAccountAccess('owner'), (req, res) => {
  db.prepare('DELETE FROM account_shares WHERE account_id = ? AND shared_with_discord_id = ?').run(req.params.id, req.params.discordId);
  writeAccountHistory({
    accountId: req.params.id,
    actorDiscordId: req.user.discordId,
    action: 'share_removed',
    metadata: { discordId: req.params.discordId }
  });
  logAudit({ actorDiscordId: req.user.discordId, action: 'account.share_removed', targetType: 'account', targetId: req.params.id, metadata: { discordId: req.params.discordId }, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT h.*, a.name AS account_name, u.username, u.avatar_url
    FROM account_history h
    JOIN accounts a ON a.id = h.account_id
    LEFT JOIN users u ON u.discord_id = h.actor_discord_id
    LEFT JOIN account_shares s ON s.account_id = a.id AND s.shared_with_discord_id = ?
    WHERE a.deleted_at IS NULL AND (a.owner_discord_id = ? OR s.shared_with_discord_id IS NOT NULL)
    ORDER BY h.created_at DESC
    LIMIT 200
  `).all(req.user.discordId, req.user.discordId);
  res.json({
    history: rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountName: row.account_name,
      actorDiscordId: row.actor_discord_id,
      actorUsername: row.username,
      actorAvatarUrl: row.avatar_url,
      action: row.action,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at
    }))
  });
});

app.get('/api/authorized-users', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare(`
    SELECT au.*, u.username, u.global_name, u.avatar_url, u.last_login_at
    FROM authorized_users au
    LEFT JOIN users u ON u.discord_id = au.discord_id
    WHERE au.active = 1
    ORDER BY CASE au.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, au.created_at ASC
  `).all();
  res.json({
    users: rows.map((row) => ({
      discordId: row.discord_id,
      role: row.role,
      label: row.label,
      username: row.username,
      globalName: row.global_name,
      avatarUrl: row.avatar_url,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  });
});

app.post('/api/authorized-users', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const payload = authorizedUserSchema.parse(req.body);
    if (payload.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas owners podem criar owners.' });
    const now = nowIso();
    db.prepare(`
      INSERT INTO authorized_users (discord_id, role, label, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        role = excluded.role,
        label = excluded.label,
        active = 1,
        updated_at = excluded.updated_at
    `).run(payload.discordId, payload.role, payload.label || `Discord ${payload.discordId}`, req.user.discordId, now, now);
    logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.upserted', targetType: 'authorized_user', targetId: payload.discordId, metadata: payload, ip: req.ip });
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/authorized-users/:discordId', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const payload = authorizedUserSchema.partial().parse({ ...req.body, discordId: req.params.discordId });
    if (payload.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas owners podem promover owners.' });
    db.prepare(`
      UPDATE authorized_users SET
        role = COALESCE(?, role),
        label = COALESCE(?, label),
        updated_at = ?
      WHERE discord_id = ? AND active = 1
    `).run(payload.role || null, payload.label || null, nowIso(), req.params.discordId);
    logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.updated', targetType: 'authorized_user', targetId: req.params.discordId, metadata: payload, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/authorized-users/:discordId', requireAuth, requireAdmin, (req, res) => {
  if (req.params.discordId === req.user.discordId) return res.status(400).json({ error: 'Voce nao pode remover seu proprio acesso.' });
  db.prepare('UPDATE authorized_users SET active = 0, updated_at = ? WHERE discord_id = ?').run(nowIso(), req.params.discordId);
  logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.revoked', targetType: 'authorized_user', targetId: req.params.discordId, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/audit-logs', requireAuth, requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250').all();
  res.json({
    logs: rows.map((row) => ({
      id: row.id,
      actorDiscordId: row.actor_discord_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      ip: row.ip,
      metadata: JSON.parse(row.metadata_json || '{}'),
      createdAt: row.created_at
    }))
  });
});

app.get('/api/backup', requireAuth, requireOwner, (req, res) => {
  const data = {
    exportedAt: nowIso(),
    authorizedUsers: db.prepare('SELECT * FROM authorized_users').all(),
    users: db.prepare('SELECT * FROM users').all(),
    accounts: db.prepare('SELECT * FROM accounts').all(),
    shares: db.prepare('SELECT * FROM account_shares').all(),
    history: db.prepare('SELECT * FROM account_history').all(),
    audit: db.prepare('SELECT * FROM audit_logs').all()
  };
  const payload = encryptSecret(JSON.stringify(data));
  logAudit({ actorDiscordId: req.user.discordId, action: 'backup.exported', targetType: 'backup', ip: req.ip });
  res.json({ format: 'nexus-backup-v1', encrypted: true, payload });
});

app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Dados invalidos.', details: error.flatten() });
  }
  const status = error.status || 500;
  res.status(status).json({ error: error.message || 'Erro interno.' });
});

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`Nexus API pronta em ${config.apiPublicUrl}`);
  });
}

export { app };
