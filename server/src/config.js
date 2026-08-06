import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = path.resolve(rootDir, '.env');

// Em producao, as variaveis do provedor de hospedagem sao a fonte de verdade.
// Um .env local serve apenas como fallback para desenvolvimento e nunca pode
// sobrescrever segredos atualizados no painel da SquareCloud.
dotenv.config({ path: envPath, override: false });

const productionDefaultPort = process.env.NODE_ENV === 'production' ? '80' : '4000';

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function listEnv(name) {
  return env(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function missingEnv(value) {
  const clean = String(value || '').trim();
  if (!clean) return true;
  const lower = clean.toLowerCase();
  return lower.startsWith('seu_')
    || lower.startsWith('cole_')
    || lower.startsWith('base64_')
    || lower.startsWith('segredo_')
    || lower.includes('_aqui');
}

function parseAuthorizedUsers(raw) {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [discordId, role] = entry.split(':').map((item) => item.trim());
      return {
        discordId,
        role: role || (index === 0 ? 'owner' : 'member')
      };
    })
    .filter((item) => /^\d{5,32}$/.test(item.discordId));
}

function normalizeCloudinaryCloudName(raw) {
  const value = raw.trim().toLowerCase();
  if (value === 'armazenamento' || value === 'ger3sly') {
    return 'ger3tsly';
  }
  return value;
}

export const config = {
  rootDir,
  envPath,
  port: Number(env('PORT', productionDefaultPort)),
  nodeEnv: env('NODE_ENV', 'development'),
  clientUrl: env('CLIENT_URL', 'http://localhost:5173'),
  apiPublicUrl: env('API_PUBLIC_URL', `http://localhost:${env('PORT', productionDefaultPort)}`),
  databaseUrl: env('DATABASE_URL'),
  databasePath: path.resolve(rootDir, env('DATABASE_PATH', './data/nexus.db')),
  cloudinary: {
    cloudName: normalizeCloudinaryCloudName(env('CLOUDINARY_CLOUD_NAME')),
    apiKey: env('CLOUDINARY_API_KEY'),
    apiSecret: env('CLOUDINARY_API_SECRET'),
    folder: env('CLOUDINARY_FOLDER', 'nexus')
  },
  r2: {
    accountId: env('R2_ACCOUNT_ID'),
    endpoint: env('R2_ENDPOINT'),
    accessKeyId: env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
    bucket: env('R2_BUCKET')
  },
  robloxGenerator: {
    sourceFile: path.resolve(rootDir, env('ROBLOX_ACCOUNTS_FILE', './data/roblox-accounts.txt'))
  },
  rushmail: {
    apiKey: env('RUSHMAIL_API_KEY'),
    baseUrl: env('RUSHMAIL_API_URL', 'https://rushmail.dev/public-api').replace(/\/+$/, '')
  },
  chatbot: {
    groqApiKey: env('GROQ_API_KEY'),
    groqUrl: env('GROQ_API_URL', 'https://api.groq.com/openai/v1/chat/completions').replace(/\/+$/, ''),
    model: env('GROQ_MODEL', 'llama-3.3-70b-versatile')
  },
  livePix: {
    clientId: env('LIVEPIX_CLIENT_ID'),
    clientSecret: env('LIVEPIX_CLIENT_SECRET'),
    scope: env('LIVEPIX_SCOPE', 'payments:read payments:write webhooks'),
    oauthUrl: env('LIVEPIX_OAUTH_URL', 'https://oauth.livepix.gg/oauth2/token'),
    apiUrl: env('LIVEPIX_API_URL', 'https://api.livepix.gg').replace(/\/+$/, ''),
    redirectUrl: env('LIVEPIX_REDIRECT_URL', env('CLIENT_URL', 'http://localhost:5173')),
    webhookUrl: env('LIVEPIX_WEBHOOK_URL')
  },
  discord: {
    clientId: env('DISCORD_CLIENT_ID'),
    clientSecret: env('DISCORD_CLIENT_SECRET'),
    redirectUri: env('DISCORD_REDIRECT_URI', `http://localhost:${env('PORT', '4000')}/api/auth/discord/callback`),
    oauthFlow: env('DISCORD_OAUTH_FLOW', 'code')
  },
  discordBot: {
    token: env('DISCORD_BOT_TOKEN'),
    defaultGuildId: env('DISCORD_DEFAULT_GUILD_ID'),
    messageContentIntent: boolEnv('DISCORD_MESSAGE_CONTENT_INTENT', false),
    guildMembersIntent: boolEnv('DISCORD_GUILD_MEMBERS_INTENT', false),
    apiId: env('NEXUS_BOT_API_ID', 'nexus-discord-bot'),
    apiSecret: env('NEXUS_BOT_API_SECRET'),
    apiUrl: env('NEXUS_BOT_API_URL', env('API_PUBLIC_URL', `http://localhost:${env('PORT', productionDefaultPort)}`)).replace(/\/+$/, ''),
    allowedGuildIds: listEnv('NEXUS_BOT_ALLOWED_GUILD_IDS'),
    allowedChannelIds: listEnv('NEXUS_BOT_ALLOWED_CHANNEL_IDS'),
    ownerIds: listEnv('NEXUS_BOT_OWNER_IDS')
  },
  loader: {
    ticketSigningSecret: env('LOADER_TICKET_SECRET'),
    encryptionKeyId: env('APP_MASTER_KEY_ID', 'primary'),
    previousMasterKeys: env('APP_PREVIOUS_MASTER_KEYS'),
    eventRetentionDays: numberEnv('LICENSE_EVENT_RETENTION_DAYS', 90, { min: 7, max: 3650 }),
    rateLimits: {
      redeemAttempts: numberEnv('RATE_LIMIT_REDEEM_ATTEMPTS', 5, { min: 1, max: 100 }),
      redeemWindowSeconds: numberEnv('RATE_LIMIT_REDEEM_WINDOW_SECONDS', 900, { min: 10, max: 86400 }),
      licenseQueries: numberEnv('RATE_LIMIT_LICENSE_QUERIES', 15, { min: 1, max: 1000 }),
      licenseQueryWindowSeconds: numberEnv('RATE_LIMIT_LICENSE_QUERY_WINDOW_SECONDS', 60, { min: 10, max: 3600 }),
      hwidResets: numberEnv('RATE_LIMIT_HWID_RESETS', 3, { min: 1, max: 100 }),
      hwidResetWindowSeconds: numberEnv('RATE_LIMIT_HWID_RESET_WINDOW_SECONDS', 3600, { min: 60, max: 86400 }),
      validations: numberEnv('RATE_LIMIT_LOADER_VALIDATIONS', 20, { min: 1, max: 1000 }),
      validationWindowSeconds: numberEnv('RATE_LIMIT_LOADER_VALIDATION_WINDOW_SECONDS', 60, { min: 10, max: 3600 }),
      tickets: numberEnv('RATE_LIMIT_LOADER_TICKETS', 10, { min: 1, max: 1000 }),
      ticketWindowSeconds: numberEnv('RATE_LIMIT_LOADER_TICKET_WINDOW_SECONDS', 60, { min: 10, max: 3600 }),
      ticketConsumeAttempts: numberEnv('RATE_LIMIT_TICKET_CONSUME_ATTEMPTS', 5, { min: 1, max: 20 }),
      botCooldownSeconds: numberEnv('RATE_LIMIT_BOT_COOLDOWN_SECONDS', 2, { min: 1, max: 60 })
    }
  },
  security: {
    masterKey: env('APP_MASTER_KEY'),
    sessionSecret: env('SESSION_SECRET'),
    requireHttps: boolEnv('REQUIRE_HTTPS', false),
    trustProxy: boolEnv('TRUST_PROXY', false)
  },
  authorizedUsers: parseAuthorizedUsers(env('AUTHORIZED_DISCORD_IDS'))
};

