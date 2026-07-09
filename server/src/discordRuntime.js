import {
  ActivityType,
  AuditLogEvent,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PresenceUpdateStatus
} from 'discord.js';
import { Buffer } from 'node:buffer';
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} from '@discordjs/voice';
import { config, missingEnv } from './config.js';

const clients = new Map();
const voiceTimers = new Map();
const protectionSettings = new Map();
const protectionWindows = new Map();

function makeHttpError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cleanText(value) {
  return String(value || '').trim();
}

function getRuntimeToken(inputToken = '') {
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

function normalizeStatus(status = 'online') {
  const value = cleanText(status).toLowerCase();
  if (value === 'idle') return PresenceUpdateStatus.Idle;
  if (value === 'dnd') return PresenceUpdateStatus.DoNotDisturb;
  if (value === 'invisible' || value === 'offline') return PresenceUpdateStatus.Invisible;
  return PresenceUpdateStatus.Online;
}

function normalizeActivityType(type = 'Watching') {
  const value = cleanText(type).toLowerCase();
  if (value === 'playing') return ActivityType.Playing;
  if (value === 'listening') return ActivityType.Listening;
  if (value === 'competing') return ActivityType.Competing;
  return ActivityType.Watching;
}

function makePresence({ status = 'online', activityType = 'Watching', activityMessage = 'Nexus dashboard' } = {}) {
  const message = cleanText(activityMessage);
  return {
    status: normalizeStatus(status),
    activities: message ? [{ name: message.slice(0, 128), type: normalizeActivityType(activityType) }] : []
  };
}

function parseLineList(value) {
  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function protectionKey(token, guildId) {
  return `${token}:${guildId}`;
}

function protectionWindowKey(token, guildId, actorId) {
  return `${token}:${guildId}:${actorId}`;
}

async function sendProtectionLog(guild, settings, message) {
  const logChannelId = cleanText(settings.logChannelId);
  if (!logChannelId) return;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (channel?.isTextBased?.()) {
    await channel.send({ content: message, allowedMentions: { parse: [] } }).catch(() => {});
  }
}

async function findAuditExecutor(guild, auditType) {
  const logs = await guild.fetchAuditLogs({ limit: 1, type: auditType }).catch(() => null);
  const entry = logs?.entries?.first?.();
  if (!entry || Date.now() - entry.createdTimestamp > 15_000) return null;
  return entry.executor?.id || null;
}

async function punishProtectionActor(guild, actorId, settings, reason) {
  const whitelist = new Set(parseLineList(settings.whitelist));
  if (!actorId || whitelist.has(actorId) || actorId === guild.client.user?.id || actorId === guild.ownerId) return false;
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return false;
  const ignoredRoles = new Set(parseLineList(settings.ignoredRoles));
  if ([...ignoredRoles].some((roleId) => member.roles.cache.has(roleId))) return false;

  const punishment = cleanText(settings.punishment) || 'remove_roles';
  if (punishment === 'quarantine' && cleanText(settings.quarantineRoleId)) {
    await member.roles.set([assertSnowflake(settings.quarantineRoleId, 'Cargo quarentena ID')], reason);
    return true;
  }
  if (punishment === 'remove_roles') {
    await member.roles.set([], reason);
    return true;
  }
  if (punishment === 'kick') {
    await member.kick(reason);
    return true;
  }
  if (punishment === 'ban') {
    await member.ban({ deleteMessageSeconds: 0, reason });
    return true;
  }
  return false;
}

async function handleProtectionAuditEvent(entry, guild, auditType, label) {
  const token = entry.token;
  const settings = protectionSettings.get(protectionKey(token, guild.id));
  if (!settings?.enabled) return;
  const actorId = await findAuditExecutor(guild, auditType);
  if (!actorId) return;

  const now = Date.now();
  const windowMs = Math.max(10, Number(settings.limitWindowSeconds || 60)) * 1000;
  const key = protectionWindowKey(token, guild.id, actorId);
  const events = (protectionWindows.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  events.push(now);
  protectionWindows.set(key, events);

  const limit = Math.max(1, Number(settings.limitPerMinute || 5));
  if (events.length <= limit) return;

  const reason = `Nexus anti-nuke: ${events.length} acoes em ${Math.round(windowMs / 1000)}s (${label})`;
  const punished = await punishProtectionActor(guild, actorId, settings, reason).catch(() => false);
  await sendProtectionLog(
    guild,
    settings,
    punished
      ? `Protecao Nexus conteve <@${actorId}>: ${reason}`
      : `Protecao Nexus detectou abuso de <@${actorId}>, mas nao conseguiu aplicar punicao: ${reason}`
  );
}

function attachProtectionHandlers(entry) {
  if (entry.protectionHandlersAttached) return;
  entry.protectionHandlersAttached = true;
  const client = entry.client;
  const auditEvents = [
    ['channelDelete', AuditLogEvent.ChannelDelete, 'exclusao de canais'],
    ['channelCreate', AuditLogEvent.ChannelCreate, 'criacao de canais'],
    ['roleDelete', AuditLogEvent.RoleDelete, 'exclusao de cargos'],
    ['roleCreate', AuditLogEvent.RoleCreate, 'criacao de cargos'],
    ['guildBanAdd', AuditLogEvent.MemberBanAdd, 'banimentos'],
    ['webhooksUpdate', AuditLogEvent.WebhookCreate, 'webhooks']
  ];
  for (const [eventName, auditType, label] of auditEvents) {
    client.on(eventName, (target) => {
      const guild = target?.guild || target;
      if (!guild?.id) return;
      void handleProtectionAuditEvent(entry, guild, auditType, label);
    });
  }
}

async function fetchAvatarBuffer(avatarUrl) {
  const rawUrl = cleanText(avatarUrl);
  if (!rawUrl) return null;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw makeHttpError('Avatar URL invalida.', 400);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeHttpError('Avatar precisa ser uma URL http/https.', 400);
  }

  const response = await fetch(parsed, { headers: { 'User-Agent': 'Nexus Discord Dashboard' } });
  if (!response.ok) throw makeHttpError(`Nao foi possivel baixar o avatar (${response.status}).`, 400);
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw makeHttpError('Avatar URL precisa apontar para uma imagem.', 400);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > 8 * 1024 * 1024) throw makeHttpError('Avatar muito grande. Use imagem menor que 8MB.', 400);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > 8 * 1024 * 1024) throw makeHttpError('Avatar muito grande. Use imagem menor que 8MB.', 400);
  return buffer;
}

