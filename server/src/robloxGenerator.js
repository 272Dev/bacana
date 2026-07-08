import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { lookupRobloxUsernames } from './roblox.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const ROBLOX_PROFILE_IMPORT_BATCH_SIZE = 25;
const ROBLOX_PROFILE_IMPORT_RETRIES = 3;

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeStatus(status) {
  return status === 'in_use' ? 'in_use' : 'available';
}

function parseRobloxAccountLine(line) {
  const text = cleanText(line);
  if (!text) return null;

  const labeled = text.match(/(?:login|usuario|usu[aá]rio|username|user)\s*:\s*([a-zA-Z0-9_]{3,32}).*?(?:senha|password|pass)\s*:\s*([^\s]+)/i);
  if (labeled) {
    return {
      username: labeled[1],
      password: labeled[2]
    };
  }

  const compact = text.match(/^([a-zA-Z0-9_]{3,32})\s*[:;|,\t ]+\s*([^\s]+)$/);
  if (compact) {
    return {
      username: compact[1],
      password: compact[2]
    };
  }

  return null;
}

export function parseRobloxGeneratorText(text) {
  const seen = new Set();
  const accounts = [];
  const invalidLines = [];

  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    const parsed = parseRobloxAccountLine(line);
    if (!parsed) {
      if (cleanText(line)) invalidLines.push(index + 1);
      continue;
    }

    const username = cleanText(parsed.username);
    const password = cleanText(parsed.password);
    const key = username.toLowerCase();
    if (!USERNAME_PATTERN.test(username) || !password || seen.has(key)) {
      if (!seen.has(key)) invalidLines.push(index + 1);
      continue;
    }

    seen.add(key);
    accounts.push({ username, password });
  }

  return { accounts, invalidLines };
}

