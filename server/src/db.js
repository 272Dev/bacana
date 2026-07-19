import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

let sqlite = null;
let postgres = null;

const schemaSql = `
  CREATE TABLE IF NOT EXISTS authorized_users (
    discord_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    label TEXT,
    permissions_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar_hash TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    owner_discord_id TEXT NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    photo_url TEXT,
    login_encrypted TEXT NOT NULL,
    password_encrypted TEXT NOT NULL,
    notes_encrypted TEXT NOT NULL,
    roblox_username TEXT,
    roblox_display_name TEXT,
    roblox_user_id TEXT,
    roblox_profile_url TEXT,
    roblox_avatar_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (owner_discord_id) REFERENCES users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS account_shares (
    account_id TEXT NOT NULL,
    shared_with_discord_id TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, shared_with_discord_id),
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (shared_with_discord_id) REFERENCES authorized_users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS account_history (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    actor_discord_id TEXT NOT NULL,
    action TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_discord_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    ip TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    ip TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    blocked_until TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS image_folders (
    id TEXT PRIMARY KEY,
    owner_discord_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_discord_id) REFERENCES users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    owner_discord_id TEXT NOT NULL,
    folder_id TEXT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (owner_discord_id) REFERENCES users(discord_id),
    FOREIGN KEY (folder_id) REFERENCES image_folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS roblox_generator_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_encrypted TEXT NOT NULL,
    display_name TEXT,
    user_id TEXT,
    profile_url TEXT,
    avatar_url TEXT,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'in_use')),
    selected_by_discord_id TEXT,
    selected_at TEXT,
    cookie_encrypted TEXT,
    notes_encrypted TEXT,
    source_label TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (selected_by_discord_id) REFERENCES users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS authenticators (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    issuer TEXT,
    username TEXT,
    secret_encrypted TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'SHA1',
    digits INTEGER NOT NULL DEFAULT 6,
    period INTEGER NOT NULL DEFAULT 30,
    notes_encrypted TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS sales_deliveries (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL UNIQUE,
    buyer_discord_id TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'discord',
    status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'delivered')),
    payment_provider TEXT,
    payment_reference TEXT,
    payment_status TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    FOREIGN KEY (account_id) REFERENCES roblox_generator_accounts(id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS temp_email_inboxes (
    id TEXT PRIMARY KEY,
    label TEXT,
    address TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT 'mail.tm',
    provider_account_id TEXT,
    password_encrypted TEXT NOT NULL,
    token_encrypted TEXT NOT NULL,
    created_by TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(discord_id)
  );

  CREATE TABLE IF NOT EXISTS license_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    duration_days INTEGER,
    default_hwid_reset_limit INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS license_users (
    id TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL UNIQUE,
    discord_username TEXT,
    discord_global_name TEXT,
    discord_avatar_url TEXT,
    license_key_hash TEXT NOT NULL UNIQUE,
    license_key_encrypted TEXT NOT NULL,
    license_key_preview TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked', 'expired')),
    expires_at TEXT,
    hwid TEXT,
    hwid_bound_at TEXT,
    hwid_reset_count INTEGER NOT NULL DEFAULT 0,
    hwid_reset_limit INTEGER NOT NULL DEFAULT 1,
    last_hwid_reset_at TEXT,
    last_used_at TEXT,
    last_ip_approx TEXT,
    last_loader_version TEXT,
    suspicious_score INTEGER NOT NULL DEFAULT 0,
    suspicious_reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (plan_id) REFERENCES license_plans(id)
  );

  CREATE TABLE IF NOT EXISTS license_events (
    id TEXT PRIMARY KEY,
    license_user_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    hwid TEXT,
    ip_approx TEXT,
    loader_version TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (license_user_id) REFERENCES license_users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS roblox_name_tags (
    id TEXT PRIMARY KEY,
    license_user_id TEXT UNIQUE,
    hwid_hash TEXT UNIQUE,
    roblox_user_id TEXT UNIQUE,
    roblox_username TEXT,
    roblox_display_name TEXT,
    display_name_override TEXT,
    title TEXT NOT NULL DEFAULT 'Nexus Member',
    icon TEXT NOT NULL DEFAULT 'initial' CHECK (icon IN ('initial', 'diamond', 'shield', 'star', 'dot')),
    badge TEXT NOT NULL DEFAULT 'none' CHECK (badge IN ('none', 'verified', 'admin', 'premium')),
    morph_distance INTEGER NOT NULL DEFAULT 52,
    max_distance INTEGER NOT NULL DEFAULT 160,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (license_user_id) REFERENCES license_users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loader_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    payload_encrypted TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    payload_bytes INTEGER NOT NULL,
    protected_mode INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discord_protection_configs (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    bot_user_id TEXT,
    bot_token_encrypted TEXT NOT NULL,
    settings_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discord_protection_events (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    detector_id TEXT NOT NULL,
    user_id TEXT,
    channel_id TEXT,
    message_id TEXT,
    action_taken TEXT,
    punishment TEXT,
    reason TEXT NOT NULL,
    audit_executor_id TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discord_protection_stats (
    guild_id TEXT NOT NULL,
    detector_id TEXT NOT NULL,
    detections INTEGER NOT NULL DEFAULT 0,
    actions INTEGER NOT NULL DEFAULT 0,
    last_detected_at TEXT,
    PRIMARY KEY (guild_id, detector_id)
  );

  CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_discord_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON account_shares(shared_with_discord_id);
  CREATE INDEX IF NOT EXISTS idx_history_account ON account_history(account_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_image_folders_owner ON image_folders(owner_discord_id);
  CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_discord_id);
  CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder_id);
  CREATE INDEX IF NOT EXISTS idx_roblox_generator_status ON roblox_generator_accounts(status);
  CREATE INDEX IF NOT EXISTS idx_roblox_generator_username ON roblox_generator_accounts(username);
  CREATE INDEX IF NOT EXISTS idx_sales_deliveries_buyer ON sales_deliveries(buyer_discord_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_deliveries_status ON sales_deliveries(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_authenticators_label ON authenticators(label);
  CREATE INDEX IF NOT EXISTS idx_temp_email_address ON temp_email_inboxes(address);
  CREATE INDEX IF NOT EXISTS idx_license_users_discord ON license_users(discord_id);
  CREATE INDEX IF NOT EXISTS idx_license_users_key_hash ON license_users(license_key_hash);
  CREATE INDEX IF NOT EXISTS idx_license_users_hwid ON license_users(hwid);
  CREATE INDEX IF NOT EXISTS idx_license_users_status ON license_users(status);
  CREATE INDEX IF NOT EXISTS idx_license_events_user_created ON license_events(license_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_license_events_type ON license_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_roblox_name_tags_license ON roblox_name_tags(license_user_id);
  CREATE INDEX IF NOT EXISTS idx_roblox_name_tags_hwid ON roblox_name_tags(hwid_hash);
  CREATE INDEX IF NOT EXISTS idx_roblox_name_tags_user ON roblox_name_tags(roblox_user_id);
  CREATE INDEX IF NOT EXISTS idx_roblox_name_tags_enabled ON roblox_name_tags(enabled);
  CREATE INDEX IF NOT EXISTS idx_loader_releases_created ON loader_releases(created_at);
  CREATE INDEX IF NOT EXISTS idx_loader_releases_active ON loader_releases(active);
  CREATE INDEX IF NOT EXISTS idx_discord_protection_guild ON discord_protection_configs(guild_id);
  CREATE INDEX IF NOT EXISTS idx_discord_protection_enabled ON discord_protection_configs(enabled);
  CREATE INDEX IF NOT EXISTS idx_discord_protection_events_guild ON discord_protection_events(guild_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_discord_protection_events_detector ON discord_protection_events(detector_id, created_at);
`;

