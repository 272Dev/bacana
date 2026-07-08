import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

export function logAudit({ actorDiscordId = null, action, targetType = null, targetId = null, metadata = {}, ip = null }) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_discord_id, action, target_type, target_id, ip, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    actorDiscordId,
    action,
    targetType,
    targetId,
    ip,
    JSON.stringify(metadata),
    nowIso()
  );
}

export function writeAccountHistory({ accountId, actorDiscordId, action, metadata = {} }) {
  db.prepare(`
    INSERT INTO account_history (id, account_id, actor_discord_id, action, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    accountId,
    actorDiscordId,
    action,
    JSON.stringify(metadata),
    nowIso()
  );
}
