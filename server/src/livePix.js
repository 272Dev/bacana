import { config, missingEnv } from './config.js';
import { createQrPng } from './qrCode.js';

const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUIRED_SCOPES = ['payments:read', 'payments:write', 'webhooks'];
let cachedToken = null;
let tokenRequest = null;

function cleanText(value) {
  return String(value || '').trim();
}

function makeError(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function isLivePixConfigured() {
  return !missingEnv(config.livePix.clientId) && !missingEnv(config.livePix.clientSecret);
}

function configurationError() {
  const missing = [];
  if (missingEnv(config.livePix.clientId)) missing.push('LIVEPIX_CLIENT_ID');
  if (missingEnv(config.livePix.clientSecret)) missing.push('LIVEPIX_CLIENT_SECRET');
  if (!missing.length) return null;
  return makeError(
    `LivePix ainda nao configurada: ${missing.join(' e ')}.`,
    'LIVEPIX_NOT_CONFIGURED',
    503
  );
}

async function parseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw makeError('A LivePix retornou uma resposta invalida.', 'LIVEPIX_INVALID_RESPONSE');
  }
}

function providerError(response, payload, operation = 'processar esta operacao') {
  const providerMessage = cleanText(payload?.message || payload?.error_description || payload?.error);
  if (response.status === 400 && /scope/i.test(providerMessage)) {
    return makeError(
      'A aplicacao LivePix precisa dos escopos payments:read, payments:write e webhooks.',
      'LIVEPIX_INVALID_SCOPE',
      503
    );
  }
  if (response.status === 401) {
    return makeError(
      'As credenciais da LivePix sao invalidas ou foram revogadas.',
      'LIVEPIX_INVALID_CREDENTIALS',
      503
    );
  }
  if (response.status === 403) {
    return makeError(
      `A aplicacao LivePix nao possui permissao para ${operation}.`,
      'LIVEPIX_FORBIDDEN',
      503
    );
  }
  if (response.status === 404) {
    return makeError('Pagamento nao encontrado na LivePix.', 'LIVEPIX_PAYMENT_NOT_FOUND', 404);
  }
  if (response.status === 429) {
    return makeError(
      'O limite de requisicoes da LivePix foi atingido. Aguarde um minuto.',
      'LIVEPIX_RATE_LIMITED',
      429
    );
  }
  if (response.status === 422) {
    return makeError(
      providerMessage || 'A LivePix recusou os dados enviados.',
      'LIVEPIX_VALIDATION_ERROR',
      422
    );
  }
  return makeError(
    providerMessage || `Nao foi possivel ${operation} na LivePix.`,
    'LIVEPIX_PROVIDER_ERROR',
    response.status >= 400 && response.status < 600 ? response.status : 502
  );
}

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeError('A LivePix demorou demais para responder.', 'LIVEPIX_TIMEOUT', 504);
    }
    throw makeError('Nao foi possivel conectar com a LivePix.', 'LIVEPIX_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAccessToken() {
  const missing = configurationError();
  if (missing) throw missing;

  const scopes = new Set(cleanText(config.livePix.scope).split(/\s+/).filter(Boolean));
  for (const scope of REQUIRED_SCOPES) scopes.add(scope);
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.livePix.clientId,
    client_secret: config.livePix.clientSecret,
    scope: [...scopes].join(' ')
  });
  const response = await timedFetch(config.livePix.oauthUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const payload = await parseJson(response);
  if (!response.ok) throw providerError(response, payload, 'autenticar');

  const accessToken = cleanText(payload.access_token);
  const expiresIn = Number(payload.expires_in || 3600);
  if (!accessToken) {
    throw makeError('A LivePix nao retornou um token de acesso.', 'LIVEPIX_INVALID_TOKEN_RESPONSE');
  }

  cachedToken = {
    value: accessToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
  };
  return cachedToken.value;
}

