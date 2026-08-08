import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const databasePath = path.join(os.tmpdir(), `nexus-primary-discord-environment-${process.pid}.db`);
fs.rmSync(databasePath, { force: true });
process.env.DATABASE_URL = '';
process.env.DATABASE_PATH = databasePath;
process.env.APP_MASTER_KEY = Buffer.alloc(32, 37).toString('base64');
process.env.APP_MASTER_KEY_ID = 'primary-discord-environment-test';
process.env.DISCORD_BOT_TOKEN = 'hosted-bot-token-for-test-only';
process.env.DISCORD_DEFAULT_GUILD_ID = '123456789012345678';

const { config } = await import('../src/config.js');
const { db, initDatabase } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const { hydratePrimaryDiscordBotConfig } = await import('../src/discordRuntime.js');

await initDatabase();

test('bot da hospedagem tem prioridade sobre configuracao antiga do painel', async () => {
  await db.prepare(`
    INSERT INTO discord_primary_bot_config (
      id, guild_id, bot_user_id, token_encrypted, configured_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'primary',
    '987654321098765432',
    '111111111111111111',
    encryptSecret('dashboard-bot-token-for-test-only'),
    'owner-test',
    '2026-08-08T12:00:00.000Z',
    '2026-08-08T12:01:00.000Z'
  );

  const status = await hydratePrimaryDiscordBotConfig();

  assert.equal(config.discordBot.token, 'hosted-bot-token-for-test-only');
  assert.equal(config.discordBot.defaultGuildId, '123456789012345678');
  assert.equal(status.source, 'environment');
  assert.equal(status.persisted, false);
  assert.equal(status.bot, null);
  assert.equal(JSON.stringify(status).includes('dashboard-bot-token-for-test-only'), false);
});
