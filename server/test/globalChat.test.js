import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeGlobalChatMessage } from '../src/chatUtils.js';

test('normaliza mensagem do chat global', () => {
  assert.equal(sanitizeGlobalChatMessage('  oi\n\tNexus  '), 'oi Nexus');
});

test('remove caracteres invisiveis do chat global', () => {
  assert.equal(sanitizeGlobalChatMessage('Ne\u200bxus'), 'Nexus');
});

test('bloqueia mensagens vazias ou muito longas', () => {
  assert.throws(() => sanitizeGlobalChatMessage(' \n '), { code: 'CHAT_EMPTY' });
  assert.throws(() => sanitizeGlobalChatMessage('a'.repeat(241)), { code: 'CHAT_TOO_LONG' });
});