function clientState(entry) {
  const client = entry?.client;
  const user = client?.user;
  const ready = Boolean(client?.isReady?.());
  const voiceConnections = ready
    ? [...client.guilds.cache.keys()].map((guildId) => getVoiceConnection(guildId)).filter(Boolean)
    : [];

  return {
    online: ready,
    ready,
    user: user ? {
      id: user.id,
      username: user.username,
      avatarUrl: user.displayAvatarURL?.({ size: 128 }) || null
    } : null,
    guildCount: ready ? client.guilds.cache.size : 0,
    uptimeMs: ready ? client.uptime || 0 : 0,
    desiredStatus: entry?.desiredStatus || 'offline',
    voice: voiceConnections.map((connection) => ({
      guildId: connection.joinConfig.guildId,
      channelId: connection.joinConfig.channelId,
      status: connection.state.status
    }))
  };
}

async function ensureClient({ botToken, status, activityType, activityMessage } = {}) {
  const token = getRuntimeToken(botToken);
  const existing = clients.get(token);
  if (existing?.client?.isReady?.()) {
    if (status || activityType || activityMessage) {
      existing.client.user.setPresence(makePresence({ status, activityType, activityMessage }));
      existing.desiredStatus = status || existing.desiredStatus || 'online';
    }
    return existing;
  }
  if (existing?.readyPromise) return existing.readyPromise;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const entry = {
    token,
    client,
    desiredStatus: status || 'online',
    readyPromise: null,
    protectionHandlersAttached: false
  };
  clients.set(token, entry);
  attachProtectionHandlers(entry);

  entry.readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clients.delete(token);
      client.destroy();
      reject(makeHttpError('Bot demorou para conectar ao Discord Gateway.', 504));
    }, 30_000);

    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      client.user.setPresence(makePresence({ status, activityType, activityMessage }));
      entry.readyPromise = null;
      resolve(entry);
    });

    client.once('error', (error) => {
      clearTimeout(timeout);
      clients.delete(token);
      reject(error);
    });
  });

  try {
    await client.login(token);
    return await entry.readyPromise;
  } catch (error) {
    clients.delete(token);
    client.destroy();
    throw makeHttpError(error?.message || 'Nao foi possivel conectar o bot ao Gateway.', 400);
  }
}

export async function getDiscordRuntimeState({ botToken } = {}) {
  const token = getRuntimeToken(botToken);
  return clientState(clients.get(token));
}

export async function runDiscordBotLifecycle({ botToken, action = 'start', status = 'online', activityType, activityMessage } = {}) {
  const token = getRuntimeToken(botToken);
  const current = clients.get(token);

  if (action === 'stop') {
    for (const connection of current?.client?.guilds?.cache?.keys?.() || []) {
      getVoiceConnection(connection)?.destroy();
    }
    current?.client?.destroy();
    clients.delete(token);
    return { ok: true, action, runtime: { online: false, ready: false, voice: [] } };
  }

  if (action === 'restart' || action === 'reconnect') {
    current?.client?.destroy();
    clients.delete(token);
  }

  const entry = await ensureClient({ botToken, status, activityType, activityMessage });
  return { ok: true, action, runtime: clientState(entry) };
}

