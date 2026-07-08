import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = path.resolve(rootDir, '.env');

dotenv.config({ path: envPath, override: true });

function env(name, fallback = '') {
  return process.env[name] || fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
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
  port: Number(env('PORT', '4000')),
  nodeEnv: env('NODE_ENV', 'development'),
  clientUrl: env('CLIENT_URL', 'http://localhost:5173'),
  apiPublicUrl: env('API_PUBLIC_URL', `http://localhost:${env('PORT', '4000')}`),
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
  discord: {
    clientId: env('DISCORD_CLIENT_ID'),
    clientSecret: env('DISCORD_CLIENT_SECRET'),
    redirectUri: env('DISCORD_REDIRECT_URI', `http://localhost:${env('PORT', '4000')}/api/auth/discord/callback`),
    oauthFlow: env('DISCORD_OAUTH_FLOW', 'code')
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
