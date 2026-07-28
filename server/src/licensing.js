import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { lookupDiscordUser } from './discordTools.js';
import { logAudit } from './audit.js';
import { consumeSecurityLimit, secureHash } from './securityLimits.js';
import { invalidateLoaderTicketsForLicense } from './loaderTickets.js';
import {
  normalizeLicenseKeyInput,
  uniqueSecurityEvents,
  validateLicenseRedeemState
} from './licensePolicy.js';

const licenseStatusSchema = z.enum(['active', 'suspended', 'revoked', 'expired']);
const discordIdSchema = z.string().trim().regex(/^\d{5,32}$/);
const nullableDateSchema = z.union([
  z.string().datetime({ offset: true }),
  z.string().trim().length(0),
  z.null()
]).optional();

const planCreateSchema = z.object({
  name: z.string().trim().min(2).max(60),
  durationDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  defaultHwidResetLimit: z.coerce.number().int().min(0).max(100).default(1),
  priceCents: z.coerce.number().int().min(0).max(100000000).default(0),
  active: z.boolean().optional().default(true)
});

const planUpdateSchema = planCreateSchema.partial();

const userCreateSchema = z.object({
  discordId: discordIdSchema,
  planId: z.string().trim().min(1).max(80),
  expiresAt: nullableDateSchema,
  hwidResetLimit: z.coerce.number().int().min(0).max(100).optional(),
  status: licenseStatusSchema.optional().default('active')
});

const userUpdateSchema = z.object({
  discordId: discordIdSchema.optional(),
  planId: z.string().trim().min(1).max(80).optional(),
  expiresAt: nullableDateSchema,
  hwidResetLimit: z.coerce.number().int().min(0).max(100).optional(),
  status: licenseStatusSchema.optional()
});

const validateSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256).refine((value) => !/[\u0000-\u001F\u007F]/.test(value)),
  loaderVersion: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).optional().default('unknown'),
  requestNonce: z.string().trim().regex(/^[A-Za-z0-9_-]{16,120}$/).optional()
});

function httpError(message, status = 400, code = 'LICENSE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function normalizeLicenseKey(value) {
  return normalizeLicenseKeyInput(value);
}

export function hashLicenseKey(value) {
  return crypto.createHash('sha256').update(normalizeLicenseKey(value)).digest('hex');
}

export function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let body = '';
  for (let index = 0; index < 20; index += 1) {
    body += alphabet[bytes[index] % alphabet.length];
  }
  return `NXS-${body.match(/.{1,5}/g).join('-')}`;
}

function keyPreview(key) {
  const normalized = normalizeLicenseKey(key);
  return `${normalized.slice(0, 9)}•••••${normalized.slice(-5)}`;
}

function cleanIp(value) {
  const raw = String(value || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (!raw) return 'desconhecido';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (raw.includes(':')) {
    return `${raw.split(':').filter(Boolean).slice(0, 4).join(':')}::/64`;
  }
  return raw.slice(0, 80);
}

export function requestLicenseIp(req) {
  return cleanIp(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip);
}

const requestIp = requestLicenseIp;

function normalizeExpiresAt(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError('Data de expiracao invalida.');
  return date.toISOString();
}

function expirationForPlan(plan) {
  if (plan.duration_days == null) return null;
  return new Date(Date.now() + Number(plan.duration_days) * 86400000).toISOString();
}

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000));
}

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function revealStoredKey(row) {
  try {
    return decryptSecret(row.license_key_encrypted);
  } catch {
    return '';
  }
}

