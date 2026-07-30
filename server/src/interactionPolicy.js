export function claimInteractionCooldown(store, key, cooldownMs, now = Date.now()) {
  const until = Number(store.get(key) || 0);
  if (until > now) {
    return { allowed: false, retryAfterMs: until - now };
  }
  const next = now + Math.max(0, Number(cooldownMs || 0));
  store.set(key, next);
  return { allowed: true, retryAfterMs: 0, expiresAt: next };
}

