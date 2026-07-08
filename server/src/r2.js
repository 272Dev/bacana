import crypto from 'node:crypto';
import { config, hasR2Config } from './config.js';

const REGION = 'auto';
const SERVICE = 's3';

function sha256(value, encoding = 'hex') {
  return crypto.createHash('sha256').update(value).digest(encoding);
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function getEndpoint() {
  const endpoint = config.r2.endpoint || `https://${config.r2.accountId}.r2.cloudflarestorage.com`;
  return endpoint.replace(/\/$/, '');
}

function encodeKey(key) {
  return String(key)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function getSigningKey(dateStamp) {
  const kDate = hmac(`AWS4${config.r2.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

function signedRequest({ method, key, body, contentType }) {
  if (!hasR2Config()) {
    const error = new Error('Cloudflare R2 nao configurado.');
    error.status = 500;
    throw error;
  }

  const endpoint = new URL(getEndpoint());
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body || '');
  const path = `/${config.r2.bucket}/${encodeKey(key)}`;
  const headers = {
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };

  if (contentType) {
    headers['content-type'] = contentType;
  }

  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join('');
  const canonicalRequest = [
    method,
    path,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest)
  ].join('\n');
  const signature = hmac(getSigningKey(dateStamp), stringToSign, 'hex');

  return {
    url: `${endpoint.origin}${path}`,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.r2.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    }
  };
}

export function isR2Enabled() {
  return hasR2Config();
}

export function makeR2Key({ discordId, id, baseName, ext }) {
  return `${discordId}/${id}-${baseName}.${ext}`;
}

export function encodeR2StoredName(key) {
  return `r2:${key}`;
}

export function isR2StoredName(value) {
  return String(value || '').startsWith('r2:');
}

export function decodeR2StoredName(value) {
  return String(value || '').replace(/^r2:/, '');
}

export async function uploadR2Object({ key, buffer, mimeType }) {
  const request = signedRequest({
    method: 'PUT',
    key,
    body: buffer,
    contentType: mimeType
  });
  const response = await fetch(request.url, {
    method: 'PUT',
    headers: request.headers,
    body: buffer
  });
  if (!response.ok) {
    const error = new Error(`Cloudflare R2 recusou o upload (${response.status}).`);
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
}

export async function fetchR2Object(key) {
  const request = signedRequest({ method: 'GET', key });
  const response = await fetch(request.url, {
    method: 'GET',
    headers: request.headers
  });
  if (!response.ok) {
    const error = new Error(`Cloudflare R2 nao encontrou a midia (${response.status}).`);
    error.status = response.status === 404 ? 404 : 502;
    throw error;
  }
  return response;
}

export async function deleteR2Object(key) {
  if (!key || !hasR2Config()) return null;
  const request = signedRequest({ method: 'DELETE', key });
  const response = await fetch(request.url, {
    method: 'DELETE',
    headers: request.headers
  });
  if (!response.ok && response.status !== 404) {
    const error = new Error(`Cloudflare R2 recusou a remocao (${response.status}).`);
    error.status = response.status >= 500 ? 502 : 400;
    throw error;
  }
  return null;
}
