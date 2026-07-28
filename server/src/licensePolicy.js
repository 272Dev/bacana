export function normalizeLicenseKeyInput(value) {
  const compact = String(value || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
  const withoutSeparators = compact.replaceAll('-', '');
  if (/^NXS[A-Z0-9]{20}$/.test(withoutSeparators)) {
    const body = withoutSeparators.slice(3);
    return `NXS-${body.match(/.{1,5}/g).join('-')}`;
  }
  return compact;
}

export function validateLicenseRedeemState(row, discordId, now = Date.now()) {
  if (!row) return { ok: false, code: 'KEY_INVALID', status: 404, message: 'Key inválida ou indisponível.' };
  if (row.expires_at && Date.parse(row.expires_at) <= now) {
    return { ok: false, code: 'LICENSE_EXPIRED', status: 403, message: 'Esta licença expirou.' };
  }
  if (row.status === 'suspended') {
    return { ok: false, code: 'LICENSE_SUSPENDED', status: 403, message: 'Esta licença está suspensa.' };
  }
  if (row.status !== 'active') {
    return { ok: false, code: 'KEY_INVALID', status: 403, message: 'Key inválida ou indisponível.' };
  }
  if (row.discord_id && row.discord_id !== discordId) {
    return { ok: false, code: 'LICENSE_ALREADY_LINKED', status: 409, message: 'Esta licença já está vinculada.' };
  }
  return { ok: true };
}

export function uniqueSecurityEvents(events, field) {
  const seenNonces = new Set();
  const seenValues = new Set();
  const accepted = [];
  for (const event of events || []) {
    const nonce = String(event.request_nonce_hash || '').trim();
    if (nonce && seenNonces.has(nonce)) continue;
    if (nonce) seenNonces.add(nonce);
    const normalized = String(event?.[field] || '').normalize('NFKC').trim().toLowerCase();
    if (!normalized || seenValues.has(normalized)) continue;
    seenValues.add(normalized);
    accepted.push(event);
  }
  return accepted;
}

