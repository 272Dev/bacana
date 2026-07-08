import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { encryptSecret } from './crypto.js';

const FIREMAIL_BASE_URL = 'https://firemail.com.br/api';
const FIREMAIL_DOMAIN = 'firemail.com.br';
const PROVIDER = 'firemail';

function cleanText(value) {
  return String(value || '').trim();
}

function makeHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sanitizePrefix(value) {
  const clean = cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 40);
  return clean || '';
}

function getEmailName(address) {
  return cleanText(address).split('@')[0] || '';
}

function normalizeDate(value, timestamp) {
  if (timestamp) return new Date(Number(timestamp) * 1000).toISOString();
  if (!value) return null;
  const normalized = String(value).replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stripHtml(value) {
  return cleanText(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractLinks(...values) {
  const text = values.filter(Boolean).join('\n');
  return Array.from(new Set(text.match(/https?:\/\/[^\s<>"')]+/gi) || [])).slice(0, 20);
}

async function firemailRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${FIREMAIL_BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw makeHttpError('Resposta invalida da Firemail.', 502);
  }

  if (!response.ok || payload.status === 'error') {
    throw makeHttpError(payload.message || 'Nao foi possivel falar com a Firemail.', response.status || payload.code || 502);
  }
  return payload;
}

function mapInbox(row) {
  return {
    id: row.id,
    label: row.label || '',
    address: row.address,
    provider: row.provider,
    createdBy: row.created_by,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFiremailMessage(message) {
  const from = message.from || {};
  return {
    id: String(message.id),
    subject: message.subject || '(sem assunto)',
    intro: message.preview || message.excerpt || '',
    from: {
      address: from.email || from.address || '',
      name: from.name || ''
    },
    seen: false,
    createdAt: normalizeDate(message.date, message.timestamp),
    size: message.size || 0
  };
}

async function getInboxRow(id) {
  const row = await db.prepare('SELECT * FROM temp_email_inboxes WHERE id = ?').get(id);
  if (!row) throw makeHttpError('Caixa temporaria nao encontrada.', 404);
  return row;
}

export async function listTempEmailDomains() {
  return [{
    id: 'firemail-default',
    domain: FIREMAIL_DOMAIN,
    provider: PROVIDER
  }];
}

export async function listTempEmailInboxes({ search = '' } = {}) {
  const rows = await db.prepare(`
    SELECT *
    FROM temp_email_inboxes
    ORDER BY updated_at DESC, address ASC
  `).all();
  const cleanSearch = cleanText(search).toLowerCase();
  return rows
    .filter((row) => {
      if (!cleanSearch) return true;
      return [row.label, row.address, row.provider].filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(cleanSearch));
    })
    .map(mapInbox);
}

export async function createTempEmailInbox({ payload = {}, actorDiscordId }) {
  const email = sanitizePrefix(payload.prefix || payload.label);
  let response = null;
  let lastError = null;

  if (!email) {
    response = await firemailRequest('/email/create', { method: 'POST' });
  } else {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = attempt === 0 ? '' : `-${crypto.randomBytes(2).toString('hex')}`;
      try {
        response = await firemailRequest('/email/create', {
          method: 'POST',
          body: { email: `${email}${suffix}` }
        });
        break;
      } catch (error) {
        lastError = error;
        if (![400, 409, 422].includes(error.status)) throw error;
      }
    }
  }

  if (!response) throw lastError || makeHttpError('Nao foi possivel criar o email temporario.', 502);
  const address = response?.data?.email;
  if (!address) throw makeHttpError('A Firemail nao retornou um endereco temporario.', 502);

  const id = crypto.randomUUID();
  const now = nowIso();
  await db.prepare(`
    INSERT INTO temp_email_inboxes (
      id, label, address, provider, provider_account_id, password_encrypted, token_encrypted,
      created_by, last_checked_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    cleanText(payload.label).slice(0, 120) || null,
    address,
    PROVIDER,
    getEmailName(address),
    encryptSecret(''),
    encryptSecret(''),
    actorDiscordId,
    null,
    now,
    now
  );

  const row = await db.prepare('SELECT * FROM temp_email_inboxes WHERE id = ?').get(id);
  return mapInbox(row);
}

export async function listTempEmailMessages(id) {
  const row = await getInboxRow(id);
  const emailName = getEmailName(row.address);
  if (!emailName) throw makeHttpError('Endereco temporario invalido.', 400);

  const response = await firemailRequest(`/email/check/${encodeURIComponent(emailName)}`);
  const now = nowIso();
  await db.prepare('UPDATE temp_email_inboxes SET last_checked_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id);

  return (response?.data?.messages || []).map(mapFiremailMessage);
}

export async function getTempEmailMessage({ inboxId, messageId }) {
  const row = await getInboxRow(inboxId);
  const emailName = getEmailName(row.address);
  if (!emailName) throw makeHttpError('Endereco temporario invalido.', 400);

  const response = await firemailRequest(`/email/message/${encodeURIComponent(emailName)}/${encodeURIComponent(messageId)}`);
  const message = response?.data || {};
  const body = message.body || message.text || '';
  const text = stripHtml(body);
  const mapped = mapFiremailMessage(message);

  return {
    ...mapped,
    id: String(message.id || messageId),
    text: text || cleanText(body),
    links: extractLinks(text, body)
  };
}

export async function deleteTempEmailInbox(id) {
  await getInboxRow(id);
  const result = await db.prepare('DELETE FROM temp_email_inboxes WHERE id = ?').run(id);
  return (result?.changes || 0) > 0;
}
