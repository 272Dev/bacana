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
import { db, getAuthorizedUser, initDatabase, nowIso, seedAuthorizedUsers } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { destroyCloudinaryMedia, isCloudinaryEnabled, uploadCloudinaryMedia } from './cloudinary.js';
import {
  decodeR2StoredName,
  deleteR2Object,
  encodeR2StoredName,
  fetchR2Object,
  isR2Enabled,
  isR2StoredName,
  makeR2Key,
  uploadR2Object
} from './r2.js';
import { logAudit, writeAccountHistory } from './audit.js';
import {
  createAuthenticator,
  deleteAuthenticator,
  getAuthenticator,
  listAuthenticators,
  updateAuthenticator
} from './authenticator.js';
import {
  createTempEmailInbox,
  deleteTempEmailInbox,
  getTempEmailMessage,
  listTempEmailDomains,
  listTempEmailInboxes,
  listTempEmailMessages
} from './tempEmail.js';
import {
  createDiscordChannel,
  createDiscordRole,
  deleteDiscordChannel,
  deleteDiscordRole,
  getDiscordBotStatus,
  lookupDiscordUser,
  runDiscordModerationAction,
  sendDiscordWebhookMessage,
  setDiscordMemberRole,
  updateDiscordChannel,
  updateDiscordRole
} from './discordTools.js';
import {
  getDiscordRuntimeState,
  runDiscordBotLifecycle,
  runDiscordVoiceAction,
  startDefaultDiscordBot
} from './discordRuntime.js';
import { lookupRobloxUsername } from './roblox.js';
import {
  getRobloxGeneratorAccount,
  importRobloxGeneratorFile,
  importRobloxGeneratorText,
  listRobloxGeneratorAccounts,
  selectRandomRobloxGeneratorAccount,
  selectRobloxGeneratorAccount
} from './robloxGenerator.js';
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
await initDatabase();
await seedAuthorizedUsers();
await importRobloxGeneratorFile().catch((error) => {
  if (config.nodeEnv !== 'production') {
    console.warn('[nexus] Importacao automatica Roblox falhou:', error.message);
  }
});

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');
const uploadsDir = path.resolve(config.rootDir, 'data/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

function wrapAsync(handler) {
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (pathOrRoute, ...handlers) => original(pathOrRoute, ...handlers.map(wrapAsync));
}

app.set('trust proxy', config.security.trustProxy);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: config.clientUrl,
  credentials: true
}));
app.use(express.json({ limit: '60mb' }));
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
      void logAudit({
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

async function getAccountAccess(accountId, discordId) {
  const account = await db.prepare(`
    SELECT *, 'owner' AS permission
    FROM accounts
    WHERE id = ? AND owner_discord_id = ? AND deleted_at IS NULL
  `).get(accountId, discordId);
  if (account) return { row: account, permission: 'owner', canEdit: true, canShare: true };

  const teamAccount = await db.prepare(`
    SELECT *, 'edit' AS permission
    FROM accounts
    WHERE id = ? AND deleted_at IS NULL
  `).get(accountId);
  if (teamAccount) {
    return { row: teamAccount, permission: 'edit', canEdit: true, canShare: false };
  }

  const shared = await db.prepare(`
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
  return async (req, res, next) => {
    try {
      const access = await getAccountAccess(req.params.id, req.user.discordId);
      if (!access) return res.status(404).json({ error: 'Conta nao encontrada.' });
      if (permission === 'edit' && !access.canEdit) return res.status(403).json({ error: 'Sem permissao de edicao.' });
      if (permission === 'owner' && !access.canShare) return res.status(403).json({ error: 'Apenas o dono pode alterar compartilhamentos.' });
      req.accountAccess = access;
      next();
    } catch (error) {
      next(error);
    }
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

const robloxGeneratorImportSchema = z.object({
  text: z.string().min(3).max(2_000_000),
  sourceLabel: z.string().trim().max(120).optional().or(z.literal(''))
});

const authenticatorCreateSchema = z.object({
  label: z.string().trim().max(120).optional().or(z.literal('')),
  issuer: z.string().trim().max(120).optional().or(z.literal('')),
  username: z.string().trim().max(180).optional().or(z.literal('')),
  secret: z.string().trim().min(3).max(1000),
  notes: z.string().max(1000).optional().default(''),
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).optional().default('SHA1'),
  digits: z.union([z.literal(6), z.literal(8)]).optional().default(6),
  period: z.number().int().min(10).max(120).optional().default(30)
});

const authenticatorUpdateSchema = z.object({
  period: z.coerce.number().int().min(10).max(120)
});

const tempEmailCreateSchema = z.object({
  label: z.string().trim().max(120).optional().or(z.literal('')),
  prefix: z.string().trim().max(40).optional().or(z.literal('')),
  domain: z.string().trim().max(180).optional().or(z.literal(''))
});

const discordEmbedFieldSchema = z.object({
  name: z.string().trim().max(256).optional().or(z.literal('')),
  value: z.string().trim().max(1024).optional().or(z.literal('')),
  inline: z.boolean().optional().default(false)
});

const discordEmbedSchema = z.object({
  title: z.string().trim().max(256).optional().or(z.literal('')),
  description: z.string().trim().max(4096).optional().or(z.literal('')),
  color: z.string().trim().max(16).optional().or(z.literal('')),
  image: z.string().trim().max(500).optional().or(z.literal('')),
  thumbnail: z.string().trim().max(500).optional().or(z.literal('')),
  footer: z.string().trim().max(2048).optional().or(z.literal('')),
  fields: z.array(discordEmbedFieldSchema).max(25).optional().default([])
});

const discordWebhookSchema = z.object({
  webhookUrl: z.string().trim().min(10).max(1000),
  content: z.string().max(2000).optional().or(z.literal('')),
  username: z.string().trim().max(80).optional().or(z.literal('')),
  avatarUrl: z.string().trim().max(500).optional().or(z.literal('')),
  embed: discordEmbedSchema.optional().default({})
});

const discordBotRequestSchema = z.object({
  botToken: z.string().trim().max(300).optional().or(z.literal('')),
  guildId: z.string().trim().max(32).optional().or(z.literal(''))
});

const discordChannelSchema = discordBotRequestSchema.extend({
  channelId: z.string().trim().max(32).optional().or(z.literal('')),
  name: z.string().trim().max(100).optional().or(z.literal('')),
  type: z.coerce.number().int().min(0).max(15).optional().default(0),
  parentId: z.string().trim().max(32).optional().nullable().or(z.literal('')),
  position: z.union([z.string(), z.number()]).optional(),
  permissionOverwrites: z.array(z.any()).optional()
});

const discordRoleSchema = discordBotRequestSchema.extend({
  roleId: z.string().trim().max(32).optional().or(z.literal('')),
  name: z.string().trim().max(100).optional().or(z.literal('')),
  color: z.string().trim().max(16).optional().or(z.literal('')),
  permissions: z.string().trim().max(32).optional().or(z.literal('')),
  userId: z.string().trim().max(32).optional().or(z.literal('')),
  action: z.enum(['add', 'remove']).optional().default('add')
});

const discordModerationSchema = discordBotRequestSchema.extend({
  userId: z.string().trim().max(32).optional().or(z.literal('')),
  channelId: z.string().trim().max(32).optional().or(z.literal('')),
  action: z.enum(['ban', 'kick', 'timeout', 'untimeout', 'warn', 'clear']),
  reason: z.string().trim().max(512).optional().or(z.literal('')),
  durationMinutes: z.coerce.number().int().min(1).max(40320).optional().default(10),
  amount: z.coerce.number().int().min(1).max(100).optional().default(10),
  message: z.string().max(2000).optional().or(z.literal(''))
});

const discordBotLifecycleSchema = discordBotRequestSchema.extend({
  action: z.enum(['start', 'stop', 'restart', 'reconnect']).optional().default('start'),
  status: z.enum(['online', 'idle', 'dnd', 'invisible', 'offline']).optional().default('online'),
  activityType: z.enum(['Watching', 'Playing', 'Listening', 'Competing']).optional().default('Watching'),
  activityMessage: z.string().trim().max(128).optional().or(z.literal(''))
});

const discordVoiceSchema = discordBotRequestSchema.extend({
  action: z.enum(['join', 'move', 'leave']).optional().default('join'),
  voiceChannelId: z.string().trim().max(32).optional().or(z.literal('')),
  voiceDuration: z.enum(['30m', '1h', '6h', 'forever', 'custom']).optional().default('forever'),
  voiceHours: z.coerce.number().min(0).max(168).optional().default(0),
  voiceMinutes: z.coerce.number().min(0).max(59).optional().default(0),
  voiceAfkMode: z.boolean().optional().default(true)
});

const discordUserLookupSchema = z.object({
  userId: z.string().trim().min(5).max(32),
  botToken: z.string().trim().max(300).optional().or(z.literal(''))
});

const previewImageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

const previewVideoTypes = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime'
]);

const knownMediaExtensions = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['application/json', 'json'],
  ['text/plain', 'txt']
]);

const maxMediaBytes = 40 * 1024 * 1024;

function sanitizeFileBase(name) {
  const parsed = path.parse(String(name || 'midia'));
  return (parsed.name || 'midia')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'midia';
}

function sanitizeFileExt(name, mimeType) {
  const knownExt = knownMediaExtensions.get(mimeType);
  if (knownExt) return knownExt;
  const originalExt = path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
  if (/^[a-z0-9]{1,12}$/.test(originalExt)) return originalExt;
  const subtype = String(mimeType || '').split('/')[1] || '';
  const mimeExt = subtype.split(/[+;]/)[0].toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(mimeExt) ? mimeExt : 'bin';
}

function getMediaKind(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (previewImageTypes.has(normalized)) return 'image';
  if (previewVideoTypes.has(normalized)) return 'video';
  return 'file';
}

function parseMediaDataUrl(dataUrl, originalName) {
  const match = String(dataUrl).match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const error = new Error('Arquivo invalido.');
    error.status = 400;
    throw error;
  }
  const mimeType = (match[1] || 'application/octet-stream').toLowerCase();
  const ext = sanitizeFileExt(originalName, mimeType);
  const base64 = match[2].replace(/\s/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const kind = getMediaKind(mimeType);
  const resourceType = kind === 'file' ? 'raw' : kind;
  if (buffer.length === 0 || buffer.length > maxMediaBytes) {
    const error = new Error('Arquivo deve ter ate 40 MB.');
    error.status = 400;
    throw error;
  }
  return { mimeType, ext, buffer, kind, resourceType, dataUrl: `data:${mimeType};base64,${base64}` };
}

function mapFolder(row) {
  return {
    id: row.id,
    name: row.name,
    imageCount: Number(row.image_count || 0),
    mediaCount: Number(row.image_count || 0),
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
    kind: getMediaKind(row.mime_type),
    sizeBytes: row.size_bytes,
    url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function isCloudinaryMedia(row) {
  return /^https:\/\/res\.cloudinary\.com\//i.test(String(row.url || ''));
}

function getCloudinaryResourceType(row) {
  const kind = getMediaKind(row.mime_type);
  return kind === 'file' ? 'raw' : kind;
}

function getDownloadFileName(name) {
  return path.basename(String(name || 'arquivo'))
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140) || 'arquivo';
}

function setMediaResponseHeaders(res, row) {
  const inline = getMediaKind(row.mime_type) !== 'file';
  res.type(inline ? row.mime_type : 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  if (!inline) {
    const fileName = getDownloadFileName(row.original_name);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  }
}

function getImageFilePath(row) {
  const filePath = path.resolve(uploadsDir, row.owner_discord_id, row.stored_name);
  const ownerDir = path.resolve(uploadsDir, row.owner_discord_id);
  if (!filePath.startsWith(ownerDir)) return null;
  return filePath;
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, name: 'Nexus', time: nowIso() });
});

app.get('/api/config/status', async (_req, res) => {
  if (config.nodeEnv === 'production') {
    return res.json({
      ok: true,
      cloudinaryEnabled: isCloudinaryEnabled(),
      r2Enabled: isR2Enabled(),
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
    r2Enabled: isR2Enabled(),
    authorizedUsers: config.authorizedUsers.map((user) => ({ discordId: user.discordId, role: user.role })),
    missing: getMissingRuntimeConfig(),
    oauthReady: hasDiscordOAuthConfig()
  });
});

app.get('/api/auth/discord', authLimiter, async (req, res, next) => {
  try {
  const blockedUntil = await checkLoginBlocked(req.ip);
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
  } catch (error) {
    next(error);
  }
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
    const blockedUntil = await checkLoginBlocked(req.ip);
    if (blockedUntil) return res.status(429).json({ error: 'Acesso bloqueado.', code: 'blocked' });
    if (!validateOAuthStateValue(req, req.body?.state)) {
      await recordFailedLogin(req.ip, 'invalid_state');
      return res.status(401).json({ error: 'Sessao de login expirada.', code: 'invalid_state' });
    }
    if (!req.body?.accessToken) {
      await recordFailedLogin(req.ip, 'missing_token');
      return res.status(400).json({ error: 'Token Discord ausente.', code: 'oauth' });
    }

    const discordUser = await fetchDiscordUser(String(req.body.accessToken));
    const authorized = await getAuthorizedUser(discordUser.id);
    if (!authorized) {
      await recordFailedLogin(req.ip, 'discord_id_not_allowed');
      clearOAuthStateCookie(res);
      return res.status(403).json({ error: 'Discord ID nao autorizado.', code: 'unauthorized' });
    }

    await upsertDiscordUser(discordUser, authorized.role);
    await resetFailedLogin(req.ip);
    clearOAuthStateCookie(res);
    setSessionCookie(res, discordUser.id);
    await logAudit({
      actorDiscordId: discordUser.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: discordUser.id,
      metadata: { flow: 'implicit' },
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (error) {
    await recordFailedLogin(req.ip, error.oauthCode || 'implicit_oauth_error');
    await logAudit({
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
    const blockedUntil = await checkLoginBlocked(req.ip);
    if (blockedUntil) return res.redirect(clientRedirect('/login', { error: 'blocked' }));
    if (!validateOAuthState(req)) {
      await recordFailedLogin(req.ip, 'invalid_state');
      return res.redirect(clientRedirect('/login', { error: 'invalid_state' }));
    }
    if (!req.query.code) {
      await recordFailedLogin(req.ip, 'missing_code');
      return res.redirect(clientRedirect('/login', { error: 'missing_code' }));
    }

    const token = await exchangeDiscordCode(String(req.query.code));
    const discordUser = await fetchDiscordUser(token.access_token);
    const authorized = await getAuthorizedUser(discordUser.id);
    if (!authorized) {
      await recordFailedLogin(req.ip, 'discord_id_not_allowed');
      clearOAuthStateCookie(res);
      return res.redirect(clientRedirect('/login', { error: 'unauthorized' }));
    }

    await upsertDiscordUser(discordUser, authorized.role);
    await resetFailedLogin(req.ip);
    clearOAuthStateCookie(res);
    setSessionCookie(res, discordUser.id);
    await logAudit({
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
    await recordFailedLogin(req.ip, reason);
    await logAudit({
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

app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await logAudit({ actorDiscordId: req.user.discordId, action: 'auth.logout', targetType: 'user', targetId: req.user.discordId, ip: req.ip });
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/image-folders', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT f.*, COUNT(i.id) AS image_count
    FROM image_folders f
    LEFT JOIN images i ON i.folder_id = f.id
    GROUP BY f.id
    ORDER BY f.updated_at DESC
  `).all();
  res.json({ folders: rows.map(mapFolder) });
});

app.post('/api/image-folders', requireAuth, async (req, res, next) => {
  try {
    const payload = folderSchema.parse(req.body);
    const id = crypto.randomUUID();
    const now = nowIso();
    await db.prepare(`
      INSERT INTO image_folders (id, owner_discord_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.user.discordId, payload.name, now, now);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'image_folder.created', targetType: 'image_folder', targetId: id, ip: req.ip });
    const row = await db.prepare('SELECT *, 0 AS image_count FROM image_folders WHERE id = ?').get(id);
    res.status(201).json({ folder: mapFolder(row) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/image-folders/:id', requireAuth, async (req, res) => {
  const row = await db.prepare('SELECT * FROM image_folders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Pasta nao encontrada.' });
  await db.prepare('UPDATE images SET folder_id = NULL, updated_at = ? WHERE folder_id = ?').run(nowIso(), req.params.id);
  await db.prepare('DELETE FROM image_folders WHERE id = ?').run(req.params.id);
  await logAudit({ actorDiscordId: req.user.discordId, action: 'image_folder.deleted', targetType: 'image_folder', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/images', requireAuth, async (req, res) => {
  const folderId = String(req.query.folderId || '');
  const rows = folderId
    ? await db.prepare(`
        SELECT *
        FROM images
        WHERE folder_id = ?
        ORDER BY created_at DESC
      `).all(folderId)
    : await db.prepare(`
        SELECT *
        FROM images
        WHERE folder_id IS NULL
        ORDER BY created_at DESC
      `).all();
  res.json({ images: rows.map(mapImage) });
});

app.post('/api/images', requireAuth, async (req, res, next) => {
  try {
    const payload = uploadImageSchema.parse(req.body);
    const folderId = payload.folderId || null;
    if (folderId) {
      const folder = await db.prepare('SELECT * FROM image_folders WHERE id = ?').get(folderId);
      if (!folder) return res.status(404).json({ error: 'Pasta nao encontrada.' });
    }

    const parsed = parseMediaDataUrl(payload.dataUrl, payload.name);
    const id = crypto.randomUUID();
    const baseName = sanitizeFileBase(payload.name || `midia-${id}`);
    let storedName = `${id}-${baseName}.${parsed.ext}`;
    let url = `${config.apiPublicUrl}/api/images/${id}/file`;
    let sizeBytes = parsed.buffer.length;

    if (isR2Enabled()) {
      const key = makeR2Key({
        discordId: req.user.discordId,
        id,
        baseName,
        ext: parsed.ext
      });
      await uploadR2Object({
        key,
        buffer: parsed.buffer,
        mimeType: parsed.mimeType
      });
      storedName = encodeR2StoredName(key);
    } else if (isCloudinaryEnabled()) {
      const publicId = `${req.user.discordId}/${id}-${baseName}`;
      const cloudinaryMedia = await uploadCloudinaryMedia({
        dataUrl: parsed.dataUrl,
        publicId,
        resourceType: parsed.resourceType
      });
      storedName = cloudinaryMedia.public_id || publicId;
      url = cloudinaryMedia.secure_url;
      sizeBytes = cloudinaryMedia.bytes || parsed.buffer.length;
    } else {
      const folderPath = path.join(uploadsDir, req.user.discordId);
      fs.mkdirSync(folderPath, { recursive: true });
      const targetPath = path.join(folderPath, storedName);
      fs.writeFileSync(targetPath, parsed.buffer);
    }

    const now = nowIso();
    await db.prepare(`
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
      await db.prepare('UPDATE image_folders SET updated_at = ? WHERE id = ?').run(now, folderId);
    }
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'image.uploaded',
      targetType: 'image',
      targetId: id,
      metadata: { folderId, mimeType: parsed.mimeType, storage: isR2Enabled() ? 'r2' : isCloudinaryEnabled() ? 'cloudinary' : 'local' },
      ip: req.ip
    });
    const row = await db.prepare('SELECT * FROM images WHERE id = ?').get(id);
    res.status(201).json({ image: mapImage(row) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/images/:id/file', async (req, res) => {
  const row = await db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).send('Midia nao encontrada.');
  if (isR2StoredName(row.stored_name)) {
    try {
      const response = await fetchR2Object(decodeR2StoredName(row.stored_name));
      setMediaResponseHeaders(res, row);
      return res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      return res.status(error.status || 502).send(error.message);
    }
  }
  if (isCloudinaryMedia(row)) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.redirect(row.url);
  }
  const filePath = getImageFilePath(row);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('Arquivo nao encontrado.');
  setMediaResponseHeaders(res, row);
  res.sendFile(filePath);
});

