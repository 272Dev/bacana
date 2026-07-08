const fallbackApi = 'http://localhost:4000/api';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || fallbackApi).replace(/\/$/, '');
export const API_ORIGIN = API_BASE.replace(/\/api$/, '');
export const DISCORD_LOGIN_URL = `${API_ORIGIN}/api/auth/discord`;

export async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || 'Nao foi possivel concluir a acao.');
    error.status = response.status;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

export function formatDate(value) {
  if (!value) return 'Nunca';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}