function mapPlan(row) {
  return {
    id: row.id,
    name: row.name,
    durationDays: row.duration_days == null ? null : Number(row.duration_days),
    defaultHwidResetLimit: Number(row.default_hwid_reset_limit || 0),
    priceCents: Math.max(0, Number(row.price_cents || 0)),
    active: Number(row.active) === 1,
    userCount: Number(row.user_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLicenseUser(row, { includeKey = false, includeEvents = false, publicSelf = false } = {}) {
  const result = {
    id: row.id,
    discordId: row.discord_id,
    discordUsername: row.discord_username,
    discordGlobalName: row.discord_global_name,
    discordAvatarUrl: row.discord_avatar_url,
    keyPreview: row.license_key_preview,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      durationDays: row.plan_duration_days == null ? null : Number(row.plan_duration_days)
    },
    status: row.status,
    expiresAt: row.expires_at,
    daysRemaining: daysRemaining(row.expires_at),
    hwid: row.hwid,
    hwidBoundAt: row.hwid_bound_at,
    hwidResetCount: Number(row.hwid_reset_count || 0),
    hwidResetLimit: Number(row.hwid_reset_limit || 0),
    hwidResetsRemaining: Math.max(0, Number(row.hwid_reset_limit || 0) - Number(row.hwid_reset_count || 0)),
    lastHwidResetAt: row.last_hwid_reset_at,
    lastUsedAt: row.last_used_at,
    lastIpApprox: row.last_ip_approx,
    lastLoaderVersion: row.last_loader_version,
    suspiciousScore: Number(row.suspicious_score || 0),
    suspiciousReason: row.suspicious_reason,
    redeemedAt: row.redeemed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeKey && !publicSelf) result.licenseKey = revealStoredKey(row);
  if (includeEvents) {
    result.events = (row.events || []).map((event) => ({
      id: event.id,
      type: event.event_type,
      hwid: publicSelf ? null : event.hwid,
      ipApprox: publicSelf ? null : event.ip_approx,
      loaderVersion: event.loader_version,
      metadata: parseJson(event.metadata_json),
      createdAt: event.created_at
    }));
  }
  return result;
}

async function getPlan(planId, { activeOnly = false } = {}) {
  const suffix = activeOnly ? ' AND active = 1' : '';
  return db.prepare(`SELECT * FROM license_plans WHERE id = ?${suffix}`).get(planId);
}

export async function findLicensePlan(planId, { activeOnly = false } = {}) {
  return mapPlan(await getPlan(planId, { activeOnly }));
}

export async function listLicensePlans({ activeOnly = false } = {}) {
  const rows = await db.prepare(`
    SELECT lp.*, COUNT(lu.id) AS user_count
    FROM license_plans lp
    LEFT JOIN license_users lu ON lu.plan_id = lp.id
    ${activeOnly ? 'WHERE lp.active = 1' : ''}
    GROUP BY lp.id, lp.name, lp.duration_days, lp.default_hwid_reset_limit,
      lp.price_cents, lp.active, lp.created_at, lp.updated_at
    ORDER BY CASE WHEN lp.duration_days IS NULL THEN 1 ELSE 0 END,
      lp.duration_days ASC, lp.price_cents ASC
  `).all();
  return rows.map(mapPlan);
}

function paidExpiration(plan, currentExpiresAt = null) {
  if (plan.duration_days == null) return null;
  const currentTimestamp = Date.parse(currentExpiresAt || '');
  const baseTimestamp = Number.isFinite(currentTimestamp) && currentTimestamp > Date.now()
    ? currentTimestamp
    : Date.now();
  return new Date(baseTimestamp + Number(plan.duration_days) * 86400000).toISOString();
}

export async function activateLicensePlanPayment({
  planId,
  discordId,
  actorDiscordId = null,
  paymentReference
}) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  const reference = String(paymentReference || '').trim();
  if (!reference || reference.length > 200) throw httpError('Referencia de pagamento invalida.', 400);
  const plan = await getPlan(planId);
  if (!plan) throw httpError('Plano da licenca nao encontrado.', 404);
  const profile = await resolveDiscordProfile(parsedDiscordId);
  const paymentNonceHash = crypto.createHash('sha256').update(`license-payment:${reference}`).digest('hex');

  const result = await db.transaction(async (tx) => {
    let row = await tx.prepare(`
      SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
      FROM license_users lu
      JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.discord_id = ?
    `).get(parsedDiscordId);

    if (row) {
      const alreadyApplied = await tx.prepare(`
        SELECT id FROM license_events
        WHERE license_user_id = ? AND event_type = 'payment_activated' AND request_nonce_hash = ?
      `).get(row.id, paymentNonceHash);
      if (!alreadyApplied) {
        const expiresAt = paidExpiration(plan, row.expires_at);
        await tx.prepare(`
          UPDATE license_users SET
            discord_username = ?, discord_global_name = ?, discord_avatar_url = ?,
            plan_id = ?, status = 'active', expires_at = ?,
            hwid_reset_limit = CASE
              WHEN hwid_reset_limit > ? THEN hwid_reset_limit ELSE ?
            END,
            updated_at = ?
          WHERE id = ?
        `).run(
          profile.username,
          profile.globalName,
          profile.avatarUrl,
          plan.id,
          expiresAt,
          Number(plan.default_hwid_reset_limit || 0),
          Number(plan.default_hwid_reset_limit || 0),
          nowIso(),
          row.id
        );
        await recordLicenseEvent(row.id, 'payment_activated', {
          requestNonceHash: paymentNonceHash,
          metadata: { source: 'livepix', planId: plan.id }
        }, tx);
        row = await getLicenseRow(row.id, tx);
      }
      return { row, renewed: !alreadyApplied, created: false };
    }

    const key = generateLicenseKey();
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    await tx.prepare(`
      INSERT INTO license_users (
        id, discord_id, discord_username, discord_global_name, discord_avatar_url,
        license_key_hash, license_key_encrypted, license_key_preview, plan_id, status,
        expires_at, hwid_reset_limit, redeemed_at, redeem_source,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'livepix', ?, ?, ?)
    `).run(
      id,
      parsedDiscordId,
      profile.username,
      profile.globalName,
      profile.avatarUrl,
      hashLicenseKey(key),
      encryptSecret(key),
      keyPreview(key),
      plan.id,
      paidExpiration(plan),
      Number(plan.default_hwid_reset_limit || 0),
      timestamp,
      actorDiscordId || parsedDiscordId,
      timestamp,
      timestamp
    );
    await recordLicenseEvent(id, 'payment_activated', {
      requestNonceHash: paymentNonceHash,
      metadata: { source: 'livepix', planId: plan.id }
    }, tx);
    row = await getLicenseRow(id, tx);
    return { row, renewed: false, created: true };
  });

  await logAudit({
    actorDiscordId: actorDiscordId || parsedDiscordId,
    action: result.created ? 'license_payment.created' : 'license_payment.renewed',
    targetType: 'license_user',
    targetId: result.row.id,
    metadata: { discordId: parsedDiscordId, planId: plan.id, paymentReferenceHash: paymentNonceHash }
  }).catch(() => {});

  return {
    id: result.row.id,
    key: revealStoredKey(result.row),
    keyPreview: result.row.license_key_preview,
    plan: mapPlan(plan),
    status: result.row.status,
    expiresAt: result.row.expires_at,
    created: result.created,
    renewed: result.renewed
  };
}

async function getLicenseRow(userId, store = db) {
  return store.prepare(`
    SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
    FROM license_users lu
    JOIN license_plans lp ON lp.id = lu.plan_id
    WHERE lu.id = ?
  `).get(userId);
}

async function resolveDiscordProfile(discordId) {
  const known = await db.prepare(`
    SELECT username, global_name, avatar_url FROM users WHERE discord_id = ?
  `).get(discordId);
  if (known?.username || known?.global_name || known?.avatar_url) {
    return {
      username: known.username || null,
      globalName: known.global_name || null,
      avatarUrl: known.avatar_url || null
    };
  }
  const lookup = await lookupDiscordUser({ userId: discordId, botToken: '' });
  return {
    username: lookup.username || null,
    globalName: lookup.globalName || null,
    avatarUrl: lookup.avatarUrl || null
  };
}

export async function recordLicenseEvent(userId, type, {
  hwid,
  ipApprox,
  loaderVersion,
  requestNonceHash = null,
  metadata = {}
} = {}, store = db) {
  await store.prepare(`
    INSERT INTO license_events (
      id, license_user_id, event_type, hwid, ip_approx, loader_version,
      request_nonce_hash, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (license_user_id, event_type, request_nonce_hash) DO NOTHING
  `).run(
    crypto.randomUUID(),
    userId,
    type,
    hwid || null,
    ipApprox || null,
    loaderVersion || null,
    requestNonceHash,
    JSON.stringify(metadata),
    nowIso()
  );
}

function normalizeHwid(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function safeHistoryMetadata(metadata = {}) {
  const allowed = ['status', 'reason', 'score', 'version', 'source', 'planId'];
  return Object.fromEntries(allowed
    .filter((key) => metadata[key] != null)
    .map((key) => [key, String(metadata[key]).slice(0, 120)]));
}

function selfProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    discordId: row.discord_id,
    discordUsername: row.discord_username,
    discordGlobalName: row.discord_global_name,
    discordAvatarUrl: row.discord_avatar_url,
    plan: row.plan_name,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    daysRemaining: daysRemaining(row.expires_at),
    keyPreview: row.license_key_preview,
    hwidBound: Boolean(row.hwid),
    hwidResetCount: Number(row.hwid_reset_count || 0),
    hwidResetLimit: Number(row.hwid_reset_limit || 0),
    hwidResetsRemaining: Math.max(0, Number(row.hwid_reset_limit || 0) - Number(row.hwid_reset_count || 0)),
    lastUsedAt: row.last_used_at,
    lastLoaderVersion: row.last_loader_version,
    redeemedAt: row.redeemed_at
  };
}