app.delete('/api/images/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await db.prepare('SELECT * FROM images WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Midia nao encontrada.' });
    if (isR2StoredName(row.stored_name)) {
      await deleteR2Object(decodeR2StoredName(row.stored_name));
    } else if (isCloudinaryMedia(row)) {
      await destroyCloudinaryMedia(row.stored_name, getCloudinaryResourceType(row));
    } else {
      const filePath = getImageFilePath(row);
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    await db.prepare('DELETE FROM images WHERE id = ?').run(req.params.id);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'image.deleted', targetType: 'image', targetId: req.params.id, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/roblox/lookup', requireAuth, async (req, res, next) => {
  try {
    const result = await lookupRobloxUsername(req.body?.username);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'roblox.lookup', targetType: 'roblox', targetId: result.userId, ip: req.ip });
    res.json({ roblox: result });
  } catch (error) {
    next(error);
  }
});

app.get('/api/roblox-generator/accounts', requireAuth, async (req, res) => {
  const result = await listRobloxGeneratorAccounts({
    search: req.query.search,
    status: req.query.status,
    limit: req.query.limit,
    offset: req.query.offset
  });
  res.json(result);
});

app.post('/api/roblox-generator/import', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const payload = robloxGeneratorImportSchema.parse(req.body);
    const result = await importRobloxGeneratorText({
      text: payload.text,
      actorDiscordId: req.user.discordId,
      sourceLabel: payload.sourceLabel || 'upload-txt'
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'roblox_generator.imported',
      targetType: 'roblox_generator',
      metadata: {
        imported: result.imported,
        created: result.created,
        updated: result.updated,
        invalidLines: result.invalidLines.length,
        withoutRobloxProfile: result.withoutRobloxProfile,
        lookupError: result.lookupError
      },
      ip: req.ip
    });
    res.status(201).json({ result });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/roblox-generator/accounts/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Conta Roblox nao encontrada.' });
    await db.prepare('DELETE FROM roblox_generator_accounts WHERE id = ?').run(req.params.id);
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'roblox_generator.deleted',
      targetType: 'roblox_generator_account',
      targetId: req.params.id,
      metadata: { username: row.username },
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/roblox-generator/random', requireAuth, async (req, res, next) => {
  try {
    const account = await selectRandomRobloxGeneratorAccount();
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'roblox_generator.random_selected',
      targetType: 'roblox_generator_account',
      targetId: account.id,
      ip: req.ip
    });
    res.json({ account });
  } catch (error) {
    next(error);
  }
});

