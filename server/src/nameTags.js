import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { logAudit } from './audit.js';
import { requestLicenseIp } from './licensing.js';

const licenseIdSchema = z.string().uuid('Usuario licenciado invalido.');
const robloxIdSchema = z.string().trim().regex(/^\d{1,20}$/);
const optionalText = (max) => z.string().trim().max(max).optional().nullable().or(z.literal(''));

const tagSchema = z.object({
  displayNameOverride: optionalText(32),
  title: z.string().trim().min(1).max(32).default('Nexus Member'),
  icon: z.enum(['initial', 'diamond', 'shield', 'star', 'dot']).default('initial'),
  badge: z.enum(['none', 'verified', 'admin', 'premium']).default('none'),
  morphDistance: z.coerce.number().int().min(15).max(120).default(52),
  maxDistance: z.coerce.number().int().min(40).max(300).default(160),
  enabled: z.boolean().default(true)
});

function clean(value) {
  const text = String(value || '').trim();
  return text || null;
}

function hashHwid(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function maskHwid(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 12) return `${text.slice(0, 3)}...${text.slice(-3)}`;
  return `${text.slice(0, 7)}...${text.slice(-5)}`;
}

function mapPublicTag(row) {
  if (!row?.roblox_user_id || Number(row.enabled) !== 1) return null;
  return {
    robloxUserId: row.roblox_user_id,
    displayName: row.display_name_override || null,
    title: row.title,
    icon: row.icon,
    badge: row.badge,
    morphDistance: Number(row.morph_distance || 52),
    maxDistance: Number(row.max_distance || 160)
  };
}

function mapSessionTag(row) {
  if (!row) return null;
  return {
    enabled: Number(row.enabled) === 1,
    displayName: row.display_name_override || null,
    title: row.title,
    icon: row.icon,
    badge: row.badge,
    morphDistance: Number(row.morph_distance || 52),
    maxDistance: Number(row.max_distance || 160)
  };
}

