import { config, missingEnv } from './config.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;

function makeHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value) {
  return String(value || '').trim();
}

function getBotToken(inputToken = '') {
  const token = cleanText(inputToken) || config.discordBot.token;
  if (!token || missingEnv(token)) {
    throw makeHttpError('Configure DISCORD_BOT_TOKEN no backend ou informe um token temporario.', 400);
  }
  return token;
}

function assertSnowflake(id, label = 'ID') {
  const clean = cleanText(id);
  if (!/^\d{5,32}$/.test(clean)) throw makeHttpError(`${label} invalido.`, 400);
  return clean;
}

const DISCORD_WEBHOOK_HOSTS = new Set([
  'discord.com',
  'discordapp.com',
  'canary.discord.com',
  'ptb.discord.com'
]);

function normalizeWebhookUrl(rawUrl) {
  let clean = cleanText(rawUrl).replace(/^<|>$/g, '');
  if (!/^https?:\/\//i.test(clean) && /^(discord|canary\.discord|ptb\.discord|discordapp)\.com\//i.test(clean)) {
    clean = `https://${clean}`;
  }

  try {
    const parsed = new URL(clean);
    const hostname = parsed.hostname.toLowerCase();
    const parts = parsed.pathname.split('/').filter(Boolean);
    const isDiscordHost = DISCORD_WEBHOOK_HOSTS.has(hostname);
    const isWebhookPath = parts[0] === 'api'
      && parts[1] === 'webhooks'
      && /^\d{5,32}$/.test(parts[2] || '')
      && Boolean(parts[3]);
    if (!isDiscordHost || !isWebhookPath) return '';
    parsed.protocol = 'https:';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function normalizeEmbed(embed = {}) {
  const fields = Array.isArray(embed.fields)
    ? embed.fields
      .filter((field) => cleanText(field.name) || cleanText(field.value))
      .slice(0, 25)
      .map((field) => ({
        name: cleanText(field.name).slice(0, 256) || 'Campo',
        value: cleanText(field.value).slice(0, 1024) || '-',
        inline: Boolean(field.inline)
      }))
    : [];

  const normalized = {};
  if (cleanText(embed.title)) normalized.title = cleanText(embed.title).slice(0, 256);
  if (cleanText(embed.description)) normalized.description = cleanText(embed.description).slice(0, 4096);
  if (cleanText(embed.image)) normalized.image = { url: cleanText(embed.image) };
  if (cleanText(embed.thumbnail)) normalized.thumbnail = { url: cleanText(embed.thumbnail) };
  if (cleanText(embed.footer)) normalized.footer = { text: cleanText(embed.footer).slice(0, 2048) };
  if (fields.length) normalized.fields = fields;

  if (Object.keys(normalized).length > 0 && cleanText(embed.color)) {
    const color = cleanText(embed.color).replace('#', '');
    normalized.color = Number.parseInt(color, 16) || 0xff4058;
  }

  return normalized;
}

function parseDiscordResponse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text ? { message: text.slice(0, 400) } : null;
  }
}

function collectDiscordErrors(errors, prefix = '') {
  if (!errors || typeof errors !== 'object') return [];
  const direct = Array.isArray(errors._errors)
    ? errors._errors.map((item) => `${prefix || 'payload'}: ${item.message || item.code}`).filter(Boolean)
    : [];
  const nested = Object.entries(errors)
    .filter(([key]) => key !== '_errors')
    .flatMap(([key, value]) => collectDiscordErrors(value, prefix ? `${prefix}.${key}` : key));
  return [...direct, ...nested];
}

function formatDiscordWebhookError(payload, status) {
  const details = collectDiscordErrors(payload?.errors).slice(0, 4);
  if (payload?.message) {
    return details.length ? `${payload.message}: ${details.join(' | ')}` : payload.message;
  }
  if (status === 404) return 'Webhook nao encontrado. Confira se voce copiou a URL completa e se o webhook nao foi apagado.';
  if (status === 401 || status === 403) return 'Webhook sem permissao ou token invalido. Gere/copiei a URL novamente no Discord.';
  if (status === 400) return 'Discord recusou o conteudo. Confira mensagem, embed, imagem, thumbnail e avatar URL.';
  return `Discord recusou a mensagem (${status}).`;
}

