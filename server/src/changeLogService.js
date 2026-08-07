import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { logAudit } from './audit.js';
import { db, nowIso } from './db.js';
export { formatChangeLogDate, formatChangeLogText } from './changeLogFormat.js';

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const noControlCharacters = (value) => !/[\u0000-\u001F\u007F]/.test(String(value || ''));

function makeChangeLogError(message, status = 400, code = 'CHANGELOG_INVALID') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseChanges(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map((item) => String(item || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanError(error) {
  return String(error?.message || 'Falha ao enviar o changelog.').replace(/[\r\n]+/g, ' ').slice(0, 800);
}

function cleanLimit(value, fallback = 10) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(20, Math.floor(numeric)));
}

export const changeLogContentSchema = z.object({
  title: z.string().trim().min(2).max(96).refine(noControlCharacters, 'Titulo invalido.').default('Nexus Update'),
  changes: z.array(
    z.string().trim().min(1).max(240).refine(noControlCharacters, 'Alteracao invalida.')
  ).min(1).max(12)
}).strict();

export const changeLogPublishSchema = changeLogContentSchema.extend({
  version: z.string().trim().regex(VERSION_PATTERN, 'Versao invalida.'),
  releaseId: z.string().uuid().optional()
}).strict();

export function normalizeChangeLogInput(input) {
  const parsed = changeLogPublishSchema.parse(input);
  return {
    version: parsed.version,
    title: parsed.title,
    changes: parsed.changes.map((change) => change.replace(/\s+/g, ' ').trim()),
    releaseId: parsed.releaseId || null
  };
}

function mapChangeLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    changes: parseChanges(row.changes_json),
    releaseId: row.release_id || null,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.published_at,
    publishedBy: row.published_by || null
  };
}

function mapDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    changeLogId: row.changelog_id,
    channelId: row.channel_id,
    status: row.status,
    attempts: Number(row.attempt_count || 0),
    discordMessageId: row.discord_message_id || null,
    error: row.last_error || null,
    attemptedAt: row.attempted_at || null,
    deliveredAt: row.delivered_at || null,
    updatedAt: row.updated_at || null
  };
}