export async function getLicenseForDiscord(discordId, { applyLimit = true } = {}) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  if (applyLimit) {
    await consumeSecurityLimit({
      scope: 'license_query',
      subject: parsedDiscordId,
      max: config.loader.rateLimits.licenseQueries,
      windowSeconds: config.loader.rateLimits.licenseQueryWindowSeconds
    });
  }
  await expireLicenses();
  const row = await db.prepare(`
    SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
    FROM license_users lu
    JOIN license_plans lp ON lp.id = lu.plan_id
    WHERE lu.discord_id = ?
  `).get(parsedDiscordId);
  if (!row) throw httpError('Nenhuma licença vinculada ao seu Discord.', 404, 'LICENSE_NOT_FOUND');
  await recordLicenseEvent(row.id, 'license_viewed', { metadata: { source: 'discord_bot' } });
  return selfProfile(row);
}

export async function redeemLicenseForDiscord({ discordId, key, source = 'discord_bot', ipApprox = null }) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  const normalizedKey = normalizeLicenseKey(key);
  if (!/^NXS-(?:[A-Z2-9]{5}-){3}[A-Z2-9]{5}$/.test(normalizedKey)) {
    throw httpError('Key inválida ou indisponível.', 400, 'KEY_INVALID');
  }
  const limits = config.loader.rateLimits;
  await consumeSecurityLimit({
    scope: 'license_redeem_user',
    subject: parsedDiscordId,
    max: limits.redeemAttempts,
    windowSeconds: limits.redeemWindowSeconds
  });
  if (ipApprox) {
    await consumeSecurityLimit({
      scope: 'license_redeem_network',
      subject: ipApprox,
      max: limits.redeemAttempts,
      windowSeconds: limits.redeemWindowSeconds
    });
  }
  const normalizedHash = hashLicenseKey(normalizedKey);
  const result = await db.transaction(async (tx) => {
    const row = await tx.prepare(`
      SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
      FROM license_users lu
      JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.license_key_hash = ?
    `).get(normalizedHash);
    if (!row) throw httpError('Key inválida ou indisponível.', 404, 'KEY_INVALID');
    const timestamp = nowIso();
    const state = validateLicenseRedeemState(row, parsedDiscordId);
    if (!state.ok && state.code === 'LICENSE_EXPIRED') {
      await tx.prepare("UPDATE license_users SET status = 'expired', updated_at = ? WHERE id = ?").run(timestamp, row.id);
      await recordLicenseEvent(row.id, 'redeem_rejected', {
        metadata: { reason: 'expired', source }
      }, tx);
    }
    if (!state.ok && state.code === 'LICENSE_ALREADY_LINKED') {
      await recordLicenseEvent(row.id, 'redeem_rejected', {
        metadata: { reason: 'already_linked', source }
      }, tx);
    }
    if (!state.ok) throw httpError(state.message, state.status, state.code);
    const update = await tx.prepare(`
      UPDATE license_users
      SET discord_id = ?, redeemed_at = COALESCE(redeemed_at, ?),
        redeem_source = ?, updated_at = ?
      WHERE id = ? AND (discord_id IS NULL OR discord_id = '' OR discord_id = ?)
    `).run(parsedDiscordId, timestamp, source, timestamp, row.id, parsedDiscordId);
    if (Number(update.changes || 0) !== 1) {
      throw httpError('Esta licença já está vinculada.', 409, 'LICENSE_ALREADY_LINKED');
    }
    await recordLicenseEvent(row.id, 'key_redeemed', { metadata: { source } }, tx);
    return getLicenseRow(row.id, tx);
  });
  await logAudit({
    actorDiscordId: parsedDiscordId,
    action: 'license_user.key_redeemed',
    targetType: 'license_user',
    targetId: result.id,
    metadata: { source },
    ip: ipApprox
  });
  return selfProfile(result);
}