app.get('/api/roblox-generator/accounts/:id', requireAuth, async (req, res) => {
  const account = await getRobloxGeneratorAccount(req.params.id);
  if (!account) return res.status(404).json({ error: 'Conta Roblox nao encontrada.' });
  res.json({ account });
});

app.post('/api/roblox-generator/accounts/:id/select', requireAuth, async (req, res, next) => {
  try {
    const account = await selectRobloxGeneratorAccount({ id: req.params.id });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'roblox_generator.selected',
      targetType: 'roblox_generator_account',
      targetId: account.id,
      ip: req.ip
    });
    res.json({ account });
  } catch (error) {
    next(error);
  }
});

app.get('/api/authenticators', requireAuth, async (req, res) => {
  const authenticators = await listAuthenticators({ search: req.query.search });
  res.json({ authenticators });
});

app.post('/api/authenticators', requireAuth, async (req, res, next) => {
  try {
    const payload = authenticatorCreateSchema.parse(req.body);
    const authenticator = await createAuthenticator({
      payload,
      actorDiscordId: req.user.discordId
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'authenticator.created',
      targetType: 'authenticator',
      targetId: authenticator.id,
      metadata: { label: authenticator.label, issuer: authenticator.issuer },
      ip: req.ip
    });
    res.status(201).json({ authenticator });
  } catch (error) {
    next(error);
  }
});

