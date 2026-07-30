export function chatError(message, status = 400, code = 'CHAT_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function sanitizeGlobalChatMessage(value) {
  const text = String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw chatError('Mensagem vazia.', 400, 'CHAT_EMPTY');
  if (text.length > 240) throw chatError('Mensagem muito longa.', 400, 'CHAT_TOO_LONG');
  return text;
}
