import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve('.env');
const examplePath = path.resolve('.env.example');

if (!fs.existsSync(examplePath)) {
  console.error('Arquivo .env.example nao encontrado.');
  process.exit(1);
}

const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.readFileSync(examplePath, 'utf8');

function setEnvValue(content, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(content)) return content.replace(pattern, `${key}=${value}`);
  return `${content.trimEnd()}\n${key}=${value}\n`;
}

function hasUsableValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  const value = match?.[1]?.trim();
  return Boolean(value && !value.startsWith('seu_') && !value.startsWith('base64_') && !value.startsWith('segredo_'));
}

let next = existing;

if (!hasUsableValue(next, 'APP_MASTER_KEY')) {
  next = setEnvValue(next, 'APP_MASTER_KEY', crypto.randomBytes(32).toString('base64'));
}

if (!hasUsableValue(next, 'SESSION_SECRET')) {
  next = setEnvValue(next, 'SESSION_SECRET', crypto.randomBytes(48).toString('base64'));
}

fs.writeFileSync(envPath, next);

console.log('Arquivo .env preparado com chaves seguras.');
console.log('Agora preencha DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET e AUTHORIZED_DISCORD_IDS no .env.');