app.get('/api/authenticators/:id', requireAuth, async (req, res) => {
  const authenticator = await getAuthenticator(req.params.id);
  if (!authenticator) return res.status(404).json({ error: 'Autenticador nao encontrado.' });
  res.json({ authenticator });
});

app.patch('/api/authenticators/:id', requireAuth, async (req, res, next) => {
  try {
    const existing = await getAuthenticator(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Autenticador nao encontrado.' });
    const payload = authenticatorUpdateSchema.parse(req.body);
    const authenticator = await updateAuthenticator(req.params.id, payload);
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'authenticator.updated',
      targetType: 'authenticator',
      targetId: req.params.id,
      metadata: { period: authenticator.period },
      ip: req.ip
    });
    res.json({ authenticator });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/authenticators/:id', requireAuth, async (req, res, next) => {
  try {
    const authenticator = await getAuthenticator(req.params.id);
    if (!authenticator) return res.status(404).json({ error: 'Autenticador nao encontrado.' });
    await deleteAuthenticator(req.params.id);
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'authenticator.deleted',
      targetType: 'authenticator',
      targetId: req.params.id,
      metadata: { label: authenticator.label },
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/temp-email/domains', requireAuth, async (_req, res) => {
  const domains = await listTempEmailDomains();
  res.json({ domains, provider: 'firemail' });
});

app.get('/api/temp-email/inboxes', requireAuth, async (req, res) => {
  const inboxes = await listTempEmailInboxes({ search: req.query.search });
  res.json({ inboxes, provider: 'firemail' });
});

app.post('/api/temp-email/inboxes', requireAuth, async (req, res, next) => {
  try {
    const payload = tempEmailCreateSchema.parse(req.body);
    const inbox = await createTempEmailInbox({
      payload,
      actorDiscordId: req.user.discordId
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'temp_email.created',
      targetType: 'temp_email',
      targetId: inbox.id,
      metadata: { address: inbox.address, provider: inbox.provider },
      ip: req.ip
    });
    res.status(201).json({ inbox });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/temp-email/inboxes/:id', requireAuth, async (req, res, next) => {
  try {
    await deleteTempEmailInbox(req.params.id);
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'temp_email.deleted',
      targetType: 'temp_email',
      targetId: req.params.id,
      ip: req.ip
    });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/temp-email/inboxes/:id/messages', requireAuth, async (req, res) => {
  const messages = await listTempEmailMessages(req.params.id);
  res.json({ messages });
});

app.get('/api/temp-email/inboxes/:id/messages/:messageId', requireAuth, async (req, res) => {
  const message = await getTempEmailMessage({
    inboxId: req.params.id,
    messageId: req.params.messageId
  });
  res.json({ message });
});

app.post('/api/discord-tools/webhook/send', requireAuth, async (req, res) => {
  const payload = discordWebhookSchema.parse(req.body);
  const result = await sendDiscordWebhookMessage(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.webhook_sent',
    targetType: 'discord_webhook',
    metadata: {
      hasContent: Boolean(payload.content),
      hasEmbed: Boolean(payload.embed && Object.values(payload.embed).some(Boolean))
    },
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/user-lookup', requireAuth, async (req, res) => {
  const payload = discordUserLookupSchema.parse(req.body);
  const user = await lookupDiscordUser(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.user_lookup',
    targetType: 'discord_user',
    targetId: user.id,
    ip: req.ip
  });
  res.json({ user });
});

app.post('/api/discord-tools/bot/status', requireAuth, async (req, res) => {
  const payload = discordBotRequestSchema.parse(req.body);
  const status = await getDiscordBotStatus(payload);
  const runtime = await getDiscordRuntimeState(payload).catch(() => ({ online: false, ready: false, voice: [] }));
  status.runtime = runtime;
  status.bot.online = Boolean(runtime.online);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.bot_status',
    targetType: 'discord_guild',
    targetId: status.guild?.id || payload.guildId || null,
    ip: req.ip
  });
  res.json(status);
});

