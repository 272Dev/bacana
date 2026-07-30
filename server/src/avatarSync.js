import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { consumeSecurityLimit } from './securityLimits.js';

const AVATAR_TTL_MS = 24 * 60 * 60 * 1000;

const authSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().min(1).max(80).optional().default('nexus-avatar-sync')
}).strict();

const publishSchema = authSchema.extend({
  robloxUserId: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).pipe(
    z.string().regex(/^\d{1,20}$/)
  ),
  spoofedRobloxUserId: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).pipe(
    z.string().regex(/^\d{1,20}$/)
  )
}).strict();

function avatarError(message, status = 400, code = 'AVATAR_SYNC_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isUniqueConstraint(error) {
  return error?.code === '23505' || /unique constraint/i.test(String(error?.message || ''));
}

function mapAvatarEntry(row) {
  return {
    robloxUserId: row.roblox_user_id,
    spoofedRobloxUserId: row.spoofed_roblox_user_id,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

async function authenticateAvatarSync(input, req, scope) {
  const license = await validateLicenseAccess({
    key: input.key,
    hwid: input.hwid,
    loaderVersion: input.loaderVersion
  }, requestLicenseIp(req));
  await consumeSecurityLimit({
    scope,
    subject: license.licenseUserId,
    max: scope === 'avatar_sync_list' ? 12 : 8,
    windowSeconds: 60
  });
  return license;
}

async function deactivateExpiredEntries() {
  await db.prepare(`
    UPDATE avatar_sync_entries
    SET active = 0, updated_at = ?
    WHERE active = 1 AND expires_at <= ?
  `).run(nowIso(), nowIso());
}

async function publishAvatar({ licenseUserId, robloxUserId, spoofedRobloxUserId }) {
  return db.transaction(async (tx) => {
    const existing = await tx.prepare(`
      SELECT * FROM avatar_sync_entries WHERE license_user_id = ?
    `).get(licenseUserId);
    if (existing && existing.roblox_user_id !== robloxUserId) {
      throw avatarError('A identidade Roblox desta licenca nao pode ser alterada aqui.', 409, 'AVATAR_IDENTITY_MISMATCH');
    }

    const tag = await tx.prepare(`
      SELECT roblox_user_id FROM roblox_name_tags WHERE license_user_id = ?
    `).get(licenseUserId);
    if (tag?.roblox_user_id && tag.roblox_user_id !== robloxUserId) {
      throw avatarError('A conta Roblox nao corresponde a esta licenca.', 409, 'AVATAR_IDENTITY_MISMATCH');
    }

    const conflicting = await tx.prepare(`
      SELECT license_user_id FROM avatar_sync_entries
      WHERE roblox_user_id = ? AND license_user_id <> ?
      LIMIT 1
    `).get(robloxUserId, licenseUserId);
    if (conflicting) {
      throw avatarError('Esta conta Roblox ja esta vinculada.', 409, 'AVATAR_IDENTITY_UNAVAILABLE');
    }

    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + AVATAR_TTL_MS).toISOString();
    if (existing) {
      await tx.prepare(`
        UPDATE avatar_sync_entries
        SET spoofed_roblox_user_id = ?, active = 1, updated_at = ?, expires_at = ?
        WHERE id = ?
      `).run(spoofedRobloxUserId, timestamp, expiresAt, existing.id);
      return {
        roblox_user_id: robloxUserId,
        spoofed_roblox_user_id: spoofedRobloxUserId,
        updated_at: timestamp,
        expires_at: expiresAt
      };
    }

    const id = crypto.randomUUID();
    await tx.prepare(`
      INSERT INTO avatar_sync_entries (
        id, license_user_id, roblox_user_id, spoofed_roblox_user_id,
        active, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, licenseUserId, robloxUserId, spoofedRobloxUserId, timestamp, timestamp, expiresAt);
    return {
      roblox_user_id: robloxUserId,
      spoofed_roblox_user_id: spoofedRobloxUserId,
      updated_at: timestamp,
      expires_at: expiresAt
    };
  });
}

async function listAvatars() {
  await deactivateExpiredEntries();
  const now = nowIso();
  const rows = await db.prepare(`
    SELECT ase.roblox_user_id, ase.spoofed_roblox_user_id, ase.updated_at, ase.expires_at
    FROM avatar_sync_entries ase
    JOIN license_users lu ON lu.id = ase.license_user_id
    WHERE ase.active = 1 AND ase.expires_at > ?
      AND lu.status = 'active'
      AND (lu.expires_at IS NULL OR lu.expires_at > ?)
    ORDER BY ase.updated_at DESC
    LIMIT 500
  `).all(now, now);
  return rows.map(mapAvatarEntry);
}

function sendError(res, error, fallbackMessage) {
  const status = Number(error?.status) || (error?.name === 'ZodError' ? 400 : 500);
  const code = error?.code || 'AVATAR_SYNC_UNAVAILABLE';
  return res.status(status).json({
    ok: false,
    code,
    error: fallbackMessage
  });
}

export function registerAvatarSyncRoutes(app) {
  app.post('/api/avatar-sync/list', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      await authenticateAvatarSync(input, req, 'avatar_sync_list');
      const avatars = await listAvatars();
      return res.json({ ok: true, avatars, serverTime: nowIso() });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel sincronizar os avatares.');
    }
  });

  app.post('/api/avatar-sync/publish', async (req, res) => {
    try {
      const input = publishSchema.parse(req.body || {});
      const license = await authenticateAvatarSync(input, req, 'avatar_sync_publish');
      await deactivateExpiredEntries();
      const avatar = await publishAvatar({
        licenseUserId: license.licenseUserId,
        robloxUserId: input.robloxUserId,
        spoofedRobloxUserId: input.spoofedRobloxUserId
      });
      return res.status(201).json({ ok: true, avatar: mapAvatarEntry(avatar) });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return res.status(409).json({
          ok: false,
          code: 'AVATAR_IDENTITY_UNAVAILABLE',
          error: 'Nao foi possivel atualizar o avatar sincronizado.'
        });
      }
      return sendError(res, error, 'Nao foi possivel atualizar o avatar sincronizado.');
    }
  });

  app.post('/api/avatar-sync/remove', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      const license = await authenticateAvatarSync(input, req, 'avatar_sync_remove');
      const timestamp = nowIso();
      await db.prepare(`
        UPDATE avatar_sync_entries
        SET active = 0, updated_at = ?, expires_at = ?
        WHERE license_user_id = ?
      `).run(timestamp, timestamp, license.licenseUserId);
      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel remover o avatar sincronizado.');
    }
  });
}
