import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { encryptSecret, tryDecryptSecret } from './crypto.js';

const MAIL_TM_BASE_URL = 'https://api.mail.tm';
const GUERRILLA_BASE_URL = 'https://api.guerrillamail.com/ajax.php';
const PROVIDER_MAIL_TM = 'mail.tm';
const PROVIDER_GUERRILLA = 'guerrillamail';
const GUERRILLA_DOMAIN = 'guerrillamailblock.com';

function cleanText(value) {
  return String(value || '').trim();
}

function makeHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getCollection(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.['hydra:member'] || payload?.member || payload?.items || [];
}

function mapMailTmError(status, payload) {
  const message = payload?.['hydra:description']
    || payload?.detail
    || payload?.message
    || payload?.title
    || 'Nao foi possivel falar com o servico de email temporario.';
  return makeHttpError(message, status);
}

async function mailTmRequest(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${MAIL_TM_BASE_URL}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw mapMailTmError(response.status, payload);
  return payload;
}

function parseSessionCookie(value) {
  const match = String(value || '').match(/PHPSESSID=([^;,\s]+)/);
  return match?.[1] || '';
}

async function guerrillaRequest(params, { sid } = {}) {
  const url = new URL(GUERRILLA_BASE_URL);
  const body = {
    ip: '127.0.0.1',
    agent: 'Nexus',
    lang: 'en',
    ...params
  };
  Object.entries(body).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      ...(sid ? { Cookie: `PHPSESSID=${sid}` } : {})
    }
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw makeHttpError('Resposta invalida do Guerrilla Mail.', 502);
  }
  if (!response.ok) {
    throw makeHttpError(payload?.error || 'Nao foi possivel falar com o Guerrilla Mail.', response.status);
  }
  return {
    payload,
    sid: payload.sid_token || parseSessionCookie(response.headers.get('set-cookie')) || sid || ''
  };
}

function sanitizePrefix(value) {
  const clean = cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 28);
  return clean || `nexus-${crypto.randomBytes(4).toString('hex')}`;
}