app.post('/api/discord-tools/bot/lifecycle', requireAuth, async (req, res) => {
  const payload = discordBotLifecycleSchema.parse(req.body);
  const result = await runDiscordBotLifecycle(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: `discord_tools.bot_${payload.action}`,
    targetType: 'discord_bot',
    metadata: { status: payload.status, activityType: payload.activityType },
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/voice', requireAuth, async (req, res) => {
  const payload = discordVoiceSchema.parse(req.body);
  const result = await runDiscordVoiceAction(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: `discord_tools.voice_${payload.action}`,
    targetType: 'discord_channel',
    targetId: payload.voiceChannelId || null,
    metadata: { guildId: payload.guildId, duration: payload.voiceDuration },
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/channels', requireAuth, async (req, res) => {
  const payload = discordChannelSchema.parse(req.body);
  const channel = await createDiscordChannel(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.channel_created',
    targetType: 'discord_channel',
    targetId: channel.id,
    metadata: { name: channel.name, type: channel.type },
    ip: req.ip
  });
  res.status(201).json({ channel });
});

app.patch('/api/discord-tools/channels/:id', requireAuth, async (req, res) => {
  const payload = discordChannelSchema.parse({ ...req.body, channelId: req.params.id });
  const channel = await updateDiscordChannel(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.channel_updated',
    targetType: 'discord_channel',
    targetId: req.params.id,
    metadata: { name: channel.name, type: channel.type },
    ip: req.ip
  });
  res.json({ channel });
});

