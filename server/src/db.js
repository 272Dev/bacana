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
  CREATE INDEX IF NOT EXISTS idx_authenticators_label ON authenticators(label);
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
    return;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  sqlite = new DatabaseSync(config.databasePath);
  await db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    ${schemaSql}
  `);
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
