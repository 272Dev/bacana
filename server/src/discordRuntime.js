import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PresenceUpdateStatus
} from 'discord.js';
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} from '@discordjs/voice';
import { config, missingEnv } from './config.js';

const clients = new Map();
const voiceTimers = new Map();

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
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const entry = {
    client,
    desiredStatus: status || 'online',
    readyPromise: null
  };
  clients.set(token, entry);

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