app.delete('/api/discord-tools/channels/:id', requireAuth, async (req, res) => {
  const payload = discordChannelSchema.parse({ ...req.body, channelId: req.params.id });
  const result = await deleteDiscordChannel(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.channel_deleted',
    targetType: 'discord_channel',
    targetId: req.params.id,
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/roles', requireAuth, async (req, res) => {
  const payload = discordRoleSchema.parse(req.body);
  const role = await createDiscordRole(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.role_created',
    targetType: 'discord_role',
    targetId: role.id,
    metadata: { name: role.name },
    ip: req.ip
  });
  res.status(201).json({ role });
});

app.patch('/api/discord-tools/roles/:id', requireAuth, async (req, res) => {
  const payload = discordRoleSchema.parse({ ...req.body, roleId: req.params.id });
  const role = await updateDiscordRole(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.role_updated',
    targetType: 'discord_role',
    targetId: req.params.id,
    metadata: { name: role.name },
    ip: req.ip
  });
  res.json({ role });
});

app.delete('/api/discord-tools/roles/:id', requireAuth, async (req, res) => {
  const payload = discordRoleSchema.parse({ ...req.body, roleId: req.params.id });
  const result = await deleteDiscordRole(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: 'discord_tools.role_deleted',
    targetType: 'discord_role',
    targetId: req.params.id,
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/roles/member', requireAuth, async (req, res) => {
  const payload = discordRoleSchema.parse(req.body);
  const result = await setDiscordMemberRole(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: payload.action === 'remove' ? 'discord_tools.member_role_removed' : 'discord_tools.member_role_added',
    targetType: 'discord_user',
    targetId: payload.userId,
    metadata: { roleId: payload.roleId },
    ip: req.ip
  });
  res.json(result);
});

