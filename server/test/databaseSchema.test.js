import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const dbSource = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
const schemaMatch = dbSource.match(/const schemaSql = `([\s\S]*?)`;/);
if (!schemaMatch) throw new Error('schemaSql não encontrado.');

function makeDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(schemaMatch[1]);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_license_events_nonce
    ON license_events(license_user_id, event_type, request_nonce_hash)
  `);
  return database;
}

function seedSecurityParents(database) {
  const timestamp = '2026-07-28T12:00:00.000Z';
  database.prepare(`
    INSERT INTO license_plans (
      id, name, default_hwid_reset_limit, active, created_at, updated_at
    ) VALUES (?, ?, 1, 1, ?, ?)
  `).run('plan-1', 'Teste', timestamp, timestamp);
  database.prepare(`
    INSERT INTO license_users (
      id, discord_id, license_key_hash, license_key_encrypted,
      license_key_preview, plan_id, status, hwid_reset_limit, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `).run('license-1', '1234567890', 'key-hash', 'encrypted-key', 'NXS-TESTE', 'plan-1', timestamp, timestamp);
  database.prepare(`
    INSERT INTO loader_releases (
      id, version, payload_encrypted, payload_sha256, payload_bytes,
      protected_mode, active, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run('release-1', 'v-test', 'encrypted', 'sha', 500, timestamp);
}

test('schema cria tabelas persistentes de tickets, nonces e rate limits', () => {
  const database = makeDatabase();
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name);
  assert.ok(tables.includes('loader_tickets'));
  assert.ok(tables.includes('bot_api_nonces'));
  assert.ok(tables.includes('nexus_rate_limits'));
  database.close();
});

test('ticket é consumido atomicamente uma única vez', () => {
  const database = makeDatabase();
  seedSecurityParents(database);
  database.prepare(`
    INSERT INTO loader_tickets (
      id, ticket_hash, license_user_id, release_id, hwid_hash, nonce_hash,
      used, attempts, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `).run('ticket-1', 'hash-1', 'license-1', 'release-1', 'hwid-1', 'nonce-1',
    '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:45.000Z');
  const consume = database.prepare(`
    UPDATE loader_tickets SET used = 1, used_at = ?
    WHERE id = ? AND used = 0 AND invalidated_at IS NULL AND expires_at > ?
      AND hwid_hash = ? AND nonce_hash = ? AND release_id = ?
  `);
  const first = consume.run('2026-07-28T12:00:01.000Z', 'ticket-1',
    '2026-07-28T12:00:01.000Z', 'hwid-1', 'nonce-1', 'release-1');
  const second = consume.run('2026-07-28T12:00:02.000Z', 'ticket-1',
    '2026-07-28T12:00:02.000Z', 'hwid-1', 'nonce-1', 'release-1');
  assert.equal(Number(first.changes), 1);
  assert.equal(Number(second.changes), 0);
  database.close();
});

test('nonce duplicado não cria evento de validação duplicado', () => {
  const database = makeDatabase();
  seedSecurityParents(database);
  const insert = database.prepare(`
    INSERT INTO license_events (
      id, license_user_id, event_type, request_nonce_hash, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, '{}', ?)
    ON CONFLICT (license_user_id, event_type, request_nonce_hash) DO NOTHING
  `);
  assert.equal(Number(insert.run('event-1', 'license-1', 'validated', 'nonce-a', '2026-07-28T12:00:00.000Z').changes), 1);
  assert.equal(Number(insert.run('event-2', 'license-1', 'validated', 'nonce-a', '2026-07-28T12:00:01.000Z').changes), 0);
  database.close();
});

test('rollback de publicação mantém a versão anterior ativa', () => {
  const database = makeDatabase();
  const insert = database.prepare(`
    INSERT INTO loader_releases (
      id, version, payload_encrypted, payload_sha256, payload_bytes,
      protected_mode, active, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `);
  insert.run('old', 'v1', 'encrypted', 'sha', 500, 1, '2026-07-28T12:00:00.000Z');
  database.exec('BEGIN IMMEDIATE');
  database.prepare('UPDATE loader_releases SET active = 0 WHERE active = 1').run();
  database.exec('ROLLBACK');
  assert.equal(Number(database.prepare('SELECT active FROM loader_releases WHERE id = ?').get('old').active), 1);
  database.close();
});

test('versão ativa não passa pelo delete condicional', () => {
  const database = makeDatabase();
  database.prepare(`
    INSERT INTO loader_releases (
      id, version, payload_encrypted, payload_sha256, payload_bytes,
      protected_mode, active, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run('active', 'v1', 'encrypted', 'sha', 500, '2026-07-28T12:00:00.000Z');
  const result = database.prepare('DELETE FROM loader_releases WHERE id = ? AND active = 0').run('active');
  assert.equal(Number(result.changes), 0);
  database.close();
});
