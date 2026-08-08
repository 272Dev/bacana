import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const databasePath = path.join(os.tmpdir(), `nexus-primary-discord-bot-${process.pid}.db`);
fs.rmSync(databasePath, { force: true });
process.env.DATABASE_URL = '';
process.env.DATABASE_PATH = databasePath;
process.env.APP_MASTER_KEY = Buffer.alloc(32, 31).toString('base64');
process.env.APP_MASTER_KEY_ID = 'primary-discord-bot-test';
process.env.DISCORD_BOT_TOKEN = '';
process.env.DISCORD_DEFAULT_GUILD_ID = '';

const { config } = await import('../src/config.js');
const { db, initDatabase } = await import('../src/db.js');
const { encryptSecret } = await import('../src/crypto.js');
const {
  getPrimaryDiscordBotConfig,
  hydratePrimaryDiscordBotConfig
} = await import('../src/discordRuntime.js');

await initDatabase();

test('configura\u00e7\u00e3o prim\u00e1ria do bot \u00e9 cifrada, hidratada e nunca volta no status', async () => {
  const token = 'painel-token-de-teste-que-nao-e-real';
  const encrypted = encryptSecret(token);
  assert.ok(encrypted.startsWith('v2:'));
  assert.equal(encrypted.includes(token), false);

  await db.prepare(`
    INSERT INTO discord_primary_bot_config (
      id, guild_id, bot_user_id, token_encrypted, configured_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'primary',
    '123456789012345678',
    '987654321098765432',
    encrypted,
    'owner-test',
    '2026-08-08T12:00:00.000Z',
    '2026-08-08T12:01:00.000Z'
  );

  config.discordBot.token = '';
  config.discordBot.defaultGuildId = '';
  const hydrated = await hydratePrimaryDiscordBotConfig();

  assert.equal(config.discordBot.token, token);
  assert.equal(config.discordBot.defaultGuildId, '123456789012345678');
  assert.equal(hydrated.configured, true);
  assert.equal(hydrated.source, 'dashboard');
  assert.equal(hydrated.bot?.id, '987654321098765432');

  const status = await getPrimaryDiscordBotConfig();
  assert.equal(status.guildId, '123456789012345678');
  assert.equal(status.configured, true);
  assert.equal(Object.hasOwn(status, 'token'), false);
  assert.equal(JSON.stringify(status).includes(token), false);
});