app.post('/api/discord-tools/moderation', requireAuth, async (req, res) => {
  const payload = discordModerationSchema.parse(req.body);
  const result = await runDiscordModerationAction(payload);
  await logAudit({
    actorDiscordId: req.user.discordId,
    action: `discord_tools.moderation_${payload.action}`,
    targetType: payload.action === 'warn' || payload.action === 'clear' ? 'discord_channel' : 'discord_user',
    targetId: payload.action === 'warn' || payload.action === 'clear' ? payload.channelId : payload.userId,
    metadata: { reason: payload.reason || null },
    ip: req.ip
  });
  res.json(result);
});

app.get('/api/accounts', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT a.*, CASE WHEN a.owner_discord_id = ? THEN 'owner' ELSE 'edit' END AS permission
    FROM accounts a
    WHERE a.deleted_at IS NULL
    ORDER BY a.updated_at DESC
  `).all(req.user.discordId);

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
    await db.prepare(`
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

    await writeAccountHistory({
      accountId: id,
      actorDiscordId: req.user.discordId,
      action: 'created',
      metadata: { fields: ['name', 'login', 'password', 'platform', 'notes'].filter(Boolean) }
    });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'account.created', targetType: 'account', targetId: id, ip: req.ip });
    const row = (await getAccountAccess(id, req.user.discordId)).row;
    res.status(201).json({ account: mapAccount(row) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/accounts/:id', requireAuth, requireAccountAccess('view'), async (req, res) => {
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

    await db.prepare(`
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
      await writeAccountHistory({
        accountId: req.params.id,
        actorDiscordId: req.user.discordId,
        action: 'updated',
        metadata: { fields: changedFields }
      });
    }
    await logAudit({ actorDiscordId: req.user.discordId, action: 'account.updated', targetType: 'account', targetId: req.params.id, metadata: { fields: changedFields }, ip: req.ip });
    res.json({ account: mapAccount((await getAccountAccess(req.params.id, req.user.discordId)).row) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id', requireAuth, requireAccountAccess('owner'), async (req, res) => {
  const now = nowIso();
  await db.prepare('UPDATE accounts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, req.params.id);
  await writeAccountHistory({ accountId: req.params.id, actorDiscordId: req.user.discordId, action: 'deleted' });
  await logAudit({ actorDiscordId: req.user.discordId, action: 'account.deleted', targetType: 'account', targetId: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/accounts/:id/secret/password', requireAuth, requireAccountAccess('view'), async (req, res) => {
  await logAudit({ actorDiscordId: req.user.discordId, action: 'account.password_revealed', targetType: 'account', targetId: req.params.id, ip: req.ip });
  const password = tryDecryptSecret(req.accountAccess.row.password_encrypted);
  if (!password.ok) {
    return res.status(422).json({ error: 'Senha antiga nao pode ser descriptografada. Edite a conta e salve uma nova senha.' });
  }
  res.json({ password: password.value });
});

app.get('/api/accounts/:id/history', requireAuth, requireAccountAccess('view'), async (req, res) => {
  const rows = await db.prepare(`
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

app.get('/api/accounts/:id/shares', requireAuth, requireAccountAccess('owner'), async (req, res) => {
  const shares = await db.prepare(`
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

app.put('/api/accounts/:id/shares', requireAuth, requireAccountAccess('owner'), async (req, res, next) => {
  try {
    const payload = shareSchema.parse(req.body);
    if (payload.discordId === req.user.discordId) return res.status(400).json({ error: 'A conta ja pertence a voce.' });
    const authorized = await getAuthorizedUser(payload.discordId);
    if (!authorized) return res.status(404).json({ error: 'Discord ID nao autorizado.' });
    const now = nowIso();
    await db.prepare(`
      INSERT INTO account_shares (account_id, shared_with_discord_id, permission, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, shared_with_discord_id) DO UPDATE SET
        permission = excluded.permission,
        updated_at = excluded.updated_at
    `).run(req.params.id, payload.discordId, payload.permission, req.user.discordId, now, now);
    await writeAccountHistory({
      accountId: req.params.id,
      actorDiscordId: req.user.discordId,
      action: 'shared',
      metadata: { discordId: payload.discordId, permission: payload.permission }
    });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'account.shared', targetType: 'account', targetId: req.params.id, metadata: payload, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/accounts/:id/shares/:discordId', requireAuth, requireAccountAccess('owner'), async (req, res) => {
  await db.prepare('DELETE FROM account_shares WHERE account_id = ? AND shared_with_discord_id = ?').run(req.params.id, req.params.discordId);
  await writeAccountHistory({
    accountId: req.params.id,
    actorDiscordId: req.user.discordId,
    action: 'share_removed',
    metadata: { discordId: req.params.discordId }
  });
  await logAudit({ actorDiscordId: req.user.discordId, action: 'account.share_removed', targetType: 'account', targetId: req.params.id, metadata: { discordId: req.params.discordId }, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const rows = await db.prepare(`
    SELECT h.*, a.name AS account_name, u.username, u.avatar_url
    FROM account_history h
    JOIN accounts a ON a.id = h.account_id
    LEFT JOIN users u ON u.discord_id = h.actor_discord_id
    WHERE a.deleted_at IS NULL
    ORDER BY h.created_at DESC
    LIMIT 200
  `).all();
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

app.get('/api/authorized-users', requireAuth, requireAdmin, async (_req, res) => {
  const rows = await db.prepare(`
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

app.post('/api/authorized-users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const payload = authorizedUserSchema.parse(req.body);
    if (payload.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas owners podem criar owners.' });
    const now = nowIso();
    await db.prepare(`
      INSERT INTO authorized_users (discord_id, role, label, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        role = excluded.role,
        label = excluded.label,
        active = 1,
        updated_at = excluded.updated_at
    `).run(payload.discordId, payload.role, payload.label || `Discord ${payload.discordId}`, req.user.discordId, now, now);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.upserted', targetType: 'authorized_user', targetId: payload.discordId, metadata: payload, ip: req.ip });
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/authorized-users/:discordId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const payload = authorizedUserSchema.partial().parse({ ...req.body, discordId: req.params.discordId });
    if (payload.role === 'owner' && req.user.role !== 'owner') return res.status(403).json({ error: 'Apenas owners podem promover owners.' });
    await db.prepare(`
      UPDATE authorized_users SET
        role = COALESCE(?, role),
        label = COALESCE(?, label),
        updated_at = ?
      WHERE discord_id = ? AND active = 1
    `).run(payload.role || null, payload.label || null, nowIso(), req.params.discordId);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.updated', targetType: 'authorized_user', targetId: req.params.discordId, metadata: payload, ip: req.ip });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/authorized-users/:discordId', requireAuth, requireAdmin, async (req, res) => {
  if (req.params.discordId === req.user.discordId) return res.status(400).json({ error: 'Voce nao pode remover seu proprio acesso.' });
  await db.prepare('UPDATE authorized_users SET active = 0, updated_at = ? WHERE discord_id = ?').run(nowIso(), req.params.discordId);
  await logAudit({ actorDiscordId: req.user.discordId, action: 'authorized_user.revoked', targetType: 'authorized_user', targetId: req.params.discordId, ip: req.ip });
  res.json({ ok: true });
});

app.get('/api/audit-logs', requireAuth, requireAdmin, async (_req, res) => {
  const rows = await db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 250').all();
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

app.get('/api/backup', requireAuth, requireOwner, async (req, res) => {
  const data = {
    exportedAt: nowIso(),
    authorizedUsers: await db.prepare('SELECT * FROM authorized_users').all(),
    users: await db.prepare('SELECT * FROM users').all(),
    accounts: await db.prepare('SELECT * FROM accounts').all(),
    robloxGeneratorAccounts: await db.prepare('SELECT * FROM roblox_generator_accounts').all(),
    authenticators: await db.prepare('SELECT * FROM authenticators').all(),
    tempEmailInboxes: await db.prepare('SELECT * FROM temp_email_inboxes').all(),
    shares: await db.prepare('SELECT * FROM account_shares').all(),
    history: await db.prepare('SELECT * FROM account_history').all(),
    audit: await db.prepare('SELECT * FROM audit_logs').all()
  };
  const payload = encryptSecret(JSON.stringify(data));
  await logAudit({ actorDiscordId: req.user.discordId, action: 'backup.exported', targetType: 'backup', ip: req.ip });
  res.json({ format: 'nexus-backup-v1', encrypted: true, payload });
});

app.use(express.static(distDir));
app.get('*', async (req, res, next) => {
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
    startDefaultDiscordBot()
      .then((result) => {
        if (result) console.log('Discord bot conectado ao Gateway.');
      })
      .catch((error) => {
        console.warn(`Discord bot nao conectou ao Gateway: ${error.message}`);
      });
  });
}

export { app };
