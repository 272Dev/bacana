import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptAes256Gcm, encryptAes256Gcm } from '../src/aesGcm.js';
import {
  normalizeLicenseKeyInput,
  uniqueSecurityEvents,
  validateLicenseRedeemState
} from '../src/licensePolicy.js';
import { assertLoaderTicketEligible } from '../src/loaderPolicy.js';
import { claimInteractionCooldown } from '../src/interactionPolicy.js';

const now = Date.parse('2026-07-28T12:00:00.000Z');

function activeTicket(patch = {}) {
  return {
    attempts: 1,
    used: 0,
    invalidated_at: null,
    expires_at: '2026-07-28T12:00:45.000Z',
    license_expires_at: '2026-08-28T12:00:00.000Z',
    license_status: 'active',
    active: 1,
    version: 'v3.0.0',
    hwid_hash: 'hwid-a',
    nonce_hash: 'nonce-a',
    roblox_user_id: '123456',
    ...patch
  };
}

const ticketInput = {
  releaseVersion: 'v3.0.0',
  hwidHash: 'hwid-a',
  nonceHash: 'nonce-a',
  robloxUserId: '123456'
};

function expectCode(fn, code) {
  assert.throws(fn, (error) => error.code === code);
}

test('normaliza key com espaços, caixa e separadores', () => {
  assert.equal(
    normalizeLicenseKeyInput(' nxs_abcde_fghij_klmno_pqrst '),
    'NXS-ABCDE-FGHIJ-KLMNO-PQRST'
  );
});

test('resgate válido permanece elegível', () => {
  assert.deepEqual(validateLicenseRedeemState({
    status: 'active',
    discord_id: '10',
    expires_at: '2026-08-01T00:00:00.000Z'
  }, '10', now), { ok: true });
});

test('key inexistente não revela proprietário', () => {
  assert.equal(validateLicenseRedeemState(null, '10', now).code, 'KEY_INVALID');
});

test('key expirada é recusada', () => {
  assert.equal(validateLicenseRedeemState({
    status: 'active',
    discord_id: '10',
    expires_at: '2026-07-20T00:00:00.000Z'
  }, '10', now).code, 'LICENSE_EXPIRED');
});

test('key suspensa é recusada', () => {
  assert.equal(validateLicenseRedeemState({
    status: 'suspended',
    discord_id: '10'
  }, '10', now).code, 'LICENSE_SUSPENDED');
});

test('key vinculada a outro Discord é recusada', () => {
  assert.equal(validateLicenseRedeemState({
    status: 'active',
    discord_id: '20'
  }, '10', now).code, 'LICENSE_ALREADY_LINKED');
});

test('repetição com mesmo nonce não aumenta evidência', () => {
  const events = [
    { id: '1', hwid: 'ABC', request_nonce_hash: 'same' },
    { id: '2', hwid: 'DEF', request_nonce_hash: 'same' }
  ];
  assert.equal(uniqueSecurityEvents(events, 'hwid').length, 1);
});

test('formatações diferentes do mesmo HWID contam uma vez', () => {
  const events = [
    { id: '1', hwid: '  ABC  ', request_nonce_hash: 'n1' },
    { id: '2', hwid: 'abc', request_nonce_hash: 'n2' }
  ];
  assert.equal(uniqueSecurityEvents(events, 'hwid').length, 1);
});

test('três HWIDs distintos geram três evidências', () => {
  const events = ['a', 'b', 'c'].map((hwid, index) => ({
    id: String(index),
    hwid,
    request_nonce_hash: `n${index}`
  }));
  assert.equal(uniqueSecurityEvents(events, 'hwid').length, 3);
});

test('seis redes distintas geram seis evidências', () => {
  const events = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    ip_approx: `10.0.${index}.0/24`,
    request_nonce_hash: `n${index}`
  }));
  assert.equal(uniqueSecurityEvents(events, 'ip_approx').length, 6);
});

