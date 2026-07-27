import { config, missingEnv } from './config.js';

const REQUEST_TIMEOUT_MS = 12_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;

let cachedToken = null;
let tokenRequest = null;

function cleanText(value) {
  return String(value || '').trim();
}

function makeLivePixError(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function configurationError() {
  const missing = [];
  if (missingEnv(config.livePix.clientId)) missing.push('LIVEPIX_CLIENT_ID');
  if (missingEnv(config.livePix.clientSecret)) missing.push('LIVEPIX_CLIENT_SECRET');
  if (missing.length === 0) return null;
  return makeLivePixError(
    `LivePix ainda nao configurada: ${missing.join(' e ')}.`,
    'LIVEPIX_NOT_CONFIGURED',
    503
  );
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw makeLivePixError('A LivePix retornou uma resposta invalida.', 'LIVEPIX_INVALID_RESPONSE');
  }
}

function providerError(response, payload) {
  const providerMessage = cleanText(payload?.message || payload?.error_description || payload?.error);
  if (response.status === 400 && /scope/i.test(providerMessage)) {
    return makeLivePixError(
      'A aplicacao LivePix precisa da permissao payments:write.',
      'LIVEPIX_INVALID_SCOPE',
      503
    );
  }
  if (response.status === 401) {
    return makeLivePixError(
      'As credenciais da LivePix sao invalidas ou foram revogadas.',
      'LIVEPIX_INVALID_CREDENTIALS',
      503
    );
  }
  if (response.status === 403) {
    return makeLivePixError(
      'A aplicacao LivePix nao possui permissao para criar pagamentos.',
      'LIVEPIX_FORBIDDEN',
      503
    );
  }
  if (response.status === 429) {
    return makeLivePixError(
      'O limite de cobrancas da LivePix foi atingido. Aguarde um minuto.',
      'LIVEPIX_RATE_LIMITED',
      429
    );
  }
  if (response.status === 422) {
    return makeLivePixError(
      providerMessage || 'A LivePix recusou os dados desta cobranca.',
      'LIVEPIX_VALIDATION_ERROR',
      422
    );
  }
  return makeLivePixError(
    providerMessage || 'Nao foi possivel gerar a cobranca na LivePix.',
    'LIVEPIX_PROVIDER_ERROR',
    response.status >= 400 && response.status < 600 ? response.status : 502
  );
}

async function livePixFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeLivePixError('A LivePix demorou demais para responder.', 'LIVEPIX_TIMEOUT', 504);
    }
    throw makeLivePixError('Nao foi possivel conectar com a LivePix.', 'LIVEPIX_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAccessToken() {
  const missing = configurationError();
  if (missing) throw missing;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.livePix.clientId,
    client_secret: config.livePix.clientSecret,
    scope: config.livePix.scope
  });
  const response = await livePixFetch(config.livePix.oauthUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const payload = await parseJsonResponse(response);
  if (!response.ok) throw providerError(response, payload);

  const accessToken = cleanText(payload.access_token);
  const expiresIn = Number(payload.expires_in || 3600);
  if (!accessToken) {
    throw makeLivePixError('A LivePix nao retornou um token de acesso.', 'LIVEPIX_INVALID_TOKEN_RESPONSE');
  }

  cachedToken = {
    value: accessToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
  };
  return cachedToken.value;
}

async function getAccessToken({ force = false } = {}) {
  if (!force && cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.value;
  }
  if (tokenRequest) return tokenRequest;

  tokenRequest = requestAccessToken().finally(() => {
    tokenRequest = null;
  });
  return tokenRequest;
}

function normalizeRedirectUrl() {
  let parsed;
  try {
    parsed = new URL(config.livePix.redirectUrl);
  } catch {
    throw makeLivePixError('LIVEPIX_REDIRECT_URL nao e uma URL valida.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeLivePixError('LIVEPIX_REDIRECT_URL precisa usar HTTP ou HTTPS.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  return parsed.href;
}

function normalizeCheckoutUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw makeLivePixError('A LivePix nao retornou um checkout valido.', 'LIVEPIX_INVALID_CHECKOUT');
  }
  const trustedHost = parsed.hostname === 'livepix.gg' || parsed.hostname.endsWith('.livepix.gg');
  if (parsed.protocol !== 'https:' || !trustedHost) {
    throw makeLivePixError('A LivePix retornou um checkout nao confiavel.', 'LIVEPIX_UNTRUSTED_CHECKOUT');
  }
  return parsed.href;
}

async function createPaymentRequest(amountCents, accessToken) {
  const response = await livePixFetch(`${config.livePix.apiUrl}/v2/payments`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountCents,
      currency: 'BRL',
      redirectUrl: normalizeRedirectUrl()
    })
  });
  const payload = await parseJsonResponse(response);
  return { response, payload };
}

export function isLivePixConfigured() {
  return configurationError() === null;
}

export async function createLivePixPayment(amountCents) {
  const normalizedAmount = Number(amountCents);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 100 || normalizedAmount > 10_000_000) {
    throw makeLivePixError(
      'O valor deve estar entre R$ 1,00 e R$ 100.000,00.',
      'LIVEPIX_INVALID_AMOUNT',
      400
    );
  }

  let accessToken = await getAccessToken();
  let result = await createPaymentRequest(normalizedAmount, accessToken);
  if (result.response.status === 401) {
    cachedToken = null;
    accessToken = await getAccessToken({ force: true });
    result = await createPaymentRequest(normalizedAmount, accessToken);
  }
  if (!result.response.ok) throw providerError(result.response, result.payload);

  const reference = cleanText(result.payload?.data?.reference);
  const checkoutUrl = normalizeCheckoutUrl(result.payload?.data?.redirectUrl);
  if (!reference) {
    throw makeLivePixError('A LivePix nao retornou a referencia da cobranca.', 'LIVEPIX_INVALID_PAYMENT');
  }

  return {
    reference,
    checkoutUrl,
    amountCents: normalizedAmount,
    currency: 'BRL'
  };
}