export async function resetHwidForDiscord({ discordId, source = 'discord_bot' }) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  const limits = config.loader.rateLimits;
  await consumeSecurityLimit({
    scope: 'hwid_reset',
    subject: parsedDiscordId,
    max: limits.hwidResets,
    windowSeconds: limits.hwidResetWindowSeconds
  });
  const result = await db.transaction(async (tx) => {
    const row = await tx.prepare(`
      SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
      FROM license_users lu JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.discord_id = ?
    `).get(parsedDiscordId);
    if (!row) throw httpError('Nenhuma licença vinculada ao seu Discord.', 404, 'LICENSE_NOT_FOUND');
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      throw httpError('Sua licença expirou.', 403, 'LICENSE_EXPIRED');
    }
    if (row.status === 'suspended') throw httpError('Sua licença está suspensa.', 403, 'LICENSE_SUSPENDED');
    if (row.status !== 'active') throw httpError('Sua licença não está ativa.', 403, 'LICENSE_NOT_FOUND');
    const timestamp = nowIso();
    const update = await tx.prepare(`
      UPDATE license_users SET
        hwid = NULL, hwid_bound_at = NULL, hwid_reset_count = hwid_reset_count + 1,
        last_hwid_reset_at = ?, suspicious_score = 0, suspicious_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'active' AND hwid_reset_count < hwid_reset_limit
    `).run(timestamp, timestamp, row.id);
    if (Number(update.changes || 0) !== 1) {
      throw httpError('Limite de resets de HWID atingido.', 409, 'HWID_RESET_LIMIT');
    }
    await tx.prepare(`
      UPDATE roblox_name_tags SET
        hwid_hash = NULL, roblox_user_id = NULL, roblox_username = NULL,
        roblox_display_name = NULL, updated_at = ?
      WHERE license_user_id = ?
    `).run(timestamp, row.id);
    await invalidateLoaderTicketsForLicense(row.id, 'hwid_reset', tx);
    await recordLicenseEvent(row.id, 'hwid_reset', {
      metadata: { actorDiscordId: parsedDiscordId, source }
    }, tx);
    return getLicenseRow(row.id, tx);
  });
  await logAudit({
    actorDiscordId: parsedDiscordId,
    action: 'license_user.hwid_reset',
    targetType: 'license_user',
    targetId: result.id,
    metadata: { source }
  });
  return selfProfile(result);
}

export async function getLicenseHistoryForDiscord(discordId, limit = 10) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  await consumeSecurityLimit({
    scope: 'license_history',
    subject: parsedDiscordId,
    max: config.loader.rateLimits.licenseQueries,
    windowSeconds: config.loader.rateLimits.licenseQueryWindowSeconds
  });
  const row = await db.prepare('SELECT id FROM license_users WHERE discord_id = ?').get(parsedDiscordId);
  if (!row) throw httpError('Nenhuma licença vinculada ao seu Discord.', 404, 'LICENSE_NOT_FOUND');
  const boundedLimit = Math.max(1, Math.min(10, Number(limit || 10)));
  const events = await db.prepare(`
    SELECT event_type, loader_version, metadata_json, created_at
    FROM license_events WHERE license_user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(row.id, boundedLimit);
  return events.map((event) => ({
    type: event.event_type,
    loaderVersion: event.loader_version || null,
    metadata: safeHistoryMetadata(parseJson(event.metadata_json)),
    createdAt: event.created_at
  }));
}

export async function isPanelPublisherAuthorized(discordId) {
  const parsedDiscordId = discordIdSchema.parse(discordId);
  if (config.discordBot.ownerIds.includes(parsedDiscordId)) return true;
  const row = await db.prepare(`
    SELECT role, active FROM authorized_users WHERE discord_id = ?
  `).get(parsedDiscordId);
  return Boolean(row && Number(row.active) === 1 && ['owner', 'admin'].includes(row.role));
}

export async function cleanupLicenseEvents() {
  const cutoff = new Date(Date.now() - config.loader.eventRetentionDays * 86400000).toISOString();
  const result = await db.prepare('DELETE FROM license_events WHERE created_at < ?').run(cutoff);
  return Number(result.changes || 0);
}

async function expireLicenses() {
  await db.prepare(`
    UPDATE license_users
    SET status = 'expired', updated_at = ?
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(nowIso(), nowIso());
}

