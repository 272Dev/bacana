import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { consumeSecurityLimit } from './securityLimits.js';
import {
  isPresenceLive,
  isValidJobId,
  isValidPlaceId,
  isValidRobloxUserId,
  mapPublicPresence
} from './nexusPresencePolicy.js';

// Presence is intentionally opt-in and short lived.  A row represents the
// user's *current* Roblox server only; it is overwritten by the next heartbeat
// and removed immediately when privacy is enabled.  It is never a history or
// a way to discover users who opted out.
const PRESENCE_TTL_MS = 2 * 60 * 1000;

const robloxIdSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().refine(isValidRobloxUserId, 'ID Roblox invalido.'));

const placeIdSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .pipe(z.string().refine(isValidPlaceId, 'PlaceId invalido.'));

// Roblox JobIds are UUIDs in live servers. Keeping the exact UUID shape stops
// this endpoint from becoming arbitrary client-controlled text storage.
const jobIdSchema = z.string().trim()
  .refine(isValidJobId, 'JobId invalido.');

const authSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().min(1).max(80).optional().default('nexus-presence')
}).strict();

const publishSchema = authSchema.extend({
  robloxUserId: robloxIdSchema,
  placeId: placeIdSchema,
  jobId: jobIdSchema
}).strict();

function presenceError(message, status = 400, code = 'PRESENCE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isUniqueConstraint(error) {
  return error?.code === '23505' || /unique constraint/i.test(String(error?.message || ''));
}

export function mapPresence(row) {
  return mapPublicPresence(row);
}

export { isPresenceLive };

export function parsePresencePayload(payload) {
  return publishSchema.parse(payload);
}

async function authenticatePresence(input, req, scope) {
  const license = await validateLicenseAccess({
    key: input.key,
    hwid: input.hwid,
    loaderVersion: input.loaderVersion
  }, requestLicenseIp(req));

  // A client should heartbeat every 45–60 seconds.  This leaves room for a
  // short retry, while preventing the endpoint from being used as a tracker.
  await consumeSecurityLimit({
    scope,
    subject: license.licenseUserId,
    max: scope === 'nexus_presence_list' ? 12 : 6,
    windowSeconds: 60
  });
  return license;
}

async function removeExpiredPresence() {
  await db.prepare('DELETE FROM nexus_presence_sessions WHERE expires_at <= ?').run(nowIso());
}

// Called by the server maintenance loop as well as before reads/writes. This
// keeps the table truly ephemeral even during a quiet period with no clients.
export async function cleanupNexusPresence() {
  await removeExpiredPresence();
}

async function assertBoundRobloxIdentity(licenseUserId, robloxUserId) {
  const tag = await db.prepare(`
    SELECT roblox_user_id FROM roblox_name_tags WHERE license_user_id = ? LIMIT 1
  `).get(licenseUserId);
  if (!tag?.roblox_user_id || String(tag.roblox_user_id) !== String(robloxUserId)) {
    throw presenceError(
      'A conta Roblox desta licenca ainda nao esta vinculada.',
      409,
      'PRESENCE_IDENTITY_MISMATCH'
    );
  }
  return tag;
}

async function publishPresence({ licenseUserId, robloxUserId, placeId, jobId }) {
  await assertBoundRobloxIdentity(licenseUserId, robloxUserId);
  const timestamp = nowIso();
  const expiresAt = new Date(Date.now() + PRESENCE_TTL_MS).toISOString();

  await db.prepare(`
    INSERT INTO nexus_presence_sessions (
      id, license_user_id, roblox_user_id, place_id, job_id,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(license_user_id) DO UPDATE SET
      roblox_user_id = excluded.roblox_user_id,
      place_id = excluded.place_id,
      job_id = excluded.job_id,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at
  `).run(
    crypto.randomUUID(), licenseUserId, robloxUserId, placeId, jobId,
    timestamp, timestamp, expiresAt
  );

  const row = await db.prepare(`
    SELECT ps.roblox_user_id, nt.roblox_username, nt.roblox_display_name, ps.place_id, ps.job_id
    FROM nexus_presence_sessions ps
    JOIN roblox_name_tags nt ON nt.license_user_id = ps.license_user_id
    WHERE ps.license_user_id = ?
  `).get(licenseUserId);
  if (!row) {
    throw presenceError('Nao foi possivel confirmar a presenca agora.', 409, 'PRESENCE_IDENTITY_UNAVAILABLE');
  }
  return mapPresence(row);
}

async function listPresence() {
  await removeExpiredPresence();
  const now = nowIso();
  const rows = await db.prepare(`
    SELECT ps.roblox_user_id, nt.roblox_username, nt.roblox_display_name, ps.place_id, ps.job_id
    FROM nexus_presence_sessions ps
    JOIN license_users lu ON lu.id = ps.license_user_id
    JOIN roblox_name_tags nt ON nt.license_user_id = ps.license_user_id
      AND nt.roblox_user_id = ps.roblox_user_id
    WHERE ps.expires_at > ? AND lu.status = 'active'
      AND (lu.expires_at IS NULL OR lu.expires_at > ?)
    ORDER BY ps.updated_at DESC
    LIMIT 250
  `).all(now, now);
  return rows.map(mapPresence);
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) || (error?.name === 'ZodError' ? 400 : 500);
  return res.status(status).json({
    ok: false,
    code: error?.code || 'PRESENCE_UNAVAILABLE',
    error: fallback
  });
}

export function registerNexusPresenceRoutes(app) {
  // Authenticated Nexus clients may read only opt-in, live presence records.
  app.post('/api/nexus-presence/list', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      await authenticatePresence(input, req, 'nexus_presence_list');
      return res.json({ ok: true, users: await listPresence(), serverTime: nowIso() });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel listar usuarios Nexus agora.');
    }
  });

  // Calling publish is an explicit opt-in.  It stores only the current server
  // and replaces any previous location for this license.
  app.post('/api/nexus-presence/publish', async (req, res) => {
    try {
      const input = parsePresencePayload(req.body || {});
      const license = await authenticatePresence(input, req, 'nexus_presence_publish');
      await removeExpiredPresence();
      const presence = await publishPresence({
        licenseUserId: license.licenseUserId,
        robloxUserId: input.robloxUserId,
        placeId: input.placeId,
        jobId: input.jobId
      });
      return res.status(201).json({ ok: true, presence, expiresInSeconds: PRESENCE_TTL_MS / 1000 });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return res.status(409).json({
          ok: false,
          code: 'PRESENCE_IDENTITY_UNAVAILABLE',
          error: 'Nao foi possivel publicar a presenca agora.'
        });
      }
      return sendError(res, error, 'Nao foi possivel publicar a presenca agora.');
    }
  });

  // Privacy is a delete, not an "inactive" record.  The server keeps no
  // location to reveal later and there is no endpoint for querying hidden users.
  app.post('/api/nexus-presence/hide', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      const license = await authenticatePresence(input, req, 'nexus_presence_hide');
      await db.prepare('DELETE FROM nexus_presence_sessions WHERE license_user_id = ?')
        .run(license.licenseUserId);
      return res.json({ ok: true, hidden: true });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel atualizar a privacidade agora.');
    }
  });
}
