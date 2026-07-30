const robloxUserIdPattern = /^[1-9]\d{0,19}$/;
const placeIdPattern = /^[1-9]\d{0,19}$/;
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRobloxUserId(value) {
  return robloxUserIdPattern.test(String(value || '').trim());
}

export function isValidPlaceId(value) {
  return placeIdPattern.test(String(value || '').trim());
}

export function isValidJobId(value) {
  return jobIdPattern.test(String(value || '').trim());
}

// The public discovery response deliberately excludes the raw Roblox JobId.
// That session identifier remains server-side for an explicitly authorized
// integration owned by the experience creator.
export function mapPublicPresence(row) {
  if (!row) return null;
  return {
    robloxUserId: String(row.roblox_user_id),
    username: row.roblox_username || null,
    displayName: row.roblox_display_name || row.roblox_username || 'Nexus User',
    placeId: String(row.place_id),
    sessionAvailable: Boolean(row.job_id)
  };
}

export function isPresenceLive(row, now = Date.now()) {
  const expiresAt = Date.parse(String(row?.expires_at || ''));
  return Number.isFinite(expiresAt) && expiresAt > now;
}