function toPostgresSql(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function assertReady() {
  if (!sqlite && !postgres) {
    throw new Error('Banco ainda nao inicializado.');
  }
}

export const db = {
  get type() {
    return postgres ? 'postgres' : 'sqlite';
  },

  async exec(sql) {
    assertReady();
    if (postgres) {
      await postgres.query(sql);
      return;
    }
    sqlite.exec(sql);
  },

  prepare(sql) {
    assertReady();
    if (postgres) {
      const postgresSql = toPostgresSql(sql);
      return {
        async get(...params) {
          const result = await postgres.query(postgresSql, params);
          return result.rows[0];
        },
        async all(...params) {
          const result = await postgres.query(postgresSql, params);
          return result.rows;
        },
        async run(...params) {
          const result = await postgres.query(postgresSql, params);
          return { changes: result.rowCount };
        }
      };
    }

    const statement = sqlite.prepare(sql);
    return {
      async get(...params) {
        return statement.get(...params);
      },
      async all(...params) {
        return statement.all(...params);
      },
      async run(...params) {
        return statement.run(...params);
      }
    };
  }
};

export async function initDatabase() {
  if (sqlite || postgres) return;

  if (config.databaseUrl) {
    postgres = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes('sslmode=disable')
        ? false
        : { rejectUnauthorized: false }
    });
    await db.exec(schemaSql);
    await db.exec("ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS permissions_json TEXT NOT NULL DEFAULT '[]'");
    return;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  sqlite = new DatabaseSync(config.databasePath);
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    ${schemaSql}
  `);
  try {
    await db.exec("ALTER TABLE authorized_users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('duplicate column')) throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export async function seedAuthorizedUsers() {
  const now = nowIso();
  for (const item of config.authorizedUsers) {
    await db.prepare(`
      INSERT INTO authorized_users (discord_id, role, label, active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'env', ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET
        role = excluded.role,
        active = 1,
        updated_at = excluded.updated_at
    `).run(item.discordId, item.role, `Discord ${item.discordId}`, now, now);
  }
}

export async function getAuthorizedUser(discordId) {
  return db.prepare('SELECT * FROM authorized_users WHERE discord_id = ? AND active = 1').get(discordId);
}

export async function getUser(discordId) {
  return db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
}