export function getMissingRuntimeConfig() {
  const missing = [];
  if (missingEnv(config.discord.clientId)) missing.push('DISCORD_CLIENT_ID');
  if (config.discord.oauthFlow !== 'implicit' && missingEnv(config.discord.clientSecret)) {
    missing.push('DISCORD_CLIENT_SECRET');
  }
  if (missingEnv(config.security.masterKey)) missing.push('APP_MASTER_KEY');
  if (missingEnv(config.security.sessionSecret)) missing.push('SESSION_SECRET');
  if (
    !missingEnv(config.discordBot.token)
    && (missingEnv(config.discordBot.apiSecret) || config.discordBot.apiSecret.length < 32)
  ) missing.push('NEXUS_BOT_API_SECRET');
  if (missingEnv(config.loader.ticketSigningSecret) || config.loader.ticketSigningSecret.length < 32) {
    missing.push('LOADER_TICKET_SECRET');
  }
  if (config.authorizedUsers.length === 0) missing.push('AUTHORIZED_DISCORD_IDS');
  return missing;
}

export function hasDiscordOAuthConfig() {
  return !missingEnv(config.discord.clientId)
    && (config.discord.oauthFlow === 'implicit' || !missingEnv(config.discord.clientSecret))
    && !missingEnv(config.discord.redirectUri);
}

export function hasCloudinaryConfig() {
  return !missingEnv(config.cloudinary.cloudName)
    && !missingEnv(config.cloudinary.apiKey)
    && !missingEnv(config.cloudinary.apiSecret);
}

export function hasR2Config() {
  return (!missingEnv(config.r2.accountId) || !missingEnv(config.r2.endpoint))
    && !missingEnv(config.r2.accessKeyId)
    && !missingEnv(config.r2.secretAccessKey)
    && !missingEnv(config.r2.bucket);
}

export function requireRuntimeConfig() {
  const missing = getMissingRuntimeConfig();
  if (missing.length > 0) {
    const message = `Variaveis de ambiente ausentes ou ainda com placeholder: ${missing.join(', ')}`;
    if (config.nodeEnv === 'production') {
      throw new Error(message);
    }
    console.warn(`[nexus] ${message}`);
  }
}
