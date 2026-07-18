import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { lookupDiscordUser } from './discordTools.js';
import { logAudit } from './audit.js';

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
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().max(80).optional().default('unknown')
});

function httpError(message, status = 400, code = 'LICENSE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase();
}

function hashKey(value) {
  return crypto.createHash('sha256').update(normalizeKey(value)).digest('hex');
}

function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let body = '';
  for (let index = 0; index < 20; index += 1) {
    body += alphabet[bytes[index] % alphabet.length];
  }
  return `NXS-${body.match(/.{1,5}/g).join('-')}`;
}

function keyPreview(key) {
  const normalized = normalizeKey(key);
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

function requestIp(req) {
  return cleanIp(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip);
}

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
    active: Number(row.active) === 1,
    userCount: Number(row.user_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLicenseUser(row, { includeKey = false, includeEvents = false } = {}) {
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
  if (includeKey) result.licenseKey = revealStoredKey(row);
  if (includeEvents) {
    result.events = (row.events || []).map((event) => ({
      id: event.id,
      type: event.event_type,
      hwid: event.hwid,
      ipApprox: event.ip_approx,
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

async function getLicenseRow(userId) {
  return db.prepare(`
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

async function recordLicenseEvent(userId, type, { hwid, ipApprox, loaderVersion, metadata = {} } = {}) {
  await db.prepare(`
    INSERT INTO license_events (
      id, license_user_id, event_type, hwid, ip_approx, loader_version, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    userId,
    type,
    hwid || null,
    ipApprox || null,
    loaderVersion || null,
    JSON.stringify(metadata),
    nowIso()
  );
}

async function expireLicenses() {
  await db.prepare(`
    UPDATE license_users
    SET status = 'expired', updated_at = ?
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
  `).run(nowIso(), nowIso());
}

async function suspendForSuspiciousUse(row, reason, score, context) {
  const nextScore = Math.max(Number(row.suspicious_score || 0), score);
  await db.prepare(`
    UPDATE license_users
    SET status = 'suspended', suspicious_score = ?, suspicious_reason = ?, updated_at = ?
    WHERE id = ?
  `).run(nextScore, reason, nowIso(), row.id);
  await recordLicenseEvent(row.id, 'auto_suspended', { ...context, metadata: { reason, score: nextScore } });
}

export async function seedLicensePlans() {
  const now = nowIso();
  const plans = [
    ['lifetime', 'Lifetime', null, 3],
    ['monthly', 'Mensal', 30, 2],
    ['weekly', 'Semanal', 7, 1],
    ['trial', 'Teste', 1, 1]
  ];
  for (const plan of plans) {
    await db.prepare(`
      INSERT INTO license_plans (
        id, name, duration_days, default_hwid_reset_limit, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(plan[0], plan[1], plan[2], plan[3], now, now);
  }
}

export function registerLicensingRoutes(app, { requireAuth, requireAdmin }) {
  app.get('/api/licenses/plans', requireAuth, requireAdmin, async (_req, res) => {
    const rows = await db.prepare(`
      SELECT lp.*, COUNT(lu.id) AS user_count
      FROM license_plans lp
      LEFT JOIN license_users lu ON lu.plan_id = lp.id
      GROUP BY lp.id, lp.name, lp.duration_days, lp.default_hwid_reset_limit, lp.active, lp.created_at, lp.updated_at
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
        id, name, duration_days, default_hwid_reset_limit, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, payload.name, payload.durationDays ?? null, payload.defaultHwidResetLimit, payload.active ? 1 : 0, now, now);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_plan.created', targetType: 'license_plan', targetId: id, metadata: payload, ip: requestIp(req) });
    res.status(201).json({ plan: mapPlan(await getPlan(id)) });
  });

  app.patch('/api/licenses/plans/:id', requireAuth, requireAdmin, async (req, res) => {
    const payload = planUpdateSchema.parse(req.body);
    const current = await getPlan(req.params.id);
    if (!current) throw httpError('Plano nao encontrado.', 404);
    await db.prepare(`
      UPDATE license_plans SET name = ?, duration_days = ?, default_hwid_reset_limit = ?, active = ?, updated_at = ?
      WHERE id = ?
    `).run(
      payload.name ?? current.name,
      Object.hasOwn(payload, 'durationDays') ? payload.durationDays : current.duration_days,
      payload.defaultHwidResetLimit ?? current.default_hwid_reset_limit,
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
    const exactHash = search ? hashKey(search) : '';
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
    res.json({ users: rows.map((row) => mapLicenseUser(row, { includeKey: true })) });
  });

  app.get('/api/licenses/users/:id', requireAuth, requireAdmin, async (req, res) => {
    await expireLicenses();
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    row.events = await db.prepare(`
      SELECT * FROM license_events WHERE license_user_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(row.id);
    res.json({ user: mapLicenseUser(row, { includeKey: true, includeEvents: true }) });
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
      hashKey(key), encryptSecret(key), keyPreview(key), plan.id, payload.status,
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
    await recordLicenseEvent(current.id, 'updated', { ipApprox: requestIp(req), metadata: payload });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.updated', targetType: 'license_user', targetId: current.id, metadata: payload, ip: requestIp(req) });
    res.json({ user: mapLicenseUser(await getLicenseRow(current.id), { includeKey: true }) });
  });

  app.post('/api/licenses/users/:id/reset-hwid', requireAuth, requireAdmin, async (req, res) => {
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    if (Number(row.hwid_reset_count || 0) >= Number(row.hwid_reset_limit || 0)) {
      throw httpError('Limite de resets de HWID atingido. Aumente o limite antes de resetar.', 409, 'HWID_RESET_LIMIT');
    }
    const now = nowIso();
    await db.prepare(`
      UPDATE license_users SET
        hwid = NULL, hwid_bound_at = NULL, hwid_reset_count = hwid_reset_count + 1,
        last_hwid_reset_at = ?, suspicious_score = 0, suspicious_reason = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, row.id);
    await recordLicenseEvent(row.id, 'hwid_reset', { ipApprox: requestIp(req), metadata: { actorDiscordId: req.user.discordId } });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.hwid_reset', targetType: 'license_user', targetId: row.id, ip: requestIp(req) });
    res.json({ user: mapLicenseUser(await getLicenseRow(row.id), { includeKey: true }) });
  });

  app.post('/api/licenses/users/:id/regenerate-key', requireAuth, requireAdmin, async (req, res) => {
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    const key = generateLicenseKey();
    await db.prepare(`
      UPDATE license_users SET license_key_hash = ?, license_key_encrypted = ?, license_key_preview = ?, updated_at = ?
      WHERE id = ?
    `).run(hashKey(key), encryptSecret(key), keyPreview(key), nowIso(), row.id);
    await recordLicenseEvent(row.id, 'key_regenerated', { ipApprox: requestIp(req), metadata: { actorDiscordId: req.user.discordId } });
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.key_regenerated', targetType: 'license_user', targetId: row.id, ip: requestIp(req) });
    res.json({ user: mapLicenseUser(await getLicenseRow(row.id), { includeKey: true }) });
  });

  app.delete('/api/licenses/users/:id', requireAuth, requireAdmin, async (req, res) => {
    const row = await getLicenseRow(req.params.id);
    if (!row) throw httpError('Usuario licenciado nao encontrado.', 404);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'license_user.deleted', targetType: 'license_user', targetId: row.id, metadata: { discordId: row.discord_id }, ip: requestIp(req) });
    await db.prepare('DELETE FROM license_users WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  app.post('/api/licenses/validate', async (req, res) => {
    const payload = validateSchema.parse(req.body);
    const ipApprox = requestIp(req);
    const row = await db.prepare(`
      SELECT lu.*, lp.name AS plan_name, lp.duration_days AS plan_duration_days
      FROM license_users lu
      JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.license_key_hash = ?
    `).get(hashKey(payload.key));
    if (!row) return res.status(401).json({ ok: false, code: 'INVALID_KEY', error: 'Key invalida.' });

    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      await db.prepare(`UPDATE license_users SET status = 'expired', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
      await recordLicenseEvent(row.id, 'expired_rejected', { hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion });
      return res.status(403).json({ ok: false, code: 'LICENSE_EXPIRED', error: 'Licenca expirada.' });
    }
    if (row.status !== 'active') {
      await recordLicenseEvent(row.id, 'status_rejected', { hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion, metadata: { status: row.status } });
      return res.status(403).json({ ok: false, code: `LICENSE_${row.status.toUpperCase()}`, error: 'Licenca indisponivel.' });
    }

    if (row.hwid && row.hwid !== payload.hwid) {
      await recordLicenseEvent(row.id, 'hwid_mismatch', { hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion });
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const mismatches = await db.prepare(`
        SELECT COUNT(DISTINCT hwid) AS total
        FROM license_events
        WHERE license_user_id = ? AND event_type = 'hwid_mismatch' AND created_at >= ?
      `).get(row.id, since);
      const mismatchCount = Number(mismatches?.total || 0);
      if (mismatchCount >= 3) {
        await suspendForSuspiciousUse(row, 'Multiplos HWIDs detectados em 30 minutos.', 100, {
          hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion
        });
        return res.status(403).json({ ok: false, code: 'SUSPICIOUS_SHARING', error: 'Key suspensa por uso suspeito.' });
      }
      await db.prepare(`
        UPDATE license_users SET suspicious_score = ?, suspicious_reason = ?, updated_at = ? WHERE id = ?
      `).run(Math.min(99, Number(row.suspicious_score || 0) + 25), 'Tentativa com HWID diferente.', nowIso(), row.id);
      return res.status(403).json({ ok: false, code: 'HWID_MISMATCH', error: 'HWID diferente do vinculado.' });
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
            metadata: { reason: 'concurrent_first_bind' }
          });
          return res.status(403).json({ ok: false, code: 'HWID_MISMATCH', error: 'HWID diferente do vinculado.' });
        }
      } else {
        row.hwid = payload.hwid;
        row.hwid_bound_at = now;
        await recordLicenseEvent(row.id, 'hwid_bound', { hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion });
      }
    }

    await recordLicenseEvent(row.id, 'validated', { hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion });
    const ipSince = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const distinctIps = await db.prepare(`
      SELECT COUNT(DISTINCT ip_approx) AS total
      FROM license_events
      WHERE license_user_id = ? AND event_type = 'validated' AND created_at >= ?
    `).get(row.id, ipSince);
    if (Number(distinctIps?.total || 0) >= 6) {
      await suspendForSuspiciousUse(row, 'Muitos enderecos de rede em uma hora.', 100, {
        hwid: payload.hwid, ipApprox, loaderVersion: payload.loaderVersion
      });
      return res.status(403).json({ ok: false, code: 'SUSPICIOUS_NETWORK', error: 'Key suspensa por uso suspeito.' });
    }

    await db.prepare(`
      UPDATE license_users SET
        last_used_at = ?, last_ip_approx = ?, last_loader_version = ?,
        suspicious_score = CASE WHEN suspicious_score > 0 THEN suspicious_score - 1 ELSE 0 END,
        updated_at = ?
      WHERE id = ?
    `).run(now, ipApprox, payload.loaderVersion, now, row.id);
    const fresh = await getLicenseRow(row.id);
    res.json({
      ok: true,
      code: 'LICENSE_VALID',
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
    });
  });
}