function makePassword() {
  return crypto.randomBytes(24).toString('base64url');
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

function mapMessage(message) {
  const from = message.from || {};
  return {
    id: message.id,
    subject: message.subject || '(sem assunto)',
    intro: message.intro || '',
    from: {
      address: from.address || '',
      name: from.name || ''
    },
    seen: Boolean(message.seen),
    createdAt: message.createdAt || message.created_at || message.updatedAt || null,
    size: message.size || 0
  };
}

function mapGuerrillaMessage(message) {
  return {
    id: String(message.mail_id),
    subject: message.mail_subject || '(sem assunto)',
    intro: message.mail_excerpt || '',
    from: {
      address: message.mail_from || '',
      name: ''
    },
    seen: Boolean(Number(message.mail_read || 0)),
    createdAt: message.mail_timestamp ? new Date(Number(message.mail_timestamp) * 1000).toISOString() : message.mail_date || null,
    size: message.mail_size || 0
  };
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

function normalizeMessageText(message) {
  if (Array.isArray(message.text)) return message.text.filter(Boolean).join('\n\n');
  if (message.text) return String(message.text);
  if (Array.isArray(message.html)) return stripHtml(message.html.filter(Boolean).join('\n\n'));
  if (message.html) return stripHtml(message.html);
  return message.intro || '';
}

function extractLinks(...values) {
  const text = values.filter(Boolean).join('\n');
  return Array.from(new Set(text.match(/https?:\/\/[^\s<>"')]+/gi) || [])).slice(0, 20);
}

async function getInboxRow(id) {
  const row = await db.prepare('SELECT * FROM temp_email_inboxes WHERE id = ?').get(id);
  if (!row) throw makeHttpError('Caixa temporaria nao encontrada.', 404);
  return row;
}

function getGuerrillaSid(row) {
  const tokenResult = tryDecryptSecret(row.token_encrypted);
  if (!tokenResult.ok || !tokenResult.value) {
    throw makeHttpError('Sessao do email temporario nao pode ser descriptografada.', 500);
  }
  return tokenResult.value;
}

async function getToken(row) {
  const tokenResult = tryDecryptSecret(row.token_encrypted);
  if (tokenResult.ok && tokenResult.value) return tokenResult.value;

  const passwordResult = tryDecryptSecret(row.password_encrypted);
  if (!passwordResult.ok || !passwordResult.value) {
    throw makeHttpError('Credenciais do email temporario nao puderam ser descriptografadas.', 500);
  }

  const tokenPayload = await mailTmRequest('/token', {
    method: 'POST',
    body: {
      address: row.address,
      password: passwordResult.value
    }
  });
  const token = tokenPayload.token;
  if (!token) throw makeHttpError('A Mail.tm nao retornou token para esta caixa.', 502);
  await db.prepare('UPDATE temp_email_inboxes SET token_encrypted = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(token), nowIso(), row.id);
  return token;
}

async function requestWithInboxToken(row, path, options = {}) {
  let token = await getToken(row);
  try {
    return await mailTmRequest(path, { ...options, token });
  } catch (error) {
    if (error.status !== 401) throw error;
    const passwordResult = tryDecryptSecret(row.password_encrypted);
    if (!passwordResult.ok || !passwordResult.value) throw error;
    const tokenPayload = await mailTmRequest('/token', {
      method: 'POST',
      body: {
        address: row.address,
        password: passwordResult.value
      }
    });
    token = tokenPayload.token;
    if (!token) throw error;
    await db.prepare('UPDATE temp_email_inboxes SET token_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(encryptSecret(token), nowIso(), row.id);
    return mailTmRequest(path, { ...options, token });
  }
}

export async function listTempEmailDomains() {
  try {
    const payload = await mailTmRequest('/domains');
    const domains = getCollection(payload)
      .filter((domain) => domain?.domain && (domain.isActive == null || domain.isActive))
      .map((domain) => ({
        id: domain.id,
        domain: domain.domain,
        provider: PROVIDER_MAIL_TM
      }));
    if (domains.length > 0) return domains;
  } catch {
    // Mail.tm can be unstable; Guerrilla Mail keeps the feature usable without an API key.
  }
  return [{
    id: 'guerrilla-default',
    domain: GUERRILLA_DOMAIN,
    provider: PROVIDER_GUERRILLA
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
  const domains = await listTempEmailDomains();
  const requestedDomain = cleanText(payload.domain);
  const domainInfo = domains.find((item) => item.domain === requestedDomain) || domains[0];
  const domain = requestedDomain || domainInfo?.domain;
  if (!domain) throw makeHttpError('Nenhum dominio temporario disponivel agora.', 502);

  if (domainInfo?.provider === PROVIDER_GUERRILLA || domain === GUERRILLA_DOMAIN) {
    return createGuerrillaInbox({ payload, actorDiscordId });
  }

  const basePrefix = sanitizePrefix(payload.prefix || payload.label);
  const password = makePassword();
  let account = null;
  let address = '';
  let lastError = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomBytes(2).toString('hex')}`;
    address = `${basePrefix}${suffix}@${domain}`;
    try {
      account = await mailTmRequest('/accounts', {
        method: 'POST',
        body: { address, password }
      });
      break;
    } catch (error) {
      lastError = error;
      if (![400, 409, 422].includes(error.status)) {
        return createGuerrillaInbox({ payload, actorDiscordId });
      }
    }
  }

  if (!account) throw lastError || makeHttpError('Nao foi possivel criar a caixa temporaria.', 502);

  let tokenPayload;
  try {
    tokenPayload = await mailTmRequest('/token', {
      method: 'POST',
      body: { address, password }
    });
  } catch {
    return createGuerrillaInbox({ payload, actorDiscordId });
  }
  if (!tokenPayload.token) return createGuerrillaInbox({ payload, actorDiscordId });

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
    PROVIDER_MAIL_TM,
    account.id || null,
    encryptSecret(password),
    encryptSecret(tokenPayload.token),
    actorDiscordId,
    null,
    now,
    now
  );

  const row = await db.prepare('SELECT * FROM temp_email_inboxes WHERE id = ?').get(id);
  return mapInbox(row);
}

async function createGuerrillaInbox({ payload = {}, actorDiscordId }) {
  const basePrefix = cleanText(payload.prefix || payload.label);
  let result = await guerrillaRequest({ f: 'get_email_address' });

  if (basePrefix) {
    result = await guerrillaRequest({
      f: 'set_email_user',
      email_user: sanitizePrefix(basePrefix)
    }, { sid: result.sid });
  }

  const address = result.payload.email_addr;
  if (!address) throw makeHttpError('O Guerrilla Mail nao retornou um endereco temporario.', 502);

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
    PROVIDER_GUERRILLA,
    result.payload.alias || result.sid || null,
    encryptSecret(''),
    encryptSecret(result.sid),
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
  if (row.provider === PROVIDER_GUERRILLA) {
    const result = await guerrillaRequest({ f: 'check_email', seq: 0 }, { sid: getGuerrillaSid(row) });
    const now = nowIso();
    await db.prepare('UPDATE temp_email_inboxes SET last_checked_at = ?, token_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(now, encryptSecret(result.sid), now, id);
    return (result.payload.list || []).map(mapGuerrillaMessage);
  }

  const payload = await requestWithInboxToken(row, '/messages');
  const now = nowIso();
  await db.prepare('UPDATE temp_email_inboxes SET last_checked_at = ?, updated_at = ? WHERE id = ?')
    .run(now, now, id);
  return getCollection(payload).map(mapMessage);
}

export async function getTempEmailMessage({ inboxId, messageId }) {
  const row = await getInboxRow(inboxId);
  if (row.provider === PROVIDER_GUERRILLA) {
    const result = await guerrillaRequest({
      f: 'fetch_email',
      email_id: messageId
    }, { sid: getGuerrillaSid(row) });
    await db.prepare('UPDATE temp_email_inboxes SET token_encrypted = ?, updated_at = ? WHERE id = ?')
      .run(encryptSecret(result.sid), nowIso(), inboxId);
    const message = result.payload;
    const text = stripHtml(message.mail_body || message.mail_excerpt || '');
    return {
      id: String(message.mail_id || messageId),
      subject: message.mail_subject || '(sem assunto)',
      intro: message.mail_excerpt || '',
      from: {
        address: message.mail_from || '',
        name: ''
      },
      seen: true,
      createdAt: message.mail_timestamp ? new Date(Number(message.mail_timestamp) * 1000).toISOString() : message.mail_date || null,
      size: message.mail_size || 0,
      text,
      links: extractLinks(text, message.mail_body)
    };
  }

  const message = await requestWithInboxToken(row, `/messages/${encodeURIComponent(messageId)}`);
  const text = normalizeMessageText(message);
  const htmlText = Array.isArray(message.html) ? stripHtml(message.html.join('\n\n')) : stripHtml(message.html || '');
  return {
    ...mapMessage(message),
    text,
    links: extractLinks(text, htmlText, message.intro)
  };
}

export async function deleteTempEmailInbox(id) {
  const row = await getInboxRow(id);
  const result = await db.prepare('DELETE FROM temp_email_inboxes WHERE id = ?').run(id);

  if (row.provider === PROVIDER_GUERRILLA) {
    guerrillaRequest({ f: 'forget_me', email_addr: row.address }, { sid: getGuerrillaSid(row) })
      .catch(() => {});
  } else if (row.provider_account_id) {
    requestWithInboxToken(row, `/accounts/${encodeURIComponent(row.provider_account_id)}`, { method: 'DELETE' })
      .catch(() => {});
  }

  return (result?.changes || 0) > 0;
}
