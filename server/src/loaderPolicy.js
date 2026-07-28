function policyError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

export function assertLoaderTicketEligible(ticket, input, {
  now = Date.now(),
  maxAttempts = 5
} = {}) {
  if (!ticket) policyError('Ticket inválido.', 401, 'TICKET_INVALID');
  if (Number(ticket.attempts || 0) > Number(maxAttempts || 5)) {
    policyError('Muitas tentativas para este ticket.', 429, 'RATE_LIMITED');
  }
  if (Number(ticket.used) === 1) {
    policyError('Este ticket já foi utilizado.', 409, 'TICKET_USED');
  }
  if (ticket.invalidated_at) {
    policyError('Este ticket não está mais ativo.', 401, 'TICKET_INVALID');
  }
  if (!Number.isFinite(Date.parse(ticket.expires_at)) || Date.parse(ticket.expires_at) <= now) {
    policyError('Este ticket expirou.', 401, 'TICKET_EXPIRED');
  }
  if (ticket.license_expires_at && Date.parse(ticket.license_expires_at) <= now) {
    policyError('A licença expirou.', 403, 'LICENSE_EXPIRED');
  }
  if (ticket.license_status !== 'active') {
    policyError(
      ticket.license_status === 'suspended' ? 'A licença está suspensa.' : 'A licença não está ativa.',
      403,
      ticket.license_status === 'suspended' ? 'LICENSE_SUSPENDED' : 'LICENSE_NOT_FOUND'
    );
  }
  if (Number(ticket.active) !== 1 || ticket.version !== input.releaseVersion) {
    policyError('Esta versão não está mais ativa.', 410, 'VERSION_INACTIVE');
  }
  if (ticket.hwid_hash !== input.hwidHash || ticket.nonce_hash !== input.nonceHash) {
    policyError('O ticket não pertence a este dispositivo.', 403, 'TICKET_INVALID');
  }
  if (ticket.roblox_user_id && ticket.roblox_user_id !== input.robloxUserId) {
    policyError('O ticket não pertence a esta conta Roblox.', 403, 'TICKET_INVALID');
  }
  return true;
}