async function enrichRobloxAccounts(accounts) {
  const profiles = new Map();
  const errors = [];
  const usernames = accounts.map((account) => account.username);

  for (let index = 0; index < usernames.length; index += ROBLOX_PROFILE_IMPORT_BATCH_SIZE) {
    const batch = usernames.slice(index, index + ROBLOX_PROFILE_IMPORT_BATCH_SIZE);
    let imported = false;

    for (let attempt = 1; attempt <= ROBLOX_PROFILE_IMPORT_RETRIES; attempt += 1) {
      try {
        const batchProfiles = await lookupRobloxUsernames(batch, { excludeBannedUsers: false });
        for (const [key, value] of batchProfiles.entries()) {
          profiles.set(key, value);
        }
        imported = true;
        break;
      } catch (error) {
        if (attempt === ROBLOX_PROFILE_IMPORT_RETRIES) {
          errors.push(error.message);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }

    if (imported) {
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }

  return {
    profiles,
    lookupError: errors.length ? [...new Set(errors)].join('; ') : null
  };
}

function mapStoredAccount(row, { includePassword = false } = {}) {
  const passwordResult = includePassword
    ? tryDecryptSecret(row.password_encrypted)
    : { value: null, ok: true };

  return {
    id: row.id,
    username: row.username,
    password: includePassword ? passwordResult.value : undefined,
    secretStatus: {
      passwordOk: passwordResult.ok
    },
    displayName: row.display_name,
    userId: row.user_id,
    profileUrl: row.profile_url,
    avatarUrl: row.avatar_url,
    status: normalizeStatus(row.status),
    selectedByDiscordId: row.selected_by_discord_id,
    selectedAt: row.selected_at,
    sourceLabel: row.source_label,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getExistingByUsername(username) {
  return db.prepare('SELECT * FROM roblox_generator_accounts WHERE LOWER(username) = LOWER(?)').get(username);
}

export async function importRobloxGeneratorText({ text, actorDiscordId = null, sourceLabel = 'txt' }) {
  const parsed = parseRobloxGeneratorText(text);
  const now = nowIso();
  const { profiles, lookupError } = await enrichRobloxAccounts(parsed.accounts);
  let created = 0;
  let updated = 0;
  let withoutRobloxProfile = 0;

  for (const account of parsed.accounts) {
    const profile = profiles.get(account.username.toLowerCase());
    if (!profile) withoutRobloxProfile += 1;
    const existing = await getExistingByUsername(account.username);
    const id = existing?.id || crypto.randomUUID();
    const username = profile?.username || account.username;
    const metadata = {
      futureIntegrations: {
        cookieLogin: true
      },
      importedAt: now,
      lookupOk: Boolean(profile)
    };

    if (existing) {
      await db.prepare(`
        UPDATE roblox_generator_accounts SET
          username = ?,
          password_encrypted = ?,
          display_name = ?,
          user_id = ?,
          profile_url = ?,
          avatar_url = ?,
          source_label = ?,
          metadata_json = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        username,
        encryptSecret(account.password),
        profile?.displayName || existing.display_name || null,
        profile?.userId || existing.user_id || null,
        profile?.profileUrl || existing.profile_url || null,
        profile?.avatarUrl || existing.avatar_url || null,
        sourceLabel,
        JSON.stringify(metadata),
        now,
        id
      );
      updated += 1;
    } else {
      await db.prepare(`
        INSERT INTO roblox_generator_accounts (
          id, username, password_encrypted, display_name, user_id, profile_url, avatar_url,
          status, selected_by_discord_id, selected_at, cookie_encrypted, notes_encrypted,
          source_label, metadata_json, created_by, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'available', NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        username,
        encryptSecret(account.password),
        profile?.displayName || null,
        profile?.userId || null,
        profile?.profileUrl || null,
        profile?.avatarUrl || null,
        encryptSecret(''),
        sourceLabel,
        JSON.stringify(metadata),
        actorDiscordId,
        now,
        now
      );
      created += 1;
    }
  }

  return {
    imported: parsed.accounts.length,
    created,
    updated,
    invalidLines: parsed.invalidLines,
    withoutRobloxProfile,
    lookupError
  };
}

export async function importRobloxGeneratorFile({ actorDiscordId = null } = {}) {
  try {
    const text = await fs.readFile(config.robloxGenerator.sourceFile, 'utf8');
    if (!text.trim()) return null;
    return importRobloxGeneratorText({
      text,
      actorDiscordId,
      sourceLabel: config.robloxGenerator.sourceFile
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listRobloxGeneratorAccounts({ search = '', status = '' } = {}) {
  const rows = await db.prepare(`
    SELECT *
    FROM roblox_generator_accounts
    ORDER BY status ASC, username ASC
  `).all();
  const cleanSearch = cleanText(search).toLowerCase();
  const cleanStatus = normalizeStatus(status);
  const shouldFilterStatus = status === 'available' || status === 'in_use';

  return rows
    .filter((row) => !shouldFilterStatus || normalizeStatus(row.status) === cleanStatus)
    .filter((row) => {
      if (!cleanSearch) return true;
      return [row.username, row.display_name, row.user_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanSearch));
    })
    .map((row) => mapStoredAccount(row));
}

export async function getRobloxGeneratorAccount(id, options = {}) {
  const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(id);
  return row ? mapStoredAccount(row, options) : null;
}

export async function selectRobloxGeneratorAccount({ id, actorDiscordId }) {
  const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(id);
  if (!row) {
    const error = new Error('Conta Roblox nao encontrada.');
    error.status = 404;
    throw error;
  }

  if (normalizeStatus(row.status) === 'in_use' && row.selected_by_discord_id !== actorDiscordId) {
    const error = new Error('Conta Roblox ja esta em uso.');
    error.status = 409;
    throw error;
  }

  if (normalizeStatus(row.status) === 'available') {
    const now = nowIso();
    await db.prepare(`
      UPDATE roblox_generator_accounts
      SET status = 'in_use', selected_by_discord_id = ?, selected_at = ?, updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(actorDiscordId, now, now, id);
  }

  return getRobloxGeneratorAccount(id, { includePassword: true });
}

export async function selectRandomRobloxGeneratorAccount({ actorDiscordId }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await db.prepare(`
      SELECT *
      FROM roblox_generator_accounts
      WHERE status = 'available'
      ORDER BY RANDOM()
      LIMIT 1
    `).get();

    if (!row) {
      const error = new Error('Nenhuma conta Roblox disponivel.');
      error.status = 404;
      throw error;
    }

    const now = nowIso();
    const result = await db.prepare(`
      UPDATE roblox_generator_accounts
      SET status = 'in_use', selected_by_discord_id = ?, selected_at = ?, updated_at = ?
      WHERE id = ? AND status = 'available'
    `).run(actorDiscordId, now, now, row.id);

    if ((result?.changes || 0) > 0) {
      return getRobloxGeneratorAccount(row.id, { includePassword: true });
    }
  }

  const error = new Error('Nao foi possivel reservar uma conta agora.');
  error.status = 409;
  throw error;
}

export async function releaseRobloxGeneratorAccount({ id, actorDiscordId, isAdmin = false }) {
  const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(id);
  if (!row) {
    const error = new Error('Conta Roblox nao encontrada.');
    error.status = 404;
    throw error;
  }

  if (!isAdmin && row.selected_by_discord_id && row.selected_by_discord_id !== actorDiscordId) {
    const error = new Error('Apenas quem selecionou pode liberar esta conta.');
    error.status = 403;
    throw error;
  }

  const now = nowIso();
  await db.prepare(`
    UPDATE roblox_generator_accounts
    SET status = 'available', selected_by_discord_id = NULL, selected_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, id);

  return getRobloxGeneratorAccount(id);
}