async function discordRequest(path, { method = 'GET', token, body } = {}) {
  const startedAt = Date.now();
  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${getBotToken(token)}`,
      'Content-Type': 'application/json'
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = parseDiscordResponse(text);
  if (!response.ok) {
    throw makeHttpError(payload?.message || `Discord recusou a acao (${response.status}).`, response.status);
  }
  return { payload, ping: Date.now() - startedAt };
}

export async function sendDiscordWebhookMessage(payload = {}) {
  const webhookUrl = normalizeWebhookUrl(payload.webhookUrl);
  if (!webhookUrl) throw makeHttpError('URL de webhook invalida. Cole a URL completa copiada no Discord.', 400);

  const embed = normalizeEmbed(payload.embed);
  const body = {
    content: cleanText(payload.content).slice(0, 2000) || undefined,
    username: cleanText(payload.username).slice(0, 80) || undefined,
    avatar_url: cleanText(payload.avatarUrl) || undefined,
    embeds: Object.keys(embed).length ? [embed] : undefined,
    allowed_mentions: { parse: [] }
  };

  if (!body.content && !body.embeds) throw makeHttpError('Informe uma mensagem ou embed.', 400);

  const endpoint = new URL(webhookUrl);
  endpoint.searchParams.set('wait', 'true');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const result = parseDiscordResponse(text);
  if (!response.ok) throw makeHttpError(formatDiscordWebhookError(result, response.status), response.status);
  return { ok: true, messageId: result?.id || null };
}

export async function lookupDiscordUser({ userId, botToken }) {
  const id = assertSnowflake(userId, 'Discord ID');
  const createdAt = new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();

  try {
    const { payload } = await discordRequest(`/users/${id}`, { token: botToken });
    return {
      id,
      username: payload.username,
      globalName: payload.global_name,
      discriminator: payload.discriminator,
      avatarUrl: payload.avatar
        ? `https://cdn.discordapp.com/avatars/${id}/${payload.avatar}.png?size=256`
        : null,
      flags: payload.public_flags || 0,
      bot: Boolean(payload.bot),
      createdAt,
      source: 'bot'
    };
  } catch {
    return {
      id,
      username: null,
      globalName: null,
      discriminator: null,
      avatarUrl: null,
      flags: null,
      bot: false,
      createdAt,
      source: 'snowflake'
    };
  }
}

