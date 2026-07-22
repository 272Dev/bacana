import crypto from 'node:crypto';
import { config, missingEnv } from './config.js';
import { db, nowIso } from './db.js';
import { encryptSecret } from './crypto.js';

const RUSHMAIL_DOMAIN = 'rushmail.dev';
const RUSHMAIL_PROVIDER = 'rushmail';
const FIREMAIL_BASE_URL = 'https://firemail.com.br/api';
const FIREMAIL_PROVIDER = 'firemail';
const REQUEST_TIMEOUT_MS = 12_000;

function cleanText(value) {
  return String(value || '').trim();
}

function makeHttpError(message, status = 500, providerStatus = null) {
  const error = new Error(message);
  error.status = status;
  error.providerStatus = providerStatus;
  return error;
}

function sanitizePrefix(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);
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
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractLinks(...values) {
  const text = values.filter(Boolean).join('\n');
  return Array.from(new Set(text.match(/https?:\/\/[^\s<>"')]+/gi) || [])).slice(0, 20);
}

function rushmailConfigured() {
  return !missingEnv(config.rushmail.apiKey);
}

function providerError(payload, response) {
  const rawMessage = cleanText(payload?.error || payload?.message);
  const normalized = rawMessage.toLowerCase();
  const providerStatus = Number(response.status || 502);

  if (providerStatus === 401 || providerStatus === 403) {
    return makeHttpError('A chave da RushMail e invalida ou foi revogada.', 502, providerStatus);
  }
  if (providerStatus === 402 || normalized.includes('credit')) {
    return makeHttpError('A RushMail esta sem creditos. Recarregue a conta no painel da RushMail.', 402, providerStatus);
  }
  if (providerStatus === 429) {
    return makeHttpError('Limite de requisicoes da RushMail atingido. Aguarde um minuto.', 429, providerStatus);
  }
  return makeHttpError(rawMessage || 'Nao foi possivel falar com a RushMail.', providerStatus, providerStatus);
}

async function rushmailRequest(path, { method = 'GET', body } = {}) {
  if (!rushmailConfigured()) {
    throw makeHttpError('RUSHMAIL_API_KEY nao esta configurada no servidor.', 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${config.rushmail.baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        rushmailapikey: config.rushmail.apiKey,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeHttpError('A RushMail demorou demais para responder.', 504);
    }
    throw makeHttpError('Nao foi possivel conectar com a RushMail.', 502);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw makeHttpError('A RushMail retornou uma resposta invalida.', 502, response.status);
  }

  if (!response.ok || payload.success === false) throw providerError(payload, response);
  return payload;
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

function mapRushmailMessage(message) {
  return {
    id: String(message.id),
    subject: message.subject || '(sem assunto)',
    intro: message.preview || '',
    from: {
      address: message.senderEmail || '',
      name: message.senderName || ''
    },
    seen: Boolean(message.read),
    createdAt: normalizeDate(message.createdAt),
    size: 0
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

export function getTempEmailProvider() {
  return RUSHMAIL_PROVIDER;
}

export async function getTempEmailProviderStatus() {
  if (!rushmailConfigured()) {
    return {
      provider: RUSHMAIL_PROVIDER,
      configured: false,
      inboxCount: null,
      inboxLimit: null,
      creditsRemaining: null
    };
  }

  const response = await rushmailRequest('/me');
  const account = response?.data || {};
  return {
    provider: RUSHMAIL_PROVIDER,
    configured: true,
    username: account.username || null,
    inboxCount: Number.isFinite(Number(account.inboxCount)) ? Number(account.inboxCount) : null,
    inboxLimit: Number.isFinite(Number(account.inboxLimit)) ? Number(account.inboxLimit) : null,
    creditsRemaining: Number.isFinite(Number(account.creditsRemaining)) ? Number(account.creditsRemaining) : null
  };
}

export async function listTempEmailDomains() {
  return [{
    id: 'rushmail-default',
    domain: RUSHMAIL_DOMAIN,
    provider: RUSHMAIL_PROVIDER
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
  const requestedPrefix = sanitizePrefix(payload.prefix || payload.label);
  const basePrefix = requestedPrefix && requestedPrefix.length < 4
    ? `${requestedPrefix}${crypto.randomBytes(2).toString('hex')}`
    : requestedPrefix;
  const note = cleanText(payload.label).slice(0, 5000);
  let response = null;
  let lastError = null;

  for (let attempt = 0; attempt < (basePrefix ? 5 : 1); attempt += 1) {
    const suffix = attempt === 0 ? '' : crypto.randomBytes(2).toString('hex');
    try {
      response = await rushmailRequest('/inboxes', {
        method: 'POST',
        body: {
          ...(basePrefix ? { address: `${basePrefix}${suffix}@${RUSHMAIL_DOMAIN}` } : {}),
          ...(note ? { note } : {})
        }
      });
      break;
    } catch (error) {
      lastError = error;
      if (![400, 409, 422].includes(error.status)) throw error;
    }
  }

  if (!response && basePrefix) {
    try {
      response = await rushmailRequest('/inboxes', {
        method: 'POST',
        body: note ? { note } : {}
      });
    } catch {
      throw lastError || makeHttpError('Nao foi possivel criar o email temporario.', 502);
    }
  }

  const remoteInbox = response?.data || {};
  const address = cleanText(remoteInbox.address);
  const providerAccountId = cleanText(remoteInbox.id);
  if (!address || !providerAccountId) {
    throw makeHttpError('A RushMail nao retornou os dados completos da caixa.', 502);
  }

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
    note.slice(0, 120) || null,
    address,
    RUSHMAIL_PROVIDER,
    providerAccountId,
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
  let messages;

  if (row.provider === RUSHMAIL_PROVIDER) {
    const providerAccountId = cleanText(row.provider_account_id);
    if (!providerAccountId) throw makeHttpError('Identificador da caixa RushMail ausente.', 409);
    const response = await rushmailRequest(`/inboxes/${encodeURIComponent(providerAccountId)}`);
    messages = (response?.data?.emails || []).map(mapRushmailMessage);
  } else if (row.provider === FIREMAIL_PROVIDER) {
    const emailName = getEmailName(row.address);
    if (!emailName) throw makeHttpError('Endereco temporario invalido.', 400);
    const response = await firemailRequest(`/email/check/${encodeURIComponent(emailName)}`);
    messages = (response?.data?.messages || []).map(mapFiremailMessage);
  } else {
    throw makeHttpError(`Provedor de email nao suportado: ${row.provider}.`, 409);
  }

  const now = nowIso();
  await db.prepare('UPDATE temp_email_inboxes SET last_checked_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id);
  return messages;
}

export async function getTempEmailMessage({ inboxId, messageId }) {
  const row = await getInboxRow(inboxId);
  let message;
  let mapped;
  let body;

  if (row.provider === RUSHMAIL_PROVIDER) {
    const response = await rushmailRequest(`/emails/${encodeURIComponent(messageId)}`);
    message = response?.data || {};
    if (message.inboxId && row.provider_account_id && message.inboxId !== row.provider_account_id) {
      throw makeHttpError('A mensagem nao pertence a esta caixa.', 403);
    }
    mapped = mapRushmailMessage(message);
    body = message.body || '';
  } else if (row.provider === FIREMAIL_PROVIDER) {
    const emailName = getEmailName(row.address);
    if (!emailName) throw makeHttpError('Endereco temporario invalido.', 400);
    const response = await firemailRequest(`/email/message/${encodeURIComponent(emailName)}/${encodeURIComponent(messageId)}`);
    message = response?.data || {};
    mapped = mapFiremailMessage(message);
    body = message.body || message.text || '';
  } else {
    throw makeHttpError(`Provedor de email nao suportado: ${row.provider}.`, 409);
  }

  const text = stripHtml(body);
  return {
    ...mapped,
    id: String(message.id || messageId),
    text: text || cleanText(body),
    links: extractLinks(text, body)
  };
}

export async function deleteTempEmailInbox(id) {
  const row = await getInboxRow(id);
  if (row.provider === RUSHMAIL_PROVIDER) {
    const providerAccountId = cleanText(row.provider_account_id);
    if (!providerAccountId) throw makeHttpError('Identificador da caixa RushMail ausente.', 409);
    try {
      await rushmailRequest(`/inboxes/${encodeURIComponent(providerAccountId)}`, { method: 'DELETE' });
    } catch (error) {
      if (error.providerStatus !== 404) throw error;
    }
  }

  const result = await db.prepare('DELETE FROM temp_email_inboxes WHERE id = ?').run(id);
  return (result?.changes || 0) > 0;
}