async function suspendForSuspiciousUse(row, reason, score, context) {
  if (row.status === 'suspended') return;
  const nextScore = Math.max(Number(row.suspicious_score || 0), score);
  await db.prepare(`
    UPDATE license_users
    SET status = 'suspended', suspicious_score = ?, suspicious_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(nextScore, reason, nowIso(), row.id);
  await invalidateLoaderTicketsForLicense(row.id, 'license_suspended');
  await recordLicenseEvent(row.id, 'auto_suspended', {
    ...context,
    metadata: { ...(context?.metadata || {}), reason, score: nextScore }
  });
  await logAudit({
    actorDiscordId: null,
    action: 'license_user.auto_suspended',
    targetType: 'license_user',
    targetId: row.id,
    metadata: { reason, score: nextScore, eventIds: context?.metadata?.eventIds || [] }
  });
}

export async function validateLicenseAccess(input, ipApprox = 'desconhecido') {
  const parsed = validateSchema.parse(input);
  const payload = { ...parsed, hwid: normalizeHwid(parsed.hwid) };
  const requestNonceHash = payload.requestNonce
    ? secureHash(payload.requestNonce, 'loader-request-nonce')
    : null;
  const row = await db.prepare(`
    SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
    FROM license_users lu
    JOIN license_plans lp ON lp.id = lu.plan_id
    WHERE lu.license_key_hash = ?
  `).get(hashLicenseKey(payload.key));
  if (!row) throw httpError('Key invalida.', 401, 'KEY_INVALID');
  await consumeSecurityLimit({
    scope: 'loader_validation',
    subject: row.id,
    max: config.loader.rateLimits.validations,
    windowSeconds: config.loader.rateLimits.validationWindowSeconds
  });

  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    await db.prepare(`UPDATE license_users SET status = 'expired', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
    await invalidateLoaderTicketsForLicense(row.id, 'license_expired');
    await recordLicenseEvent(row.id, 'expired_rejected', {
      hwid: payload.hwid,
      ipApprox,
      loaderVersion: payload.loaderVersion,
      requestNonceHash
    });
    throw httpError('Licenca expirada.', 403, 'LICENSE_EXPIRED');
  }
  if (row.status !== 'active') {
    await recordLicenseEvent(row.id, 'status_rejected', {
      hwid: payload.hwid,
      ipApprox,
      loaderVersion: payload.loaderVersion,
      requestNonceHash,
      metadata: { status: row.status }
    });
    throw httpError('Licenca indisponivel.', 403, `LICENSE_${row.status.toUpperCase()}`);
  }

  if (row.hwid && row.hwid !== payload.hwid) {
    await recordLicenseEvent(row.id, 'hwid_mismatch', {
      hwid: payload.hwid,
      ipApprox,
      loaderVersion: payload.loaderVersion,
      requestNonceHash
    });
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const mismatchRows = await db.prepare(`
      SELECT id, hwid, request_nonce_hash
      FROM license_events
      WHERE license_user_id = ? AND event_type = 'hwid_mismatch' AND created_at >= ?
    `).all(row.id, since);
    const mismatchEvidence = uniqueSecurityEvents(mismatchRows, 'hwid');
    if (mismatchEvidence.length >= 3) {
      await suspendForSuspiciousUse(row, 'Multiplos HWIDs detectados em 30 minutos.', 100, {
        hwid: payload.hwid,
        ipApprox,
        loaderVersion: payload.loaderVersion,
        metadata: { eventIds: mismatchEvidence.map((event) => event.id) }
      });
      throw httpError('Key suspensa por uso suspeito.', 403, 'SUSPICIOUS_SHARING');
    }
    await db.prepare(`
      UPDATE license_users SET suspicious_score = ?, suspicious_reason = ?, updated_at = ? WHERE id = ?
    `).run(Math.min(99, Number(row.suspicious_score || 0) + 25), 'Tentativa com HWID diferente.', nowIso(), row.id);
    throw httpError('HWID diferente do vinculado.', 403, 'HWID_MISMATCH');
  }

  const now = nowIso();
  if (!row.hwid) {
    const binding = await db.prepare(`
      UPDATE license_users SET hwid = ?, hwid_bound_at = ?, updated_at = ?
      WHERE id = ? AND hwid IS NULL
    `).run(payload.hwid, now, now, row.id);
    if (Number(binding.changes || 0) === 0) {
      const concurrentlyBound = await getLicenseRow(row.id);
      if (concurrentlyBound?.hwid !== payload.hwid) {
        await recordLicenseEvent(row.id, 'hwid_mismatch', {
          hwid: payload.hwid,
          ipApprox,
          loaderVersion: payload.loaderVersion,
          requestNonceHash,
          metadata: { reason: 'concurrent_first_bind' }
        });
        throw httpError('HWID diferente do vinculado.', 403, 'HWID_MISMATCH');
      }
    } else {
      await recordLicenseEvent(row.id, 'hwid_bound', {
        hwid: payload.hwid,
        ipApprox,
        loaderVersion: payload.loaderVersion,
        requestNonceHash
      });
    }
  }

  await recordLicenseEvent(row.id, 'validated', {
    hwid: payload.hwid,
    ipApprox,
    loaderVersion: payload.loaderVersion,
    requestNonceHash
  });
  const ipSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const ipRows = await db.prepare(`
    SELECT id, ip_approx, request_nonce_hash
    FROM license_events
    WHERE license_user_id = ? AND event_type = 'validated' AND created_at >= ?
  `).all(row.id, ipSince);
  const networkEvidence = uniqueSecurityEvents(ipRows, 'ip_approx');
  if (networkEvidence.length >= 6) {
    await suspendForSuspiciousUse(row, 'Muitos enderecos de rede em uma hora.', 100, {
      hwid: payload.hwid,
      ipApprox,
      loaderVersion: payload.loaderVersion,
      metadata: { eventIds: networkEvidence.map((event) => event.id) }
    });
    throw httpError('Key suspensa por uso suspeito.', 403, 'SUSPICIOUS_NETWORK');
  }

  await db.prepare(`
    UPDATE license_users SET
      last_used_at = ?, last_ip_approx = ?, last_loader_version = ?,
      suspicious_score = CASE WHEN suspicious_score > 0 THEN suspicious_score - 1 ELSE 0 END,
      updated_at = ?
    WHERE id = ?
  `).run(now, ipApprox, payload.loaderVersion, now, row.id);
  const fresh = await getLicenseRow(row.id);
  return {
    ok: true,
    code: 'LICENSE_VALID',
    licenseUserId: fresh.id,
    user: {
      discordId: fresh.discord_id,
      username: fresh.discord_username,
      globalName: fresh.discord_global_name,
      avatarUrl: fresh.discord_avatar_url
    },
    license: {
      plan: fresh.plan_name,
      status: fresh.status,
      expiresAt: fresh.expires_at,
      daysRemaining: daysRemaining(fresh.expires_at),
      hwidBound: Boolean(fresh.hwid),
      loaderVersion: payload.loaderVersion
    },
    serverTime: now
  };
}

