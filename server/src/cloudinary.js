import crypto from 'node:crypto';
import { config, hasCloudinaryConfig } from './config.js';

function signParams(params) {
  const payload = Object.entries(params)
    .filter(([key, value]) => key !== 'file' && value !== undefined && value !== null && value !== '')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(`${payload}${config.cloudinary.apiSecret}`)
    .digest('hex');
}

async function callCloudinary(resourceType, action, params) {
  if (!hasCloudinaryConfig()) {
    const error = new Error('Cloudinary nao configurado.');
    error.status = 500;
    throw error;
  }

  const form = new FormData();
  const signedParams = {
    ...params,
    timestamp: Math.floor(Date.now() / 1000)
  };
  const signature = signParams(signedParams);

  for (const [key, value] of Object.entries(signedParams)) {
    if (value !== undefined && value !== null && value !== '') {
      form.set(key, String(value));
    }
  }
  form.set('api_key', config.cloudinary.apiKey);
  form.set('signature', signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/${resourceType}/${action}`, {
    method: 'POST',
    body: form
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload.error?.message || 'Cloudinary recusou a midia.');
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }

  return payload;
}

export function isCloudinaryEnabled() {
  return hasCloudinaryConfig();
}

export async function uploadCloudinaryMedia({ dataUrl, publicId, resourceType = 'image' }) {
  const params = {
    file: dataUrl,
    public_id: publicId,
    overwrite: false
  };

  if (config.cloudinary.folder) {
    params.folder = config.cloudinary.folder;
  }

  return callCloudinary(resourceType, 'upload', params);
}

export async function destroyCloudinaryMedia(publicId, resourceType = 'image') {
  if (!publicId || !hasCloudinaryConfig()) return null;
  return callCloudinary(resourceType, 'destroy', { public_id: publicId, invalidate: true });
}