test('ticket válido é aceito', () => {
  assert.equal(assertLoaderTicketEligible(activeTicket(), ticketInput, { now }), true);
});

test('ticket expirado é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket({ expires_at: '2026-07-28T11:59:59.000Z' }),
    ticketInput,
    { now }
  ), 'TICKET_EXPIRED');
});

test('ticket reutilizado é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(activeTicket({ used: 1 }), ticketInput, { now }), 'TICKET_USED');
});

test('ticket invalidado é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket({ invalidated_at: '2026-07-28T11:59:00.000Z' }),
    ticketInput,
    { now }
  ), 'TICKET_INVALID');
});

test('ticket de outro HWID é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket(),
    { ...ticketInput, hwidHash: 'hwid-b' },
    { now }
  ), 'TICKET_INVALID');
});

test('ticket de outra versão é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket(),
    { ...ticketInput, releaseVersion: 'v2.0.0' },
    { now }
  ), 'VERSION_INACTIVE');
});

test('ticket de outra conta Roblox é recusado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket(),
    { ...ticketInput, robloxUserId: '999999' },
    { now }
  ), 'TICKET_INVALID');
});

test('suspensão invalida a autorização do ticket', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket({ license_status: 'suspended' }),
    ticketInput,
    { now }
  ), 'LICENSE_SUSPENDED');
});

test('expiração da licença invalida a autorização do ticket', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket({ license_expires_at: '2026-07-28T11:00:00.000Z' }),
    ticketInput,
    { now }
  ), 'LICENSE_EXPIRED');
});

test('limite de tentativas do ticket é aplicado', () => {
  expectCode(() => assertLoaderTicketEligible(
    activeTicket({ attempts: 6 }),
    ticketInput,
    { now, maxAttempts: 5 }
  ), 'RATE_LIMITED');
});

test('AES-256-GCM cifra e decifra com key id', () => {
  const key = Buffer.alloc(32, 7);
  const encrypted = encryptAes256Gcm('conteúdo Nexus', key, 'test-key');
  assert.match(encrypted, /^v2:test-key:/);
  assert.equal(decryptAes256Gcm(encrypted, () => key), 'conteúdo Nexus');
});

test('AES-256-GCM usa nonce diferente em cada publicação', () => {
  const key = Buffer.alloc(32, 8);
  assert.notEqual(
    encryptAes256Gcm('mesmo conteúdo', key, 'test-key'),
    encryptAes256Gcm('mesmo conteúdo', key, 'test-key')
  );
});

test('AES-256-GCM bloqueia conteúdo adulterado', () => {
  const key = Buffer.alloc(32, 9);
  const encrypted = encryptAes256Gcm('conteúdo íntegro', key, 'test-key');
  const parts = encrypted.split(':');
  parts[4] = `${parts[4].slice(0, -2)}AA`;
  assert.throws(() => decryptAes256Gcm(parts.join(':'), () => key));
});

test('AES-256-GCM bloqueia chave incorreta', () => {
  const encrypted = encryptAes256Gcm('segredo', Buffer.alloc(32, 1), 'test-key');
  assert.throws(() => decryptAes256Gcm(encrypted, () => Buffer.alloc(32, 2)));
});

test('clique duplicado no mesmo botão é bloqueado por cooldown', () => {
  const cooldowns = new Map();
  assert.equal(claimInteractionCooldown(cooldowns, 'user:button', 2000, 1000).allowed, true);
  const duplicate = claimInteractionCooldown(cooldowns, 'user:button', 2000, 1500);
  assert.equal(duplicate.allowed, false);
  assert.equal(duplicate.retryAfterMs, 1500);
});

test('botão volta a funcionar após o cooldown', () => {
  const cooldowns = new Map();
  claimInteractionCooldown(cooldowns, 'user:button', 2000, 1000);
  assert.equal(claimInteractionCooldown(cooldowns, 'user:button', 2000, 3000).allowed, true);
});