export async function seedLicensePlans() {
  const now = nowIso();
  const plans = [
    ['lifetime', 'Lifetime', null, 3, 24990],
    ['monthly', 'Mensal', 30, 2, 5990],
    ['weekly', 'Semanal', 7, 1, 2490],
    ['trial', 'Teste', 1, 1, 990]
  ];
  for (const plan of plans) {
    await db.prepare(`
      INSERT INTO license_plans (
        id, name, duration_days, default_hwid_reset_limit, price_cents,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        price_cents = CASE
          WHEN license_plans.price_cents = 0 THEN excluded.price_cents
          ELSE license_plans.price_cents
        END,
        updated_at = excluded.updated_at
    `).run(plan[0], plan[1], plan[2], plan[3], plan[4], now, now);
  }
}

export function registerLicensingRoutes(app, { requireAuth, requireAdmin }) {
  app.get('/api/licenses/plans', requireAuth, requireAdmin, async (_req, res) => {
    const rows = await db.prepare(`
      SELECT lp.*, COUNT(lu.id) AS user_count
      FROM license_plans lp
      LEFT JOIN license_users lu ON lu.plan_id = lp.id
      GROUP BY lp.id, lp.name, lp.duration_days, lp.default_hwid_reset_limit, lp.price_cents,
        lp.active, lp.created_at, lp.updated_at
      ORDER BY CASE WHEN lp.duration_days IS NULL THEN 1 ELSE 0 END, lp.duration_days ASC
    `).all();
    res.json({ plans: rows.map(mapPlan) });
  });

  app.post('/api/licenses/plans', requireAuth, requireAdmin, async (req, res) => {
    const payload = planCreateSchema.parse(req.body);
    const now = nowIso();
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO license_plans (
        id, name, duration_days, default_hwid_reset_limit, price_cents,
        active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      payload.name,
      payload.durationDays ?? null,
      payload.defaultHwidResetLimit,
      payload.priceCents,
      payload.active ? 1 : 0,
      now,
      now
    );
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_plan.created', targetType: 'license_plan', targetId: id, metadata: payload, ip: requestIp(req) });
    res.status(201).json({ plan: mapPlan(await getPlan(id)) });
  });

  app.patch('/api/licenses/plans/:id', requireAuth, requireAdmin, async (req, res) => {
    const payload = planUpdateSchema.parse(req.body);
    const current = await getPlan(req.params.id);
    if (!current) throw httpError('Plano nao encontrado.', 404);
    await db.prepare(`
      UPDATE license_plans SET name = ?, duration_days = ?, default_hwid_reset_limit = ?,
        price_cents = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(
      payload.name ?? current.name,
      Object.hasOwn(payload, 'durationDays') ? payload.durationDays : current.duration_days,
      payload.defaultHwidResetLimit ?? current.default_hwid_reset_limit,
      payload.priceCents ?? current.price_cents,
      payload.active == null ? current.active : payload.active ? 1 : 0,
      nowIso(),
      current.id
    );
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_plan.updated', targetType: 'license_plan', targetId: current.id, metadata: payload, ip: requestIp(req) });
    res.json({ plan: mapPlan(await getPlan(current.id)) });
  });

  app.delete('/api/licenses/plans/:id', requireAuth, requireAdmin, async (req, res) => {
    const usage = await db.prepare('SELECT COUNT(*) AS total FROM license_users WHERE plan_id = ?').get(req.params.id);
    if (Number(usage?.total || 0) > 0) throw httpError('Este plano ainda possui usuarios.', 409);
    await db.prepare('DELETE FROM license_plans WHERE id = ?').run(req.params.id);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_plan.deleted', targetType: 'license_plan', targetId: req.params.id, ip: requestIp(req) });
    res.json({ ok: true });
  });

  app.get('/api/licenses/users', requireAuth, requireAdmin, async (req, res) => {
    await expireLicenses();
    const search = String(req.query.search || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim();
    const planId = String(req.query.planId || '').trim();
    const like = `%${search}%`;
    const exactHash = search ? hashLicenseKey(search) : '';
    const rows = await db.prepare(`
      SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
      FROM license_users lu
      JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE (? = '' OR lu.status = ?)
        AND (? = '' OR lu.plan_id = ?)
        AND (
          ? = ''
          OR LOWER(COALESCE(lu.discord_username, '')) LIKE ?
          OR LOWER(COALESCE(lu.discord_global_name, '')) LIKE ?
          OR LOWER(lu.discord_id) LIKE ?
          OR LOWER(COALESCE(lu.hwid, '')) LIKE ?
          OR LOWER(lu.license_key_preview) LIKE ?
          OR lu.license_key_hash = ?
        )
      ORDER BY lu.created_at DESC
      LIMIT 500
    `).all(status, status, planId, planId, search, like, like, like, like, like, exactHash);
    res.json({ users: rows.map((row) => mapLicenseUser(row)) });
  });

  app.get('/api/licenses/users/:id', requireAuth, requireAdmin, async (req, res) => {
    await expireLicenses();
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    row.events = await db.prepare(`
      SELECT * FROM license_events WHERE license_user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(row.id);
    res.json({ user: mapLicenseUser(row, { includeEvents: true }) });
  });

  app.post('/api/licenses/users', requireAuth, requireAdmin, async (req, res) => {
    const payload = userCreateSchema.parse(req.body);
    const existing = await db.prepare('SELECT id FROM license_users WHERE discord_id = ?').get(payload.discordId);
    if (existing) throw httpError('Este Discord ja possui uma licenca.', 409);
    const plan = await getPlan(payload.planId, { activeOnly: true });
    if (!plan) throw httpError('Plano invalido ou desativado.', 400);
    const profile = await resolveDiscordProfile(payload.discordId);
    const key = generateLicenseKey();
    const id = crypto.randomUUID();
    const now = nowIso();
    const expiresAt = Object.hasOwn(payload, 'expiresAt') ? normalizeExpiresAt(payload.expiresAt) : expirationForPlan(plan);
    const resetLimit = payload.hwidResetLimit ?? Number(plan.default_hwid_reset_limit || 0);
    await db.prepare(`
      INSERT INTO license_users (
        id, discord_id, discord_username, discord_global_name, discord_avatar_url,
        license_key_hash, license_key_encrypted, license_key_preview, plan_id, status,
        expires_at, hwid_reset_limit, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, payload.discordId, profile.username, profile.globalName, profile.avatarUrl,
      hashLicenseKey(key), encryptSecret(key), keyPreview(key), plan.id, payload.status,
      expiresAt, resetLimit, req.user.discordId, now, now
    );
    await recordLicenseEvent(id, 'created', { ipApprox: requestIp(req), metadata: { planId: plan.id } });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.created', targetType: 'license_user', targetId: id, metadata: { discordId: payload.discordId, planId: plan.id }, ip: requestIp(req) });
    res.status(201).json({ user: mapLicenseUser(await getLicenseRow(id), { includeKey: true }) });
  });

  app.patch('/api/licenses/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const payload = userUpdateSchema.parse(req.body);
    const current = await getLicenseRow(req.params.id);
    if (!current) throw httpError('Usuario licenciado nao encontrado.', 404);
    const nextPlan = payload.planId ? await getPlan(payload.planId, { activeOnly: true }) : await getPlan(current.plan_id);
    if (!nextPlan) throw httpError('Plano invalido ou desativado.', 400);
    const nextDiscordId = payload.discordId || current.discord_id;
    const profile = nextDiscordId !== current.discord_id
      ? await resolveDiscordProfile(nextDiscordId)
      : { username: current.discord_username, globalName: current.discord_global_name, avatarUrl: current.discord_avatar_url };
    let nextExpiresAt = current.expires_at;
    if (Object.hasOwn(payload, 'expiresAt')) nextExpiresAt = normalizeExpiresAt(payload.expiresAt);
    else if (payload.planId && payload.planId !== current.plan_id) nextExpiresAt = expirationForPlan(nextPlan);
    let nextStatus = payload.status || current.status;
    if (nextStatus === 'active' && nextExpiresAt && new Date(nextExpiresAt).getTime() <= Date.now()) nextStatus = 'expired';
    await db.prepare(`
      UPDATE license_users SET
        discord_id = ?, discord_username = ?, discord_global_name = ?, discord_avatar_url = ?,
        plan_id = ?, status = ?, expires_at = ?, hwid_reset_limit = ?, updated_at = ?
      WHERE id = ?
    `).run(
      nextDiscordId, profile.username, profile.globalName, profile.avatarUrl,
      nextPlan.id, nextStatus, nextExpiresAt,
      payload.hwidResetLimit ?? current.hwid_reset_limit,
      nowIso(), current.id
    );
    if (
      nextStatus !== 'active'
      || nextDiscordId !== current.discord_id
      || nextPlan.id !== current.plan_id
    ) {
      await invalidateLoaderTicketsForLicense(current.id, `license_${nextStatus}`);
    }
    await recordLicenseEvent(current.id, 'updated', { ipApprox: requestIp(req), metadata: payload });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.updated', targetType: 'license_user', targetId: current.id, metadata: payload, ip: requestIp(req) });
    res.json({ user: mapLicenseUser(await getLicenseRow(current.id)) });
  });

  app.post('/api/licenses/users/:id/reset-hwid', requireAuth, requireAdmin, async (req, res) => {
    const row = await db.transaction(async (tx) => {
      const current = await getLicenseRow(req.params.id, tx);
      if (!current) throw httpError('Usuario licenciado nao encontrado.', 404);
      const timestamp = nowIso();
      const updated = await tx.prepare(`
        UPDATE license_users SET
          hwid = NULL, hwid_bound_at = NULL, hwid_reset_count = hwid_reset_count + 1,
          last_hwid_reset_at = ?, suspicious_score = 0, suspicious_reason = NULL, updated_at = ?
        WHERE id = ? AND hwid_reset_count < hwid_reset_limit
      `).run(timestamp, timestamp, current.id);
      if (Number(updated.changes || 0) !== 1) {
        throw httpError('Limite de resets de HWID atingido. Aumente o limite antes de resetar.', 409, 'HWID_RESET_LIMIT');
      }
      await tx.prepare(`
        UPDATE roblox_name_tags
        SET hwid_hash = NULL, roblox_user_id = NULL, roblox_username = NULL,
          roblox_display_name = NULL, updated_at = ?
        WHERE license_user_id = ?
      `).run(timestamp, current.id);
      await invalidateLoaderTicketsForLicense(current.id, 'hwid_reset', tx);
      await recordLicenseEvent(current.id, 'hwid_reset', {
        ipApprox: requestIp(req),
        metadata: { actorDiscordId: req.user.discordId }
      }, tx);
      return getLicenseRow(current.id, tx);
    });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.hwid_reset', targetType: 'license_user', targetId: row.id, ip: requestIp(req) });
    res.json({ user: mapLicenseUser(row) });
  });

  app.post('/api/licenses/users/:id/regenerate-key', requireAuth, requireAdmin, async (req, res) => {
    const key = generateLicenseKey();
    const row = await db.transaction(async (tx) => {
      const current = await getLicenseRow(req.params.id, tx);
      if (!current) throw httpError('Usuario licenciado nao encontrado.', 404);
      await tx.prepare(`
        UPDATE license_users SET license_key_hash = ?, license_key_encrypted = ?,
          license_key_preview = ?, updated_at = ?
        WHERE id = ?
      `).run(hashLicenseKey(key), encryptSecret(key), keyPreview(key), nowIso(), current.id);
      await invalidateLoaderTicketsForLicense(current.id, 'key_regenerated', tx);
      await recordLicenseEvent(current.id, 'key_regenerated', {
        ipApprox: requestIp(req),
        metadata: { actorDiscordId: req.user.discordId }
      }, tx);
      return getLicenseRow(current.id, tx);
    });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.key_regenerated', targetType: 'license_user', targetId: row.id, ip: requestIp(req) });
    res.json({ user: { ...mapLicenseUser(row), licenseKey: key } });
  });

  app.delete('/api/licenses/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.deleted', targetType: 'license_user', targetId: row.id, metadata: { discordId: row.discord_id }, ip: requestIp(req) });
    await db.prepare('DELETE FROM license_users WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  app.post('/api/licenses/validate', async (req, res) => {
    try {
      const result = await validateLicenseAccess(req.body, requestIp(req));
      const { licenseUserId: _licenseUserId, ...publicResult } = result;
      res.json(publicResult);
    } catch (error) {
      if (error.code && error.status) {
        return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
      }
      throw error;
    }
  });
}