function mapAdminTag(row) {
  return {
    id: row.id,
    licenseUserId: row.license_user_id,
    hwidBound: Boolean(row.hwid),
    hwidPreview: maskHwid(row.hwid),
    robloxUserId: row.roblox_user_id,
    robloxUsername: row.roblox_username,
    robloxDisplayName: row.roblox_display_name,
    displayNameOverride: row.display_name_override,
    title: row.title,
    icon: row.icon,
    badge: row.badge,
    morphDistance: Number(row.morph_distance || 52),
    maxDistance: Number(row.max_distance || 160),
    enabled: Number(row.enabled) === 1,
    discordId: row.discord_id || null,
    discordUsername: row.discord_username || null,
    discordGlobalName: row.discord_global_name || null,
    discordAvatarUrl: row.discord_avatar_url || null,
    planName: row.plan_name || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const adminSelect = `
  SELECT nt.*, lu.discord_id, lu.discord_username, lu.discord_global_name,
    lu.discord_avatar_url, lu.hwid, lp.name AS plan_name
  FROM roblox_name_tags nt
  JOIN license_users lu ON lu.id = nt.license_user_id
  JOIN license_plans lp ON lp.id = lu.plan_id
`;

async function getAdminTagByLicense(licenseUserId) {
  return db.prepare(`${adminSelect} WHERE nt.license_user_id = ?`).get(licenseUserId);
}

export async function getNameTagForLicense(licenseUserId) {
  const row = await db.prepare('SELECT * FROM roblox_name_tags WHERE license_user_id = ?').get(licenseUserId);
  return mapSessionTag(row);
}

export async function ensureNameTagForSession(licenseUserId, input) {
  const parsedId = robloxIdSchema.safeParse(String(input.robloxUserId || ''));
  if (!parsedId.success || !input.hwid) return getNameTagForLicense(licenseUserId);

  const robloxUserId = parsedId.data;
  const hwidHash = hashHwid(input.hwid);
  const timestamp = nowIso();
  let row = await db.prepare('SELECT * FROM roblox_name_tags WHERE license_user_id = ?').get(licenseUserId);

  if (!row) {
    const license = await db.prepare(`
      SELECT lp.name AS plan_name
      FROM license_users lu JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.id = ?
    `).get(licenseUserId);
    row = {
      id: crypto.randomUUID(),
      license_user_id: licenseUserId,
      hwid_hash: hwidHash,
      roblox_user_id: robloxUserId,
      roblox_username: clean(input.robloxUsername),
      roblox_display_name: clean(input.robloxDisplayName),
      display_name_override: null,
      title: license?.plan_name ? `Nexus ${String(license.plan_name).slice(0, 24)}` : 'Nexus Member',
      icon: 'initial',
      badge: 'none',
      morph_distance: 52,
      max_distance: 160,
      enabled: 1
    };
    await db.prepare(`
      INSERT INTO roblox_name_tags (
        id, license_user_id, hwid_hash, roblox_user_id, roblox_username,
        roblox_display_name, display_name_override, title, icon, badge,
        morph_distance, max_distance, enabled, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'loader', ?, ?)
    `).run(
      row.id, row.license_user_id, row.hwid_hash, row.roblox_user_id,
      row.roblox_username, row.roblox_display_name, row.display_name_override,
      row.title, row.icon, row.badge, row.morph_distance, row.max_distance,
      timestamp, timestamp
    );
    return mapSessionTag(row);
  }

  // A licenca ja foi validada antes daqui. Assim, somente o HWID autorizado
  // consegue atualizar a associacao publica Roblox -> aparencia da tag.
  const conflicting = await db.prepare(`
    SELECT id FROM roblox_name_tags
    WHERE roblox_user_id = ? AND license_user_id <> ?
  `).get(robloxUserId, licenseUserId);
  if (conflicting) {
    await db.prepare('UPDATE roblox_name_tags SET roblox_user_id = NULL, updated_at = ? WHERE id = ?').run(timestamp, conflicting.id);
  }
  await db.prepare(`
    UPDATE roblox_name_tags SET
      hwid_hash = ?, roblox_user_id = ?, roblox_username = ?,
      roblox_display_name = ?, updated_at = ?
    WHERE id = ?
  `).run(
    hwidHash, robloxUserId, clean(input.robloxUsername),
    clean(input.robloxDisplayName), timestamp, row.id
  );
  return mapSessionTag({
    ...row,
    hwid_hash: hwidHash,
    roblox_user_id: robloxUserId,
    roblox_username: clean(input.robloxUsername),
    roblox_display_name: clean(input.robloxDisplayName)
  });
}

export function registerNameTagRoutes(app, { requireAuth, requireAdmin }) {
  app.get('/api/name-tags/public', async (_req, res) => {
    const rows = await db.prepare(`
      SELECT nt.* FROM roblox_name_tags nt
      JOIN license_users lu ON lu.id = nt.license_user_id
      WHERE nt.enabled = 1 AND nt.roblox_user_id IS NOT NULL AND lu.status = 'active'
        AND (lu.expires_at IS NULL OR lu.expires_at > ?)
      ORDER BY nt.updated_at DESC
      LIMIT 5000
    `).all(nowIso());
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');
    res.json({ tags: rows.map(mapPublicTag).filter(Boolean), updatedAt: nowIso() });
  });

  app.get('/api/name-tags', requireAuth, requireAdmin, async (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const like = `%${search}%`;
    const rows = await db.prepare(`
      ${adminSelect}
      WHERE (? = '' OR LOWER(COALESCE(nt.roblox_username, '')) LIKE ?
        OR LOWER(COALESCE(nt.roblox_display_name, '')) LIKE ?
        OR LOWER(COALESCE(nt.display_name_override, '')) LIKE ?
        OR LOWER(nt.title) LIKE ? OR COALESCE(nt.roblox_user_id, '') LIKE ?
        OR LOWER(COALESCE(lu.discord_username, '')) LIKE ? OR lu.discord_id LIKE ?
        OR LOWER(COALESCE(lu.hwid, '')) LIKE ?)
      ORDER BY nt.updated_at DESC
      LIMIT 500
    `).all(search, like, like, like, like, like, like, like, like);
    res.json({ tags: rows.map(mapAdminTag) });
  });

  app.put('/api/name-tags/license/:licenseUserId', requireAuth, requireAdmin, async (req, res) => {
    const licenseUserId = licenseIdSchema.parse(req.params.licenseUserId);
    const payload = tagSchema.parse(req.body);
    if (payload.maxDistance < payload.morphDistance + 10) {
      return res.status(400).json({ error: 'A distancia maxima precisa superar a distancia de abertura em pelo menos 10 studs.' });
    }
    const license = await db.prepare(`
      SELECT lu.*, lp.name AS plan_name
      FROM license_users lu JOIN license_plans lp ON lp.id = lu.plan_id
      WHERE lu.id = ?
    `).get(licenseUserId);
    if (!license) return res.status(404).json({ error: 'Usuario licenciado nao encontrado.' });

    const timestamp = nowIso();
    const existing = await db.prepare('SELECT * FROM roblox_name_tags WHERE license_user_id = ?').get(licenseUserId);
    if (existing) {
      await db.prepare(`
        UPDATE roblox_name_tags SET
          hwid_hash = ?, display_name_override = ?, title = ?, icon = ?, badge = ?,
          morph_distance = ?, max_distance = ?, enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        license.hwid ? hashHwid(license.hwid) : null, clean(payload.displayNameOverride),
        payload.title, payload.icon, payload.badge, payload.morphDistance,
        payload.maxDistance, payload.enabled ? 1 : 0, timestamp, existing.id
      );
    } else {
      await db.prepare(`
        INSERT INTO roblox_name_tags (
          id, license_user_id, hwid_hash, roblox_user_id, roblox_username,
          roblox_display_name, display_name_override, title, icon, badge,
          morph_distance, max_distance, enabled, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), licenseUserId, license.hwid ? hashHwid(license.hwid) : null,
        clean(payload.displayNameOverride), payload.title, payload.icon, payload.badge,
        payload.morphDistance, payload.maxDistance, payload.enabled ? 1 : 0,
        req.user.discordId, timestamp, timestamp
      );
    }
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: existing ? 'roblox_name_tag.updated' : 'roblox_name_tag.created',
      targetType: 'roblox_name_tag',
      targetId: licenseUserId,
      metadata: { title: payload.title, icon: payload.icon, badge: payload.badge, enabled: payload.enabled },
      ip: requestLicenseIp(req)
    });
    res.json({ tag: mapAdminTag(await getAdminTagByLicense(licenseUserId)) });
  });

  app.delete('/api/name-tags/license/:licenseUserId', requireAuth, requireAdmin, async (req, res) => {
    const licenseUserId = licenseIdSchema.parse(req.params.licenseUserId);
    const existing = await db.prepare('SELECT id FROM roblox_name_tags WHERE license_user_id = ?').get(licenseUserId);
    if (!existing) return res.status(404).json({ error: 'Tag de HWID nao encontrada.' });
    await db.prepare('UPDATE roblox_name_tags SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), existing.id);
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'roblox_name_tag.disabled',
      targetType: 'roblox_name_tag',
      targetId: licenseUserId,
      ip: requestLicenseIp(req)
    });
    res.json({ ok: true });
  });
}