export async function getDiscordBotStatus({ botToken, guildId } = {}) {
  const token = getBotToken(botToken);
  const meResult = await discordRequest('/users/@me', { token });
  let guilds = [];
  try {
    const guildsResult = await discordRequest('/users/@me/guilds', { token });
    guilds = guildsResult.payload || [];
  } catch {
    guilds = [];
  }
  const cleanGuildId = cleanText(guildId) || config.discordBot.defaultGuildId || guilds[0]?.id || '';
  let guild = null;
  let channels = [];
  let roles = [];

  if (cleanGuildId) {
    const guildResult = await discordRequest(`/guilds/${assertSnowflake(cleanGuildId, 'Servidor ID')}?with_counts=true`, { token });
    guild = guildResult.payload;
    channels = (await discordRequest(`/guilds/${cleanGuildId}/channels`, { token })).payload || [];
    roles = (await discordRequest(`/guilds/${cleanGuildId}/roles`, { token })).payload || [];
  }

  return {
    bot: {
      id: meResult.payload.id,
      username: meResult.payload.username,
      avatarUrl: meResult.payload.avatar
        ? `https://cdn.discordapp.com/avatars/${meResult.payload.id}/${meResult.payload.avatar}.png?size=128`
        : null,
      online: true,
      ping: meResult.ping,
      guildCount: guilds.length
    },
    guilds,
    guild: guild ? {
      id: guild.id,
      name: guild.name,
      iconUrl: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128` : null,
      memberCount: guild.approximate_member_count || null,
      onlineCount: guild.approximate_presence_count || null,
      channelCount: channels.length,
      roleCount: roles.length
    } : null,
    channels,
    roles
  };
}

function renderCounterName(template, stats, targetType) {
  const fallback = targetType === 'bot-nickname' ? 'Membros: {members}' : 'membros-{members}';
  const source = cleanText(template) || fallback;
  const rendered = source
    .replaceAll('{members}', String(stats.members ?? 0))
    .replaceAll('{online}', String(stats.online ?? 0))
    .replaceAll('{channels}', String(stats.channels ?? 0))
    .replaceAll('{roles}', String(stats.roles ?? 0))
    .replaceAll('{server}', stats.server || 'Servidor');
  return rendered.slice(0, targetType === 'bot-nickname' ? 32 : 100);
}

async function getDiscordGuildCounterStats(token, guildId) {
  const guildResult = await discordRequest(`/guilds/${guildId}?with_counts=true`, { token });
  const channels = (await discordRequest(`/guilds/${guildId}/channels`, { token })).payload || [];
  const roles = (await discordRequest(`/guilds/${guildId}/roles`, { token })).payload || [];
  return {
    server: guildResult.payload?.name || 'Servidor',
    members: guildResult.payload?.approximate_member_count || 0,
    online: guildResult.payload?.approximate_presence_count || 0,
    channels: channels.length,
    roles: roles.length
  };
}

export async function applyDiscordCounter({ botToken, guildId, targetType = 'bot-nickname', targetId = '', template = '' }) {
  const token = getBotToken(botToken);
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const cleanTargetType = cleanText(targetType) || 'bot-nickname';
  const stats = await getDiscordGuildCounterStats(token, guild);
  const name = renderCounterName(template, stats, cleanTargetType);
  if (!name) throw makeHttpError('Modelo do contador ficou vazio.', 400);

  if (cleanTargetType === 'bot-nickname') {
    await discordRequest(`/guilds/${guild}/members/@me`, {
      method: 'PATCH',
      token,
      body: { nick: name }
    });
    return { ok: true, targetType: cleanTargetType, targetId: guild, name, stats };
  }

  const channelId = assertSnowflake(targetId, cleanTargetType === 'category' ? 'Categoria ID' : 'Canal ID');
  const target = (await discordRequest(`/channels/${channelId}`, { token })).payload;
  if (target?.guild_id !== guild) throw makeHttpError('Esse canal/categoria nao pertence ao servidor informado.', 400);
  if (cleanTargetType === 'category' && target?.type !== 4) throw makeHttpError('O ID informado nao e uma categoria.', 400);
  await discordRequest(`/channels/${channelId}`, {
    method: 'PATCH',
    token,
    body: { name }
  });
  return { ok: true, targetType: cleanTargetType, targetId: channelId, name, stats };
}

export async function createDiscordChannel({ botToken, guildId, name, type = 0, parentId = null }) {
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const body = {
    name: cleanText(name).slice(0, 100),
    type: Number(type),
    parent_id: parentId ? assertSnowflake(parentId, 'Categoria ID') : undefined
  };
  if (!body.name) throw makeHttpError('Informe o nome do canal.', 400);
  return (await discordRequest(`/guilds/${guild}/channels`, { method: 'POST', token: botToken, body })).payload;
}

export async function updateDiscordChannel({ botToken, channelId, name, parentId, position, permissionOverwrites }) {
  const body = {};
  if (cleanText(name)) body.name = cleanText(name).slice(0, 100);
  if (parentId !== undefined) body.parent_id = parentId ? assertSnowflake(parentId, 'Categoria ID') : null;
  if (position !== undefined && position !== '') body.position = Number(position);
  if (Array.isArray(permissionOverwrites)) body.permission_overwrites = permissionOverwrites;
  return (await discordRequest(`/channels/${assertSnowflake(channelId, 'Canal ID')}`, { method: 'PATCH', token: botToken, body })).payload;
}

export async function deleteDiscordChannel({ botToken, channelId }) {
  await discordRequest(`/channels/${assertSnowflake(channelId, 'Canal ID')}`, { method: 'DELETE', token: botToken });
  return { ok: true };
}

export async function createDiscordRole({ botToken, guildId, name, color = '#ff4058', permissions = '0' }) {
  const body = {
    name: cleanText(name).slice(0, 100),
    color: Number.parseInt(cleanText(color).replace('#', ''), 16) || 0,
    permissions: cleanText(permissions) || '0'
  };
  if (!body.name) throw makeHttpError('Informe o nome do cargo.', 400);
  return (await discordRequest(`/guilds/${assertSnowflake(guildId, 'Servidor ID')}/roles`, { method: 'POST', token: botToken, body })).payload;
}

export async function updateDiscordRole({ botToken, guildId, roleId, name, color, permissions }) {
  const body = {};
  if (cleanText(name)) body.name = cleanText(name).slice(0, 100);
  if (cleanText(color)) body.color = Number.parseInt(cleanText(color).replace('#', ''), 16) || 0;
  if (permissions !== undefined) body.permissions = cleanText(permissions) || '0';
  return (await discordRequest(`/guilds/${assertSnowflake(guildId, 'Servidor ID')}/roles/${assertSnowflake(roleId, 'Cargo ID')}`, {
    method: 'PATCH',
    token: botToken,
    body
  })).payload;
}

export async function deleteDiscordRole({ botToken, guildId, roleId }) {
  await discordRequest(`/guilds/${assertSnowflake(guildId, 'Servidor ID')}/roles/${assertSnowflake(roleId, 'Cargo ID')}`, { method: 'DELETE', token: botToken });
  return { ok: true };
}

export async function setDiscordMemberRole({ botToken, guildId, userId, roleId, action }) {
  const method = action === 'remove' ? 'DELETE' : 'PUT';
  await discordRequest(`/guilds/${assertSnowflake(guildId, 'Servidor ID')}/members/${assertSnowflake(userId, 'Usuario ID')}/roles/${assertSnowflake(roleId, 'Cargo ID')}`, {
    method,
    token: botToken
  });
  return { ok: true };
}

export async function runDiscordModerationAction({ botToken, guildId, userId, channelId, action, reason = '', durationMinutes = 10, message = '', amount = 10 }) {
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const user = userId ? assertSnowflake(userId, 'Usuario ID') : '';
  if (action === 'ban') {
    await discordRequest(`/guilds/${guild}/bans/${user}`, { method: 'PUT', token: botToken, body: { delete_message_seconds: 0, reason } });
  } else if (action === 'kick') {
    await discordRequest(`/guilds/${guild}/members/${user}`, { method: 'DELETE', token: botToken, body: { reason } });
  } else if (action === 'timeout') {
    const until = new Date(Date.now() + Number(durationMinutes || 10) * 60_000).toISOString();
    await discordRequest(`/guilds/${guild}/members/${user}`, { method: 'PATCH', token: botToken, body: { communication_disabled_until: until } });
  } else if (action === 'untimeout') {
    await discordRequest(`/guilds/${guild}/members/${user}`, { method: 'PATCH', token: botToken, body: { communication_disabled_until: null } });
  } else if (action === 'warn') {
    await discordRequest(`/channels/${assertSnowflake(channelId, 'Canal ID')}/messages`, {
      method: 'POST',
      token: botToken,
      body: { content: message || `<@${user}> recebeu um aviso.`, allowed_mentions: { users: [user] } }
    });
  } else if (action === 'clear') {
    const channel = assertSnowflake(channelId, 'Canal ID');
    const limit = Math.min(100, Math.max(1, Number(amount || 10)));
    const messagesResult = await discordRequest(`/channels/${channel}/messages?limit=${limit}`, { token: botToken });
    const minimumTimestamp = Date.now() - 13 * 24 * 60 * 60 * 1000;
    const messages = (messagesResult.payload || []).filter((item) => new Date(item.timestamp).getTime() > minimumTimestamp);
    if (messages.length === 0) throw makeHttpError('Nenhuma mensagem recente para limpar.', 400);
    if (messages.length === 1) {
      await discordRequest(`/channels/${channel}/messages/${messages[0].id}`, { method: 'DELETE', token: botToken });
    } else {
      await discordRequest(`/channels/${channel}/messages/bulk-delete`, {
        method: 'POST',
        token: botToken,
        body: { messages: messages.map((item) => item.id) }
      });
    }
  } else {
    throw makeHttpError('Acao de moderacao invalida.', 400);
  }
  return { ok: true };
}

