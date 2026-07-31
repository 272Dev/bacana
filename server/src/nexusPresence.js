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
const PRESENCE_REQUEST_TTL_MS = 90 * 1000;

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

const requestSchema = authSchema.extend({
  targetRobloxUserId: robloxIdSchema
}).strict();

const requestResponseSchema = authSchema.extend({
  requestId: z.string().uuid('Pedido invalido.'),
  decision: z.enum(['accept', 'decline'])
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
  const limits = {
    nexus_presence_list: { max: 12, windowSeconds: 60 },
    nexus_presence_requests: { max: 12, windowSeconds: 60 },
    nexus_presence_request: { max: 4, windowSeconds: 60 },
    nexus_presence_request_response: { max: 8, windowSeconds: 60 }
  };
  const limit = limits[scope] || { max: 6, windowSeconds: 60 };
  await consumeSecurityLimit({
    scope,
    subject: license.licenseUserId,
    max: limit.max,
    windowSeconds: limit.windowSeconds
  });
  return license;
}

async function removeExpiredPresence() {
  const timestamp = nowIso();
  await db.prepare('DELETE FROM nexus_presence_sessions WHERE expires_at <= ?').run(timestamp);
  await db.prepare(`
    UPDATE nexus_presence_requests
    SET status = 'expired', updated_at = ?
    WHERE status = 'pending' AND expires_at <= ?
  `).run(timestamp, timestamp);
  // Requests are deliberately ephemeral.  Keep an accepted/declined state
  // only long enough for the requester to receive the response.
  await db.prepare(`
    DELETE FROM nexus_presence_requests
    WHERE expires_at <= ?
  `).run(new Date(Date.now() - 60_000).toISOString());
}

// Called by the server maintenance loop as well as before reads/writes. This
// keeps the table truly ephemeral even during a quiet period with no clients.
export async function cleanupNexusPresence() {
  await removeExpiredPresence();
}

async function getBoundRobloxIdentity(licenseUserId) {
  const tag = await db.prepare(`
    SELECT roblox_user_id FROM roblox_name_tags WHERE license_user_id = ? LIMIT 1
  `).get(licenseUserId);
  if (!tag?.roblox_user_id) {
    throw presenceError(
      'A conta Roblox desta licenca ainda nao esta vinculada.',
      409,
      'PRESENCE_IDENTITY_MISMATCH'
    );
  }
  return tag;
}

async function assertBoundRobloxIdentity(licenseUserId, robloxUserId) {
  const tag = await getBoundRobloxIdentity(licenseUserId);
  if (String(tag.roblox_user_id) !== String(robloxUserId)) {
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

function mapPresenceRequest(row, viewerLicenseUserId) {
  const incoming = String(row.target_license_user_id) === String(viewerLicenseUserId);
  const requester = {
    robloxUserId: String(row.requester_roblox_user_id),
    username: row.requester_username || null,
    displayName: row.requester_display_name || row.requester_username || 'Nexus User'
  };
  const target = {
    robloxUserId: String(row.target_roblox_user_id),
    username: row.target_username || null,
    displayName: row.target_display_name || row.target_username || 'Nexus User'
  };
  return {
    id: row.id,
    direction: incoming ? 'incoming' : 'outgoing',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    respondedAt: row.responded_at || null,
    requester,
    target
  };
}

const requestSelect = `
  SELECT r.*,
    requester_tag.roblox_username AS requester_username,
    requester_tag.roblox_display_name AS requester_display_name,
    target_tag.roblox_username AS target_username,
    target_tag.roblox_display_name AS target_display_name
  FROM nexus_presence_requests r
  LEFT JOIN roblox_name_tags requester_tag
    ON requester_tag.license_user_id = r.requester_license_user_id
  LEFT JOIN roblox_name_tags target_tag
    ON target_tag.license_user_id = r.target_license_user_id
`;

async function getLiveRequestTarget(targetRobloxUserId) {
  const now = nowIso();
  return db.prepare(`
    SELECT ps.license_user_id, ps.roblox_user_id
    FROM nexus_presence_sessions ps
    JOIN license_users lu ON lu.id = ps.license_user_id
    JOIN roblox_name_tags nt
      ON nt.license_user_id = ps.license_user_id
      AND nt.roblox_user_id = ps.roblox_user_id
    WHERE ps.roblox_user_id = ?
      AND ps.expires_at > ?
      AND lu.status = 'active'
      AND (lu.expires_at IS NULL OR lu.expires_at > ?)
    LIMIT 1
  `).get(String(targetRobloxUserId), now, now);
}

async function getPresenceRequest(requestId) {
  return db.prepare(`${requestSelect} WHERE r.id = ? LIMIT 1`).get(requestId);
}

async function createPresenceRequest({ requesterLicenseUserId, targetRobloxUserId }) {
  const requesterTag = await getBoundRobloxIdentity(requesterLicenseUserId);
  await removeExpiredPresence();
  const requesterPresence = await db.prepare(`
    SELECT id FROM nexus_presence_sessions
    WHERE license_user_id = ? AND roblox_user_id = ? AND expires_at > ?
    LIMIT 1
  `).get(requesterLicenseUserId, String(requesterTag.roblox_user_id), nowIso());
  if (!requesterPresence) {
    throw presenceError('Ative o compartilhamento de sessao antes de enviar um pedido.', 409, 'PRESENCE_REQUESTER_OFFLINE');
  }
  const target = await getLiveRequestTarget(targetRobloxUserId);
  if (!target || String(target.license_user_id) === String(requesterLicenseUserId)) {
    throw presenceError('Usuario indisponivel para pedidos.', 404, 'PRESENCE_REQUEST_UNAVAILABLE');
  }

  const now = nowIso();
  const existing = await db.prepare(`${requestSelect}
    WHERE r.requester_license_user_id = ?
      AND r.target_license_user_id = ?
      AND r.status = 'pending'
      AND r.expires_at > ?
    ORDER BY r.created_at DESC
    LIMIT 1
  `).get(requesterLicenseUserId, target.license_user_id, now);
  if (existing) return mapPresenceRequest(existing, requesterLicenseUserId);

  const requestId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + PRESENCE_REQUEST_TTL_MS).toISOString();
  await db.prepare(`
    INSERT INTO nexus_presence_requests (
      id, requester_license_user_id, requester_roblox_user_id,
      target_license_user_id, target_roblox_user_id,
      status, created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).run(
    requestId,
    requesterLicenseUserId,
    String(requesterTag.roblox_user_id),
    target.license_user_id,
    String(target.roblox_user_id),
    now,
    now,
    expiresAt
  );
  return mapPresenceRequest(await getPresenceRequest(requestId), requesterLicenseUserId);
}

async function listPresenceRequests(licenseUserId) {
  await removeExpiredPresence();
  const now = nowIso();
  const rows = await db.prepare(`${requestSelect}
    WHERE (r.requester_license_user_id = ? OR r.target_license_user_id = ?)
      AND r.expires_at > ?
    ORDER BY r.updated_at DESC
    LIMIT 40
  `).all(licenseUserId, licenseUserId, now);
  return rows.map((row) => mapPresenceRequest(row, licenseUserId));
}

async function respondToPresenceRequest({ licenseUserId, requestId, decision }) {
  await removeExpiredPresence();
  const now = nowIso();
  const status = decision === 'accept' ? 'accepted' : 'declined';
  const updated = await db.prepare(`
    UPDATE nexus_presence_requests
    SET status = ?, updated_at = ?, responded_at = ?
    WHERE id = ?
      AND target_license_user_id = ?
      AND status = 'pending'
      AND expires_at > ?
  `).run(status, now, now, requestId, licenseUserId, now);
  if (Number(updated.changes || 0) !== 1) {
    throw presenceError('Este pedido nao esta mais disponivel.', 404, 'PRESENCE_REQUEST_UNAVAILABLE');
  }
  return mapPresenceRequest(await getPresenceRequest(requestId), licenseUserId);
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

  // A request is delivered only to another active, opt-in Nexus user. It is
  // intentionally a consent signal, not a way to reveal a server identifier
  // or teleport somebody from a client-side script.
  app.post('/api/nexus-presence/request', async (req, res) => {
    try {
      const input = requestSchema.parse(req.body || {});
      const license = await authenticatePresence(input, req, 'nexus_presence_request');
      const request = await createPresenceRequest({
        requesterLicenseUserId: license.licenseUserId,
        targetRobloxUserId: input.targetRobloxUserId
      });
      return res.status(201).json({ ok: true, request });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel enviar o pedido agora.');
    }
  });

  // Clients poll their own requests. The response never includes JobId or a
  // place session token, only the other opt-in user's public name card.
  app.post('/api/nexus-presence/requests', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      const license = await authenticatePresence(input, req, 'nexus_presence_requests');
      return res.json({ ok: true, requests: await listPresenceRequests(license.licenseUserId) });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel atualizar os pedidos agora.');
    }
  });

  app.post('/api/nexus-presence/requests/respond', async (req, res) => {
    try {
      const input = requestResponseSchema.parse(req.body || {});
      const license = await authenticatePresence(input, req, 'nexus_presence_request_response');
      const request = await respondToPresenceRequest({
        licenseUserId: license.licenseUserId,
        requestId: input.requestId,
        decision: input.decision
      });
      return res.json({ ok: true, request });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel responder o pedido agora.');
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
      const timestamp = nowIso();
      await db.prepare(`
        UPDATE nexus_presence_requests
        SET status = 'expired', updated_at = ?
        WHERE status = 'pending'
          AND (requester_license_user_id = ? OR target_license_user_id = ?)
      `).run(timestamp, license.licenseUserId, license.licenseUserId);
      return res.json({ ok: true, hidden: true });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel atualizar a privacidade agora.');
    }
  });
}
