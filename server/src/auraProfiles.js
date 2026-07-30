import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { consumeSecurityLimit } from './securityLimits.js';

// A profile only contains visual choices. It never carries a script, asset file,
// HWID, key or other private license data. Clients render it locally for other
// Nexus users; Roblox players without Nexus are intentionally unaffected.
const AURA_TTL_MS = 24 * 60 * 60 * 1000;
const robloxId = z.union([z.string(), z.number()]).transform((value) => String(value).trim())
  .pipe(z.string().regex(/^\d{1,20}$/));
const visualText = z.string().trim().min(1).max(96).regex(/^[^\u0000-\u001F\u007F]+$/);
const authSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().min(1).max(80).optional().default('nexus-aura-profile')
}).strict();
const publishSchema = authSchema.extend({
  robloxUserId: robloxId,
  style: visualText,
  palette: z.enum(['Original', 'Prata', 'Gelo', 'Violeta', 'Rubi']).default('Original'),
  intensity: z.coerce.number().int().min(10).max(100).default(55),
  glow: z.boolean().default(true)
}).strict();

function auraError(message, status = 400, code = 'AURA_PROFILE_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function isUniqueConstraint(error) {
  return error?.code === '23505' || /unique constraint/i.test(String(error?.message || ''));
}

function mapProfile(row) {
  return {
    robloxUserId: String(row.roblox_user_id),
    style: row.style,
    palette: row.palette,
    intensity: Number(row.intensity || 55),
    glow: Number(row.glow) === 1,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at
  };
}

async function authenticateAura(input, req, scope) {
  const license = await validateLicenseAccess({
    key: input.key,
    hwid: input.hwid,
    loaderVersion: input.loaderVersion
  }, requestLicenseIp(req));
  await consumeSecurityLimit({
    scope,
    subject: license.licenseUserId,
    max: scope === 'aura_profile_list' ? 12 : 8,
    windowSeconds: 60
  });
  return license;
}

async function deactivateExpiredProfiles() {
  const timestamp = nowIso();
  await db.prepare(`
    UPDATE nexus_aura_profiles
    SET active = 0, updated_at = ?
    WHERE active = 1 AND expires_at <= ?
  `).run(timestamp, timestamp);
}

async function publishProfile({ licenseUserId, robloxUserId, style, palette, intensity, glow }) {
  return db.transaction(async (tx) => {
    // The Roblox identity comes from the tag/HWID binding, never only from a
    // client supplied id. This keeps an aura profile tied to its license owner.
    const tag = await tx.prepare(`
      SELECT roblox_user_id FROM roblox_name_tags WHERE license_user_id = ? AND enabled = 1
    `).get(licenseUserId);
    if (!tag?.roblox_user_id || String(tag.roblox_user_id) !== String(robloxUserId)) {
      throw auraError('A conta Roblox desta licenca ainda nao esta vinculada.', 409, 'AURA_IDENTITY_MISMATCH');
    }

    const conflicting = await tx.prepare(`
      SELECT license_user_id FROM nexus_aura_profiles
      WHERE roblox_user_id = ? AND license_user_id <> ?
      LIMIT 1
    `).get(robloxUserId, licenseUserId);
    if (conflicting) {
      throw auraError('Esta conta Roblox ja possui um perfil visual ativo.', 409, 'AURA_IDENTITY_UNAVAILABLE');
    }

    const existing = await tx.prepare(`
      SELECT id FROM nexus_aura_profiles WHERE license_user_id = ?
    `).get(licenseUserId);
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + AURA_TTL_MS).toISOString();
    if (existing) {
      await tx.prepare(`
        UPDATE nexus_aura_profiles
        SET roblox_user_id = ?, style = ?, palette = ?, intensity = ?, glow = ?, active = 1,
          updated_at = ?, expires_at = ?
        WHERE id = ?
      `).run(robloxUserId, style, palette, intensity, glow ? 1 : 0, timestamp, expiresAt, existing.id);
    } else {
      await tx.prepare(`
        INSERT INTO nexus_aura_profiles (
          id, license_user_id, roblox_user_id, style, palette, intensity, glow,
          active, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).run(crypto.randomUUID(), licenseUserId, robloxUserId, style, palette, intensity, glow ? 1 : 0, timestamp, timestamp, expiresAt);
    }
    return {
      roblox_user_id: robloxUserId,
      style,
      palette,
      intensity,
      glow: glow ? 1 : 0,
      updated_at: timestamp,
      expires_at: expiresAt
    };
  });
}

async function listProfiles() {
  await deactivateExpiredProfiles();
  const now = nowIso();
  const rows = await db.prepare(`
    SELECT ap.*
    FROM nexus_aura_profiles ap
    JOIN license_users lu ON lu.id = ap.license_user_id
    JOIN roblox_name_tags nt ON nt.license_user_id = ap.license_user_id
      AND nt.roblox_user_id = ap.roblox_user_id AND nt.enabled = 1
    WHERE ap.active = 1 AND ap.expires_at > ? AND lu.status = 'active'
      AND (lu.expires_at IS NULL OR lu.expires_at > ?)
    ORDER BY ap.updated_at DESC
    LIMIT 500
  `).all(now, now);
  return rows.map(mapProfile);
}

function sendError(res, error, fallbackMessage) {
  const status = Number(error?.status) || (error?.name === 'ZodError' ? 400 : 500);
  return res.status(status).json({
    ok: false,
    code: error?.code || 'AURA_PROFILE_UNAVAILABLE',
    error: fallbackMessage
  });
}

export function registerAuraProfileRoutes(app) {
  app.post('/api/aura-profiles/list', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      await authenticateAura(input, req, 'aura_profile_list');
      return res.json({ ok: true, profiles: await listProfiles(), serverTime: nowIso() });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel sincronizar as auras Nexus.');
    }
  });

  app.post('/api/aura-profiles/publish', async (req, res) => {
    try {
      const input = publishSchema.parse(req.body || {});
      const license = await authenticateAura(input, req, 'aura_profile_publish');
      await deactivateExpiredProfiles();
      const profile = await publishProfile({
        licenseUserId: license.licenseUserId,
        robloxUserId: input.robloxUserId,
        style: input.style,
        palette: input.palette,
        intensity: input.intensity,
        glow: input.glow
      });
      return res.status(201).json({ ok: true, profile: mapProfile(profile) });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return res.status(409).json({ ok: false, code: 'AURA_IDENTITY_UNAVAILABLE', error: 'Nao foi possivel atualizar a aura publicada.' });
      }
      return sendError(res, error, 'Nao foi possivel atualizar a aura publicada.');
    }
  });

  app.post('/api/aura-profiles/remove', async (req, res) => {
    try {
      const input = authSchema.parse(req.body || {});
      const license = await authenticateAura(input, req, 'aura_profile_remove');
      const timestamp = nowIso();
      await db.prepare(`
        UPDATE nexus_aura_profiles
        SET active = 0, updated_at = ?, expires_at = ?
        WHERE license_user_id = ?
      `).run(timestamp, timestamp, license.licenseUserId);
      return res.json({ ok: true });
    } catch (error) {
      return sendError(res, error, 'Nao foi possivel remover a aura publicada.');
    }
  });
}
