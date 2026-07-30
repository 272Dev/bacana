import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { consumeSecurityLimit } from './securityLimits.js';
import { sanitizeGlobalChatMessage } from './chatUtils.js';

const chatAuthSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().min(1).max(80).optional().default('nexus-chat')
});

const listSchema = chatAuthSchema.extend({
  limit: z.coerce.number().int().min(1).max(60).optional().default(40)
});

const sendSchema = chatAuthSchema.extend({
  text: z.string().trim().min(1).max(280),
  robloxUserId: z.union([z.string(), z.number()]).optional(),
  robloxUsername: z.string().trim().max(40).optional(),
  robloxDisplayName: z.string().trim().max(60).optional()
});

const MESSAGE_TTL_MS = 60 * 60 * 1000;

function sanitizeIdentity(value, max) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function resolveChatIdentity(licenseUserId, input) {
  const fallback = {
    robloxUserId: sanitizeIdentity(input.robloxUserId, 24).replace(/[^0-9]/g, ''),
    robloxUsername: sanitizeIdentity(input.robloxUsername, 40),
    robloxDisplayName: sanitizeIdentity(input.robloxDisplayName, 60)
  };
  const tag = await db.prepare(`
    SELECT roblox_user_id, roblox_username, roblox_display_name
    FROM roblox_name_tags
    WHERE license_user_id = ?
    LIMIT 1
  `).get(licenseUserId);
  if (!tag?.roblox_user_id) return fallback;
  return {
    robloxUserId: String(tag.roblox_user_id),
    robloxUsername: sanitizeIdentity(tag.roblox_username || fallback.robloxUsername, 40),
    robloxDisplayName: sanitizeIdentity(tag.roblox_display_name || fallback.robloxDisplayName, 60)
  };
}

async function authenticateChat(input, req, scope) {
  const license = await validateLicenseAccess({
    key: input.key,
    hwid: input.hwid,
    loaderVersion: input.loaderVersion
  }, requestLicenseIp(req));
  await consumeSecurityLimit({
    scope,
    subject: license.licenseUserId,
    max: scope === 'global_chat_send' ? 8 : 12,
    windowSeconds: 60
  });
  return license;
}

async function removeExpiredMessages() {
  await db.prepare('DELETE FROM global_chat_messages WHERE expires_at <= ?').run(nowIso());
}

function mapMessage(row) {
  return {
    id: row.id,
    robloxUserId: row.roblox_user_id || null,
    username: row.roblox_username || 'Nexus',
    displayName: row.roblox_display_name || row.roblox_username || 'Nexus',
    text: row.message_text,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

async function listMessages(limit) {
  await removeExpiredMessages();
  const rows = await db.prepare(`
    SELECT id, roblox_user_id, roblox_username, roblox_display_name,
      message_text, created_at, expires_at
    FROM global_chat_messages
    WHERE expires_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(nowIso(), limit);
  return rows.reverse().map(mapMessage);
}

export function registerGlobalChatRoutes(app) {
  app.post('/api/chat/global/list', async (req, res) => {
    try {
      const input = listSchema.parse(req.body || {});
      await authenticateChat(input, req, 'global_chat_read');
      const messages = await listMessages(input.limit);
      return res.json({ ok: true, messages, serverTime: nowIso() });
    } catch (error) {
      const status = Number(error.status) || 500;
      const code = error.code || 'CHAT_UNAVAILABLE';
      return res.status(status).json({ ok: false, code, error: 'Chat global indisponivel no momento.' });
    }
  });

  app.post('/api/chat/global/send', async (req, res) => {
    try {
      const input = sendSchema.parse(req.body || {});
      const license = await authenticateChat(input, req, 'global_chat_send');
      const text = sanitizeGlobalChatMessage(input.text);
      await removeExpiredMessages();

      const existing = await db.prepare(`
        SELECT id, roblox_user_id, roblox_username, roblox_display_name,
          message_text, created_at, expires_at
        FROM global_chat_messages
        WHERE license_user_id = ? AND message_text = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(license.licenseUserId, text, new Date(Date.now() - 12_000).toISOString());
      if (existing) return res.json({ ok: true, message: mapMessage(existing), duplicate: true });

      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + MESSAGE_TTL_MS).toISOString();
      const identity = await resolveChatIdentity(license.licenseUserId, input);
      const robloxUserId = identity.robloxUserId;
      const robloxUsername = identity.robloxUsername;
      const robloxDisplayName = identity.robloxDisplayName;
      const id = crypto.randomUUID();
      await db.prepare(`
        INSERT INTO global_chat_messages (
          id, license_user_id, roblox_user_id, roblox_username,
          roblox_display_name, message_text, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        license.licenseUserId,
        robloxUserId || null,
        robloxUsername || null,
        robloxDisplayName || null,
        text,
        createdAt,
        expiresAt
      );
      const message = {
        id,
        robloxUserId: robloxUserId || null,
        username: robloxUsername || 'Nexus',
        displayName: robloxDisplayName || robloxUsername || 'Nexus',
        text,
        createdAt,
        expiresAt
      };
      return res.status(201).json({ ok: true, message });
    } catch (error) {
      const status = Number(error.status) || 500;
      const code = error.code || 'CHAT_UNAVAILABLE';
      return res.status(status).json({ ok: false, code, error: 'Nao foi possivel enviar a mensagem.' });
    }
  });
}