async function persistChangeLog(input, { actorDiscordId = null, releaseId = null } = {}) {
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const effectiveReleaseId = releaseId || input.releaseId || null;
  const row = await db.transaction(async (tx) => {
    if (effectiveReleaseId) {
      const release = await tx.prepare('SELECT id FROM loader_releases WHERE id = ?').get(effectiveReleaseId);
      if (!release) throw makeChangeLogError('Release do loader nao encontrada.', 404, 'CHANGELOG_RELEASE_NOT_FOUND');
    }

    const existing = effectiveReleaseId
      ? await tx.prepare(`
        SELECT * FROM nexus_change_logs
        WHERE release_id = ?
        LIMIT 1
      `).get(effectiveReleaseId)
      : await tx.prepare(`
        SELECT * FROM nexus_change_logs
        WHERE version = ? AND release_id IS NULL
        ORDER BY published_at DESC LIMIT 1
      `).get(input.version);

    if (existing) {
      await tx.prepare(`
        UPDATE nexus_change_logs
        SET version = ?, title = ?, changes_json = ?, release_id = ?,
            published_by = ?, published_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.version, input.title, JSON.stringify(input.changes), effectiveReleaseId,
        actorDiscordId, timestamp, timestamp, existing.id
      );
      return tx.prepare('SELECT * FROM nexus_change_logs WHERE id = ?').get(existing.id);
    }

    await tx.prepare(`
      INSERT INTO nexus_change_logs (
        id, version, title, changes_json, release_id, published_by,
        published_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.version, input.title, JSON.stringify(input.changes), effectiveReleaseId,
      actorDiscordId, timestamp, timestamp, timestamp
    );
    return tx.prepare('SELECT * FROM nexus_change_logs WHERE id = ?').get(id);
  });
  return mapChangeLog(row);
}

async function persistDelivery(changeLogId, delivery) {
  const channelId = String(delivery?.channelId || '').trim();
  if (!channelId) return null;
  const timestamp = nowIso();
  const status = delivery?.delivered ? 'sent' : delivery?.skipped ? 'skipped' : 'failed';
  const messageId = String(delivery?.messageId || '').trim() || null;
  const error = delivery?.error ? String(delivery.error).slice(0, 800) : null;

  const row = await db.transaction(async (tx) => {
    const existing = await tx.prepare(`
      SELECT * FROM nexus_change_log_deliveries
      WHERE changelog_id = ? AND channel_id = ? LIMIT 1
    `).get(changeLogId, channelId);
    if (existing) {
      await tx.prepare(`
        UPDATE nexus_change_log_deliveries
        SET status = ?, attempt_count = ?, discord_message_id = ?, last_error = ?,
            attempted_at = ?, delivered_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        status, Number(existing.attempt_count || 0) + 1, messageId, error,
        timestamp, status === 'sent' ? timestamp : existing.delivered_at || null,
        timestamp, existing.id
      );
      return tx.prepare('SELECT * FROM nexus_change_log_deliveries WHERE id = ?').get(existing.id);
    }

    const id = crypto.randomUUID();
    await tx.prepare(`
      INSERT INTO nexus_change_log_deliveries (
        id, changelog_id, channel_id, status, attempt_count, discord_message_id,
        last_error, attempted_at, delivered_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
    `).run(
      id, changeLogId, channelId, status, messageId, error,
      timestamp, status === 'sent' ? timestamp : null, timestamp, timestamp
    );
    return tx.prepare('SELECT * FROM nexus_change_log_deliveries WHERE id = ?').get(id);
  });
  return mapDelivery(row);
}

async function deliverChangeLog(changeLog) {
  const configuredChannelId = String(config.discordBot.changeLogChannelId || '').trim();
  if (!configuredChannelId) {
    return { delivered: false, skipped: true, reason: 'channel_not_configured', channelId: null };
  }

  try {
    // The Discord runtime is imported only on the server delivery path. It
    // keeps bot credentials out of public data and avoids starting a bot while
    // the changelog module is merely being read by tests or routes.
    const { sendDiscordChangeLog } = await import('./discordRuntime.js');
    return await sendDiscordChangeLog(changeLog);
  } catch (error) {
    return {
      delivered: false,
      channelId: configuredChannelId,
      error: cleanError(error)
    };
  }
}

async function dispatchChangeLog(changeLog, { actorDiscordId = null, ip = null } = {}) {
  const delivery = await deliverChangeLog(changeLog);
  const deliveryRecord = await persistDelivery(changeLog.id, delivery);
  const action = delivery.delivered
    ? 'changelog.discord_sent'
    : delivery.skipped
      ? 'changelog.discord_skipped'
      : 'changelog.discord_failed';
  await logAudit({
    actorDiscordId,
    action,
    targetType: 'nexus_changelog',
    targetId: changeLog.id,
    metadata: {
      version: changeLog.version,
      channelId: delivery.channelId || null,
      reason: delivery.reason || null,
      deliveryStatus: deliveryRecord?.status || null
    },
    ip
  }).catch(() => {});
  return { ...delivery, record: deliveryRecord };
}

export async function publishChangeLog(input, { actorDiscordId = null, releaseId = null, ip = null } = {}) {
  const normalized = normalizeChangeLogInput({ ...input, releaseId: releaseId || input?.releaseId });
  const changeLog = await persistChangeLog(normalized, { actorDiscordId, releaseId: normalized.releaseId });

  await logAudit({
    actorDiscordId,
    action: 'changelog.published',
    targetType: 'nexus_changelog',
    targetId: changeLog.id,
    metadata: {
      version: changeLog.version,
      title: changeLog.title,
      changesCount: changeLog.changes.length,
      releaseId: changeLog.releaseId
    },
    ip
  });

  const delivery = await dispatchChangeLog(changeLog, { actorDiscordId, ip });
  return { changeLog, delivery };
}

// Kept as an explicit public name for release tooling. All writes still go
// through the same server-only implementation above.
export const PublishChangeLog = publishChangeLog;

export async function listPublicChangeLogs({ limit = 10 } = {}) {
  const rows = await db.prepare(`
    SELECT id, version, title, changes_json, release_id, published_at, created_at, updated_at
    FROM nexus_change_logs
    ORDER BY published_at DESC
    LIMIT ?
  `).all(cleanLimit(limit));
  return rows.map(mapChangeLog);
}

export async function listChangeLogs({ limit = 20, includeDeliveries = false } = {}) {
  const rows = await db.prepare(`
    SELECT * FROM nexus_change_logs ORDER BY published_at DESC LIMIT ?
  `).all(cleanLimit(limit, 20));
  const changeLogs = rows.map(mapChangeLog);
  if (!includeDeliveries || changeLogs.length === 0) return changeLogs;

  const deliveries = await Promise.all(changeLogs.map(async (changeLog) => {
    const row = await db.prepare(`
      SELECT * FROM nexus_change_log_deliveries
      WHERE changelog_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(changeLog.id);
    return { ...changeLog, delivery: mapDelivery(row) };
  }));
  return deliveries;
}

export async function getChangeLogByReleaseId(releaseId) {
  const row = await db.prepare(`
    SELECT * FROM nexus_change_logs WHERE release_id = ? LIMIT 1
  `).get(String(releaseId || ''));
  return mapChangeLog(row);
}

export async function retryChangeLogDelivery(changeLogId, { actorDiscordId = null, ip = null } = {}) {
  const row = await db.prepare('SELECT * FROM nexus_change_logs WHERE id = ?').get(changeLogId);
  if (!row) throw makeChangeLogError('Change log nao encontrado.', 404, 'CHANGELOG_NOT_FOUND');
  const changeLog = mapChangeLog(row);
  const delivery = await dispatchChangeLog(changeLog, { actorDiscordId, ip });
  return { changeLog, delivery };
}

export function registerChangeLogRoutes(app, { requireAuth, requireAdmin }) {
  app.get('/api/changelog/public', async (req, res) => {
    const changeLogs = await listPublicChangeLogs({ limit: req.query?.limit });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ changeLogs });
  });

  app.get('/api/changelog', requireAuth, requireAdmin, async (req, res) => {
    const changeLogs = await listChangeLogs({ limit: req.query?.limit, includeDeliveries: true });
    res.json({ changeLogs });
  });

  app.post('/api/changelog', requireAuth, requireAdmin, async (req, res) => {
    const result = await publishChangeLog(changeLogPublishSchema.parse(req.body), {
      actorDiscordId: req.user.discordId,
      ip: req.ip
    });
    res.status(201).json(result);
  });

  app.post('/api/changelog/:id/retry-discord', requireAuth, requireAdmin, async (req, res) => {
    const result = await retryChangeLogDelivery(req.params.id, {
      actorDiscordId: req.user.discordId,
      ip: req.ip
    });
    res.json(result);
  });
}
