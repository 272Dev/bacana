import assert from 'node:assert/strict';
import test from 'node:test';
import { formatChangeLogText } from '../src/changeLogFormat.js';

test('formata o Change Log publico para a interface e Discord', () => {
  const message = formatChangeLogText({
    version: 'v2.5.1',
    publishedAt: '2026-08-07T12:00:00.000Z',
    changes: ['Quick Actions reorganizado', 'Correcao no MainPart']
  });

  assert.match(message, /NEXUS — CHANGE LOG/);
  assert.match(message, /Version v2\.5\.1/);
  assert.match(message, /• Quick Actions reorganizado/);
  assert.match(message, /• Correcao no MainPart/);
});
