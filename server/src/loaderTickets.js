import { db, nowIso } from './db.js';

export async function invalidateLoaderTicketsForLicense(licenseUserId, reason, store = db) {
  const result = await store.prepare(`
    UPDATE loader_tickets
    SET invalidated_at = ?, invalidation_reason = ?
    WHERE license_user_id = ? AND used = 0 AND invalidated_at IS NULL
  `).run(nowIso(), String(reason || 'license_changed').slice(0, 80), licenseUserId);
  return Number(result.changes || 0);
}

export async function invalidateLoaderTicketsForRelease(releaseId, reason, store = db) {
  const result = await store.prepare(`
    UPDATE loader_tickets
    SET invalidated_at = ?, invalidation_reason = ?
    WHERE release_id = ? AND used = 0 AND invalidated_at IS NULL
  `).run(nowIso(), String(reason || 'release_changed').slice(0, 80), releaseId);
  return Number(result.changes || 0);
}

export async function invalidateAllLoaderTickets(reason, store = db) {
  const result = await store.prepare(`
    UPDATE loader_tickets
    SET invalidated_at = ?, invalidation_reason = ?
    WHERE used = 0 AND invalidated_at IS NULL
  `).run(nowIso(), String(reason || 'system_changed').slice(0, 80));
  return Number(result.changes || 0);
}

export async function expireLoaderTickets(store = db) {
  const result = await store.prepare(`
    UPDATE loader_tickets
    SET invalidated_at = COALESCE(invalidated_at, ?),
      invalidation_reason = COALESCE(invalidation_reason, 'expired')
    WHERE used = 0 AND expires_at <= ?
  `).run(nowIso(), nowIso());
  const retentionCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await store.prepare(`
    DELETE FROM loader_tickets
    WHERE expires_at < ? AND (used = 1 OR invalidated_at IS NOT NULL)
  `).run(retentionCutoff);
  return Number(result.changes || 0);
}