export async function applyDiscordBotProfile({
  botToken,
  guildId,
  status = 'online',
  activityType = 'Watching',
  activityMessage = 'Nexus dashboard',
  displayName = '',
  avatarUrl = ''
} = {}) {
  const entry = await ensureClient({ botToken, status, activityType, activityMessage });
  const client = entry.client;
  const result = {
    ok: true,
    presenceUpdated: true,
    nicknameUpdated: false,
    avatarUpdated: false,
    runtime: clientState(entry)
  };

  const nextName = cleanText(displayName).slice(0, 32);
  if (nextName) {
    const guild = assertSnowflake(guildId, 'Servidor ID');
    const discordGuild = await client.guilds.fetch(guild);
    const me = discordGuild.members.me || await discordGuild.members.fetchMe();
    await me.setNickname(nextName, 'Nexus dashboard profile update');
    result.nicknameUpdated = true;
  }

  const avatarBuffer = await fetchAvatarBuffer(avatarUrl);
  if (avatarBuffer) {
    await client.user.setAvatar(avatarBuffer);
    result.avatarUpdated = true;
  }

  result.runtime = clientState(entry);
  return result;
}

export async function configureDiscordProtection({ botToken, guildId, enabled = true, ...settings } = {}) {
  const token = getRuntimeToken(botToken);
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const entry = await ensureClient({ botToken, status: 'online' });
  const nextSettings = {
    enabled: Boolean(enabled),
    limitPerMinute: Math.max(1, Math.min(60, Number(settings.limitPerMinute || 5))),
    limitWindowSeconds: Math.max(10, Math.min(300, Number(settings.limitWindowSeconds || 60))),
    punishment: cleanText(settings.punishment) || 'remove_roles',
    whitelist: cleanText(settings.whitelist),
    ignoredRoles: cleanText(settings.ignoredRoles),
    quarantineRoleId: cleanText(settings.quarantineRoleId),
    logChannelId: cleanText(settings.logChannelId)
  };
  protectionSettings.set(protectionKey(token, guild), nextSettings);
  attachProtectionHandlers(entry);
  const discordGuild = await entry.client.guilds.fetch(guild);
  await sendProtectionLog(discordGuild, nextSettings, `Protecao Nexus ${nextSettings.enabled ? 'ativada' : 'desativada'} para este servidor.`);
  return { ok: true, guildId: guild, protection: nextSettings };
}

function durationToMs({ voiceDuration, voiceHours = 0, voiceMinutes = 0 } = {}) {
  if (voiceDuration === '30m') return 30 * 60_000;
  if (voiceDuration === '1h') return 60 * 60_000;
  if (voiceDuration === '6h') return 6 * 60 * 60_000;
  if (voiceDuration === 'custom') {
    const hours = Math.max(0, Number(voiceHours || 0));
    const minutes = Math.max(0, Number(voiceMinutes || 0));
    const total = (hours * 60 + minutes) * 60_000;
    return total > 0 ? total : null;
  }
  return null;
}

function clearVoiceTimer(guildId) {
  const timer = voiceTimers.get(guildId);
  if (timer) windowClearTimeout(timer);
  voiceTimers.delete(guildId);
}

const windowClearTimeout = globalThis.clearTimeout.bind(globalThis);
const windowSetTimeout = globalThis.setTimeout.bind(globalThis);

export async function runDiscordVoiceAction({
  botToken,
  guildId,
  voiceChannelId,
  action = 'join',
  voiceDuration = 'forever',
  voiceHours = 0,
  voiceMinutes = 0,
  voiceAfkMode = true
} = {}) {
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const entry = await ensureClient({ botToken, status: 'online' });
  const client = entry.client;

  if (action === 'leave') {
    clearVoiceTimer(guild);
    getVoiceConnection(guild)?.destroy();
    return { ok: true, action, runtime: clientState(entry) };
  }

  const channelId = assertSnowflake(voiceChannelId, 'Canal de voz ID');
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.guildId !== guild || channel.type !== ChannelType.GuildVoice) {
    throw makeHttpError('Selecione um canal de voz valido do servidor.', 400);
  }

  const connection = joinVoiceChannel({
    channelId,
    guildId: guild,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: Boolean(voiceAfkMode),
    selfMute: Boolean(voiceAfkMode)
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  clearVoiceTimer(guild);
  const durationMs = durationToMs({ voiceDuration, voiceHours, voiceMinutes });
  if (durationMs) {
    voiceTimers.set(guild, windowSetTimeout(() => {
      getVoiceConnection(guild)?.destroy();
      voiceTimers.delete(guild);
    }, durationMs));
  }

  return {
    ok: true,
    action,
    voice: {
      guildId: guild,
      channelId,
      staysUntilStopped: !durationMs,
      durationMs
    },
    runtime: clientState(entry)
  };
}

export async function startDefaultDiscordBot() {
  if (!config.discordBot.token || missingEnv(config.discordBot.token)) return null;
  return runDiscordBotLifecycle({
    action: 'start',
    status: 'online',
    activityType: 'Watching',
    activityMessage: 'Nexus dashboard'
  });
}