async function getAccessToken({ force = false } = {}) {
  if (
    !force
    && cachedToken
    && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.value;
  }
  if (tokenRequest) return tokenRequest;
  tokenRequest = requestAccessToken().finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

async function authenticatedRequest(pathname, options = {}, operation = 'consultar a API') {
  let accessToken = await getAccessToken();
  const run = (token) => timedFetch(`${config.livePix.apiUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });

  let response = await run(accessToken);
  if (response.status === 401) {
    cachedToken = null;
    accessToken = await getAccessToken({ force: true });
    response = await run(accessToken);
  }
  const payload = await parseJson(response);
  if (!response.ok) throw providerError(response, payload, operation);
  return payload;
}

function normalizeRedirectUrl() {
  let parsed;
  let publicReturn;
  try {
    parsed = new URL(config.livePix.redirectUrl);
    publicReturn = new URL('/api/payments/livepix/return', config.apiPublicUrl);
  } catch {
    throw makeError('LIVEPIX_REDIRECT_URL nao e uma URL valida.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeError('LIVEPIX_REDIRECT_URL precisa usar HTTP ou HTTPS.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  if (
    parsed.origin === publicReturn.origin
    && (parsed.pathname === '/' || parsed.pathname === '')
  ) {
    return publicReturn.href;
  }
  return parsed.href;
}

export function normalizeLivePixCheckoutUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw makeError('A LivePix nao retornou um checkout valido.', 'LIVEPIX_INVALID_CHECKOUT');
  }
  const trustedHost = parsed.hostname === 'livepix.gg' || parsed.hostname.endsWith('.livepix.gg');
  if (parsed.protocol !== 'https:' || !trustedHost) {
    throw makeError('A LivePix retornou um checkout nao confiavel.', 'LIVEPIX_UNTRUSTED_CHECKOUT');
  }
  return parsed.href;
}

export async function createLivePixQrCode(checkoutUrl) {
  const trustedCheckoutUrl = normalizeLivePixCheckoutUrl(checkoutUrl);
  try {
    return await createQrPng(trustedCheckoutUrl, {
      scale: 10,
      margin: 4,
      errorCorrectionLevel: 'H'
    });
  } catch {
    throw makeError(
      'A cobranca foi criada, mas nao foi possivel montar o QR Code.',
      'LIVEPIX_QR_GENERATION_FAILED'
    );
  }
}

export async function createLivePixPayment(amountCents) {
  const normalizedAmount = Number(amountCents);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 100 || normalizedAmount > 10_000_000) {
    throw makeError(
      'O valor deve estar entre R$ 1,00 e R$ 100.000,00.',
      'LIVEPIX_INVALID_AMOUNT',
      400
    );
  }

  const payload = await authenticatedRequest('/v2/payments', {
    method: 'POST',
    body: JSON.stringify({
      amount: normalizedAmount,
      currency: 'BRL',
      redirectUrl: normalizeRedirectUrl()
    })
  }, 'criar pagamentos');

  const reference = cleanText(payload?.data?.reference);
  const checkoutUrl = normalizeLivePixCheckoutUrl(payload?.data?.redirectUrl);
  if (!reference) {
    throw makeError('A LivePix nao retornou a referencia da cobranca.', 'LIVEPIX_INVALID_PAYMENT');
  }
  return {
    reference,
    checkoutUrl,
    amountCents: normalizedAmount,
    currency: 'BRL'
  };
}

function normalizeReceivedPayment(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    id: cleanText(value.id),
    proof: cleanText(value.proof),
    reference: cleanText(value.reference),
    amountCents: Number(value.amount),
    currency: cleanText(value.currency).toUpperCase(),
    createdAt: cleanText(value.createdAt) || null
  };
}

export async function getLivePixReceivedPayment(paymentId) {
  const id = encodeURIComponent(cleanText(paymentId));
  if (!id) return null;
  try {
    const payload = await authenticatedRequest(`/v2/payments/${id}`, {}, 'consultar pagamentos');
    return normalizeReceivedPayment(payload?.data);
  } catch (error) {
    if (error?.code === 'LIVEPIX_PAYMENT_NOT_FOUND') return null;
    throw error;
  }
}

export async function findLivePixReceivedPayment(reference) {
  const normalizedReference = cleanText(reference);
  if (!normalizedReference) return null;
  const query = new URLSearchParams({ reference: normalizedReference, page: '1', limit: '20' });
  const payload = await authenticatedRequest(`/v2/payments?${query}`, {}, 'consultar pagamentos');
  const payments = Array.isArray(payload?.data) ? payload.data : [];
  return payments
    .map(normalizeReceivedPayment)
    .find((payment) => payment?.reference === normalizedReference) || null;
}

export function getLivePixWebhookUrl() {
  const configured = cleanText(config.livePix.webhookUrl);
  const candidate = configured || new URL('/api/webhooks/livepix', config.apiPublicUrl).href;
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeError('A URL do webhook LivePix precisa usar HTTP ou HTTPS.', 'LIVEPIX_INVALID_WEBHOOK', 503);
  }
  if (config.nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw makeError('O webhook LivePix precisa usar HTTPS em producao.', 'LIVEPIX_INSECURE_WEBHOOK', 503);
  }
  return parsed.href;
}

export async function ensureLivePixWebhook() {
  if (!isLivePixConfigured()) return { configured: false, reason: 'missing_credentials' };
  const webhookUrl = getLivePixWebhookUrl();
  const query = new URLSearchParams({ page: '1', limit: '100' });
  const listed = await authenticatedRequest(`/v2/webhooks?${query}`, {}, 'consultar webhooks');
  const webhooks = Array.isArray(listed?.data) ? listed.data : [];
  const existing = webhooks.find((webhook) => cleanText(webhook?.url) === webhookUrl);
  if (existing) {
    return { configured: true, created: false, id: cleanText(existing.id), url: webhookUrl };
  }

  const created = await authenticatedRequest('/v2/webhooks', {
    method: 'POST',
    body: JSON.stringify({ url: webhookUrl })
  }, 'criar webhooks');
  return {
    configured: true,
    created: true,
    id: cleanText(created?.data?.id),
    url: webhookUrl
  };
}
