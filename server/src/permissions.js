export const PERMISSIONS = Object.freeze({
  MEDIA_VIEW: 'media.view',
  MEDIA_MANAGE: 'media.manage',
  SALES_USE: 'sales.use',
  SALES_MANAGE: 'sales.manage'
});

export const PERMISSION_CATALOG = Object.freeze([
  { id: PERMISSIONS.MEDIA_VIEW, label: 'Ver midia' },
  { id: PERMISSIONS.MEDIA_MANAGE, label: 'Gerenciar midia' },
  { id: PERMISSIONS.SALES_USE, label: 'Usar bot de vendas' },
  { id: PERMISSIONS.SALES_MANAGE, label: 'Gerenciar estoque de vendas' }
]);

const KNOWN_PERMISSIONS = new Set(PERMISSION_CATALOG.map((item) => item.id));

function parseStoredPermissions(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizePermissions(value) {
  return [...new Set(parseStoredPermissions(value)
    .map((permission) => String(permission || '').trim())
    .filter((permission) => KNOWN_PERMISSIONS.has(permission)))];
}

export function effectivePermissions(authorizedUser) {
  if (!authorizedUser || Number(authorizedUser.active) !== 1) return [];
  if (authorizedUser.role === 'owner') return [...KNOWN_PERMISSIONS];
  const permissions = normalizePermissions(authorizedUser.permissions_json ?? authorizedUser.permissions);
  if (permissions.includes(PERMISSIONS.MEDIA_MANAGE) && !permissions.includes(PERMISSIONS.MEDIA_VIEW)) {
    permissions.push(PERMISSIONS.MEDIA_VIEW);
  }
  return permissions;
}

export function hasPermission(authorizedUser, permission) {
  if (!KNOWN_PERMISSIONS.has(permission)) return false;
  return effectivePermissions(authorizedUser).includes(permission);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user?.permissions?.includes(permission)) {
      return res.status(403).json({ error: 'Voce nao possui permissao para esta area.' });
    }
    next();
  };
}
