import crypto from 'node:crypto';
import { config, missingEnv } from './config.js';
import { signBotApiRequest } from './botApiAuth.js';

export async function botApiRequest(path, { method = 'GET', body, operationId = crypto.randomUUID() } = {}) {
  if (missingEnv(config.discordBot.apiSecret) || config.discordBot.apiSecret.length < 32) {
    const error = new Error('Configure NEXUS_BOT_API_SECRET no servidor.');
    error.code = 'BOT_AUTH_NOT_CONFIGURED';
    throw error;
  }
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const serialized = body == null ? '' : JSON.stringify(body);
  const headers = {
    Accept: 'application/json',
    ...signBotApiRequest({ method, path: normalizedPath, body: serialized, operationId })
  };
  if (serialized) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${config.discordBot.apiUrl}${normalizedPath}`, {
      method,
      headers,
      body: serialized || undefined,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.message || 'Falha temporaria na API Nexus.');
      error.status = response.status;
      error.code = payload.code || 'INTERNAL_ERROR';
      error.requestId = payload.requestId;
      error.retryAfterSeconds = payload.retryAfterSeconds;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('A API Nexus demorou para responder.');
      timeoutError.code = 'API_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
