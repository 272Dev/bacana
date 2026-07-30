import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  isValidJobId,
  isValidPlaceId,
  isValidRobloxUserId,
  isPresenceLive,
  mapPublicPresence
} from '../src/nexusPresencePolicy.js';

const dbSource = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
const schemaMatch = dbSource.match(/const schemaSql = `([\s\S]*?)`;/);
if (!schemaMatch) throw new Error('schemaSql nao encontrado.');

function makePresenceDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(schemaMatch[1]);
  const timestamp = '2026-07-30T12:00:00.000Z';
  database.prepare(`
    INSERT INTO license_plans (id, name, default_hwid_reset_limit, active, created_at, updated_at)
    VALUES (?, ?, 1, 1, ?, ?)
  `).run('presence-plan', 'Presence', timestamp, timestamp);
  for (const id of ['license-a', 'license-b']) {
    database.prepare(`
      INSERT INTO license_users (
        id, discord_id, license_key_hash, license_key_encrypted,
        license_key_preview, plan_id, status, hwid_reset_limit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'presence-plan', 'active', 1, ?, ?)
    `).run(id, `${id}-discord`, `${id}-key`, 'encrypted', 'NXS-TESTE', timestamp, timestamp);
  }
  return database;
}

const validPayload = {
  key: 'NXS-ABCDE-FGHIJ-KLMNO-PQRST',
  hwid: 'nexus-hwid-test-device',
  loaderVersion: '3.1.0',
  robloxUserId: '123456789',
  placeId: '987654321',
  jobId: '6f1d5233-3a3a-4ce4-b2ec-a8aef778c11b'
};

test('presence aceita somente identidade Roblox e JobId validos', () => {
  assert.equal(isValidRobloxUserId(validPayload.robloxUserId), true);
  assert.equal(isValidPlaceId(validPayload.placeId), true);
  assert.equal(isValidJobId(validPayload.jobId), true);

  assert.equal(isValidRobloxUserId('0'), false);
  assert.equal(isValidPlaceId('0'), false);
  assert.equal(isValidJobId('arbitrary-client-text'), false);
  assert.equal(isValidJobId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), true);
});

test('presence publica somente dados de descoberta consentida, nunca JobId bruto', () => {
  const presence = mapPublicPresence({
    roblox_user_id: '123456789',
    roblox_username: 'nexus_user',
    roblox_display_name: 'Nexus User',
    place_id: '987654321',
    job_id: validPayload.jobId
  });

  assert.deepEqual(presence, {
    robloxUserId: '123456789',
    username: 'nexus_user',
    displayName: 'Nexus User',
    placeId: '987654321',
    sessionAvailable: true
  });
  assert.equal(Object.hasOwn(presence, 'jobId'), false);
  assert.equal(mapPublicPresence(null), null);
});

test('presence expirada nao e considerada online', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');
  assert.equal(isPresenceLive({ expires_at: '2026-07-30T12:00:01.000Z' }, now), true);
  assert.equal(isPresenceLive({ expires_at: '2026-07-30T12:00:00.000Z' }, now), false);
  assert.equal(isPresenceLive({ expires_at: 'invalid' }, now), false);
});

test('schema mantem uma sessao por licenca/Roblox e permite purga sem historico', () => {
  const database = makePresenceDatabase();
  const insert = database.prepare(`
    INSERT INTO nexus_presence_sessions (
      id, license_user_id, roblox_user_id, place_id, job_id,
      created_at, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const base = ['123456789', '987654321', validPayload.jobId, '2026-07-30T12:00:00.000Z'];
  insert.run('expired', 'license-a', ...base, '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z');
  assert.throws(() => insert.run(
    'same-license', 'license-a', '222222222', '987654321', validPayload.jobId,
    '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z', '2026-07-30T12:01:00.000Z'
  ));
  assert.throws(() => insert.run(
    'same-roblox', 'license-b', '123456789', '987654321', validPayload.jobId,
    '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z', '2026-07-30T12:01:00.000Z'
  ));
  assert.equal(Number(database.prepare(
    'DELETE FROM nexus_presence_sessions WHERE expires_at <= ?'
  ).run('2026-07-30T12:00:00.000Z').changes), 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS total FROM nexus_presence_sessions').get().total, 0);
  database.close();
});
