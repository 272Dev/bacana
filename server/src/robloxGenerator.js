import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';
import { lookupRobloxPresences, lookupRobloxUsernames } from './roblox.js';

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
const ROBLOX_PROFILE_IMPORT_BATCH_SIZE = 25;
const ROBLOX_PROFILE_IMPORT_RETRIES = 3;
const ROBLOX_GENERATOR_PAGE_SIZE = 24;
const ROBLOX_GENERATOR_MAX_PAGE_SIZE = 80;

function cleanText(value) {
  return String(value || '').trim();
}

const presenceLabels = {
  0: 'Offline',
  1: 'Online',
  2: 'Em jogo',
  3: 'No Studio'
};

function statusFromPresence(presence) {
  const presenceType = Number(presence?.userPresenceType || 0);
  return presenceType > 0 ? 'in_use' : 'available';
}

function labelFromPresence(presenceType, presence) {
  if (presenceType > 0) return presenceLabels[presenceType] || 'Em uso';
  return 'Offline';
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

async function getPresencesForRows(rows) {
  try {
    return await lookupRobloxPresences(rows.map((row) => row.user_id));
  } catch {
    return new Map();
  }
}

function mapStoredAccount(row, { includePassword = false, presence = null } = {}) {
  const passwordResult = includePassword
    ? tryDecryptSecret(row.password_encrypted)
    : { value: null, ok: true };
  const presenceType = Number(presence?.userPresenceType || 0);
  const status = statusFromPresence(presence);

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
    status,
    statusLabel: status === 'in_use' ? 'Em uso' : 'Disponivel',
    presence: {
      type: presenceType,
      label: labelFromPresence(presenceType, presence),
      lastLocation: presence?.lastLocation || '',
      lastOnline: presence?.lastOnline || null,
      placeId: presence?.placeId || null,
      universeId: presence?.universeId || null
    },
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

function normalizePageNumber(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, 0), max);
}

function buildListQuery({ search = '' } = {}) {
  const cleanSearch = cleanText(search).toLowerCase();
  const where = [];
  const params = [];

  if (cleanSearch) {
    const pattern = `%${cleanSearch}%`;
    where.push(`(
      LOWER(username) LIKE ?
      OR LOWER(COALESCE(display_name, '')) LIKE ?
      OR CAST(user_id AS TEXT) LIKE ?
    )`);
    params.push(pattern, pattern, pattern);
  }

  return {
    whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
    params
  };
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

export async function listRobloxGeneratorAccounts({ search = '', status = '', limit, offset } = {}) {
  const pageLimit = normalizePageNumber(limit, ROBLOX_GENERATOR_PAGE_SIZE, ROBLOX_GENERATOR_MAX_PAGE_SIZE) || ROBLOX_GENERATOR_PAGE_SIZE;
  const pageOffset = normalizePageNumber(offset, 0);
  const shouldFilterStatus = status === 'available' || status === 'in_use';
  const { whereSql, params } = buildListQuery({ search });

  if (!shouldFilterStatus) {
    const rows = await db.prepare(`
      SELECT *
      FROM roblox_generator_accounts
      ${whereSql}
      ORDER BY username ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageLimit, pageOffset);
    const totalRow = await db.prepare(`
      SELECT COUNT(*) AS total
      FROM roblox_generator_accounts
      ${whereSql}
    `).get(...params);
    const total = Number(totalRow?.total || 0);
    const presences = await getPresencesForRows(rows);

    return {
      accounts: rows.map((row) => mapStoredAccount(row, { presence: presences.get(String(row.user_id)) || null })),
      page: {
        limit: pageLimit,
        offset: pageOffset,
        nextOffset: pageOffset + rows.length,
        hasMore: pageOffset + rows.length < total,
        total
      }
    };
  }

  const accounts = [];
  let scannedOffset = pageOffset;
  let hasMore = true;

  while (accounts.length < pageLimit && hasMore) {
    const rows = await db.prepare(`
      SELECT *
      FROM roblox_generator_accounts
      ${whereSql}
      ORDER BY username ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageLimit, scannedOffset);

    if (rows.length === 0) {
      hasMore = false;
      break;
    }

    const presences = await getPresencesForRows(rows);
    for (const row of rows) {
      const account = mapStoredAccount(row, { presence: presences.get(String(row.user_id)) || null });
      if (account.status === status) accounts.push(account);
      if (accounts.length >= pageLimit) break;
    }

    scannedOffset += rows.length;
    hasMore = rows.length === pageLimit;
  }

  return {
    accounts,
    page: {
      limit: pageLimit,
      offset: pageOffset,
      nextOffset: scannedOffset,
      hasMore,
      total: null
    }
  };
}

export async function listAllRobloxGeneratorAccounts({ search = '', status = '' } = {}) {
  const rows = await db.prepare(`
    SELECT *
    FROM roblox_generator_accounts
    ORDER BY username ASC
  `).all();
  const presences = await getPresencesForRows(rows);
  const cleanSearch = cleanText(search).toLowerCase();
  const shouldFilterStatus = status === 'available' || status === 'in_use';

  return rows
    .map((row) => mapStoredAccount(row, { presence: presences.get(String(row.user_id)) || null }))
    .filter((account) => !shouldFilterStatus || account.status === status)
    .filter((row) => {
      if (!cleanSearch) return true;
      return [row.username, row.displayName, row.userId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanSearch));
    });
}

export async function getRobloxGeneratorAccount(id, options = {}) {
  const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(id);
  if (!row) return null;
  const presences = await getPresencesForRows([row]);
  return mapStoredAccount(row, {
    ...options,
    presence: presences.get(String(row.user_id)) || null
  });
}

export async function selectRobloxGeneratorAccount({ id }) {
  const row = await db.prepare('SELECT * FROM roblox_generator_accounts WHERE id = ?').get(id);
  if (!row) {
    const error = new Error('Conta Roblox nao encontrada.');
    error.status = 404;
    throw error;
  }

  const presences = await getPresencesForRows([row]);
  const presence = presences.get(String(row.user_id)) || null;
  if (statusFromPresence(presence) === 'in_use') {
    const error = new Error('Conta Roblox ja esta em uso.');
    error.status = 409;
    throw error;
  }

  return mapStoredAccount(row, { includePassword: true, presence });
}

export async function selectRandomRobloxGeneratorAccount() {
  const rows = await db.prepare(`
    SELECT *
    FROM roblox_generator_accounts
    ORDER BY RANDOM()
  `).all();
  if (rows.length === 0) {
    const error = new Error('Nenhuma conta Roblox disponivel.');
    error.status = 404;
    throw error;
  }
  const presences = await getPresencesForRows(rows);
  const availableRows = rows.filter((row) => statusFromPresence(presences.get(String(row.user_id)) || null) === 'available');

  if (availableRows.length === 0) {
    const error = new Error('Nenhuma conta Roblox offline disponivel agora.');
    error.status = 404;
    throw error;
  }

  const row = availableRows[Math.floor(Math.random() * availableRows.length)];
  return mapStoredAccount(row, {
    includePassword: true,
    presence: presences.get(String(row.user_id)) || null
  });
}
