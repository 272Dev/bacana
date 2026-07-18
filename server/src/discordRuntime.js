import {
  ActivityType,
  AuditLogEvent,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  PresenceUpdateStatus
} from 'discord.js';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel
} from '@discordjs/voice';
import { config, missingEnv } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { db, nowIso } from './db.js';

const clients = new Map();
const voiceTimers = new Map();
const protectionSettings = new Map();
const protectionWindows = new Map();
const protectionCooldowns = new Map();
const processedAuditEntries = new Map();
const recentAuditTargets = new Map();

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
  return `${crypto.createHash('sha256').update(token).digest('hex')}:${guildId}`;
}

function protectionWindowKey(token, guildId, actorId, category = 'audit') {
  return `${protectionKey(token, guildId)}:${category}:${actorId}`;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeProtectionSettings(settings = {}, enabled = true) {
  return {
    enabled: Boolean(enabled),
    limitPerMinute: clampNumber(settings.limitPerMinute, 5, 1, 60),
    limitWindowSeconds: clampNumber(settings.limitWindowSeconds, 60, 10, 300),
    punishment: cleanText(settings.punishment) || 'remove_roles',
    timeoutMinutes: clampNumber(settings.timeoutMinutes, 1440, 1, 40320),
    whitelist: cleanText(settings.whitelist),
    ignoredRoles: cleanText(settings.ignoredRoles),
    quarantineRoleId: cleanText(settings.quarantineRoleId),
    logChannelId: cleanText(settings.logChannelId),
    joinLimit: clampNumber(settings.joinLimit, 8, 1, 100),
    joinWindowSeconds: clampNumber(settings.joinWindowSeconds, 20, 5, 300),
    minAccountAgeDays: clampNumber(settings.minAccountAgeDays, 7, 0, 365),
    messageLimit: clampNumber(settings.messageLimit, 6, 2, 50),
    messageWindowSeconds: clampNumber(settings.messageWindowSeconds, 12, 3, 120),
    duplicateMessageLimit: clampNumber(settings.duplicateMessageLimit, 4, 2, 20),
    mentionLimit: clampNumber(settings.mentionLimit, 4, 2, 50),
    inviteLimitPerMinute: clampNumber(settings.inviteLimitPerMinute, 2, 1, 20),
    webhookLimitPerMinute: clampNumber(settings.webhookLimitPerMinute, 2, 1, 30),
    verificationMode: ['low', 'medium', 'high'].includes(cleanText(settings.verificationMode))
      ? cleanText(settings.verificationMode)
      : 'medium',
    autoLockdown: Boolean(settings.autoLockdown),
    blockInviteSpam: settings.blockInviteSpam !== false,
    blockMentionSpam: settings.blockMentionSpam !== false,
    backupChannels: Boolean(settings.backupChannels),
    backupRoles: Boolean(settings.backupRoles),
    notifyOwner: settings.notifyOwner !== false
  };
}

function pruneTimedMap(map, now = Date.now()) {
  for (const [key, expiresAt] of map) {
    if (expiresAt <= now) map.delete(key);
  }
}

function recordProtectionEvent(key, windowMs, now = Date.now()) {
  const events = (protectionWindows.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  events.push(now);
  protectionWindows.set(key, events);
  return events.length;
}

function isTrustedActorId(guild, settings, actorId) {
  if (!actorId) return true;
  const whitelist = new Set(parseLineList(settings.whitelist));
  return whitelist.has(actorId) || actorId === guild.client.user?.id || actorId === guild.ownerId;
}

function hasIgnoredRole(member, settings) {
  const ignoredRoles = new Set(parseLineList(settings.ignoredRoles));
  return [...ignoredRoles].some((roleId) => member.roles.cache.has(roleId));
}

async function sendProtectionLog(guild, settings, message) {
  const logChannelId = cleanText(settings.logChannelId);
  if (!logChannelId) return;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (channel?.isTextBased?.()) {
    await channel.send({ content: String(message).slice(0, 1950), allowedMentions: { parse: [] } }).catch(() => {});
  }
}

async function protectionDiagnostics(guild, settings) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const warnings = [];
  if (!me) warnings.push('Nao foi possivel localizar o bot como membro do servidor.');
  const has = (permission) => Boolean(me?.permissions?.has(permission));
  if (!has(PermissionFlagsBits.ViewAuditLog)) warnings.push('Falta View Audit Log para identificar quem alterou cargos e canais.');
  if (['remove_roles', 'quarantine'].includes(settings.punishment) && !has(PermissionFlagsBits.ManageRoles)) warnings.push('Falta Manage Roles para retirar cargos.');
  if (settings.timeoutMinutes > 0 && !has(PermissionFlagsBits.ModerateMembers)) warnings.push('Falta Moderate Members para aplicar timeout.');
  if (settings.punishment === 'kick' && !has(PermissionFlagsBits.KickMembers)) warnings.push('Falta Kick Members.');
  if (settings.punishment === 'ban' && !has(PermissionFlagsBits.BanMembers)) warnings.push('Falta Ban Members.');
  if (!has(PermissionFlagsBits.ManageMessages)) warnings.push('Falta Manage Messages para apagar o spam detectado.');
  if (!config.discordBot.messageContentIntent && (settings.blockInviteSpam || settings.duplicateMessageLimit > 0)) {
    warnings.push('Message Content Intent esta desligado; taxa e mencoes funcionam, mas convites e mensagens repetidas ficam limitados.');
  }
  if (!config.discordBot.guildMembersIntent && settings.joinLimit > 0) {
    warnings.push('Server Members Intent esta desligado; o anti-raid de entradas nao recebe todos os eventos.');
  }
  if (me && me.roles.highest.position <= 1) warnings.push('Mova o cargo do bot acima dos cargos que ele deve punir.');
  if (me) {
    const blockingRoles = guild.roles.cache
      .filter((role) => role.id !== guild.id && role.id !== me.roles.highest.id && !role.managed && role.position >= me.roles.highest.position)
      .map((role) => role.name)
      .slice(0, 5);
    if (blockingRoles.length) warnings.push(`O bot nao consegue punir membros com estes cargos acima/de mesma altura: ${blockingRoles.join(', ')}.`);
  }
  if (settings.punishment === 'quarantine' && settings.quarantineRoleId) {
    const quarantineRole = await guild.roles.fetch(settings.quarantineRoleId).catch(() => null);
    if (!quarantineRole?.editable) warnings.push('O cargo de quarentena nao existe ou esta acima do cargo do bot.');
  }
  return {
    ready: Boolean(me),
    warnings,
    messageContentIntent: Boolean(config.discordBot.messageContentIntent),
    guildMembersIntent: Boolean(config.discordBot.guildMembersIntent),
    botHighestRole: me ? { id: me.roles.highest.id, name: me.roles.highest.name, position: me.roles.highest.position } : null
  };
}

async function punishProtectionActor(guild, actorId, settings, reason) {
  if (!actorId) return { applied: false, skipped: true, detail: 'Executor nao identificado.' };
  if (isTrustedActorId(guild, settings, actorId)) return { applied: false, skipped: true, detail: 'Usuario confiavel ou dono do servidor.' };
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return { applied: false, detail: 'Usuario nao esta mais no servidor.' };
  if (hasIgnoredRole(member, settings)) return { applied: false, skipped: true, detail: 'Usuario possui cargo ignorado.' };

  const punishment = cleanText(settings.punishment) || 'remove_roles';
  if (punishment === 'none') return { applied: false, detail: 'Configurado apenas para alertar.' };

  const removableRoles = member.roles.cache
    .filter((role) => role.id !== guild.id && !role.managed && role.editable)
    .map((role) => role.id);
  const protectedRoles = member.roles.cache
    .filter((role) => role.id !== guild.id && (role.managed || !role.editable))
    .map((role) => role.name);
  const errors = [];
  let removedRoles = 0;
  let timedOut = false;

  const removeEditableRoles = async () => {
    if (removableRoles.length === 0) return;
    try {
      await member.roles.remove(removableRoles, reason);
      removedRoles = removableRoles.length;
    } catch (error) {
      errors.push(`remocao de cargos: ${error.message}`);
    }
  };
  const timeoutMember = async () => {
    if (!member.moderatable || Number(settings.timeoutMinutes || 0) <= 0) return;
    try {
      await member.timeout(Math.min(40320, Number(settings.timeoutMinutes)) * 60_000, reason);
      timedOut = true;
    } catch (error) {
      errors.push(`timeout: ${error.message}`);
    }
  };

  if (punishment === 'quarantine') {
    const quarantineId = cleanText(settings.quarantineRoleId);
    if (!quarantineId) return { applied: false, detail: 'Cargo de quarentena nao configurado.' };
    const quarantineRole = await guild.roles.fetch(assertSnowflake(quarantineId, 'Cargo quarentena ID')).catch(() => null);
    if (!quarantineRole) return { applied: false, detail: 'Cargo de quarentena nao encontrado.' };
    if (!quarantineRole.editable) return { applied: false, detail: 'Cargo de quarentena esta acima do cargo do bot.' };
    await removeEditableRoles();
    try {
      await member.roles.add(quarantineRole, reason);
      return {
        applied: true,
        action: 'quarantine',
        detail: `Quarentena aplicada; ${removedRoles} cargo(s) removido(s).${protectedRoles.length ? ` Nao editaveis: ${protectedRoles.join(', ')}.` : ''}`
      };
    } catch (error) {
      errors.push(`quarentena: ${error.message}`);
      return { applied: removedRoles > 0, action: 'quarantine', detail: errors.join(' | ') };
    }
  }
  if (punishment === 'remove_roles') {
    await removeEditableRoles();
    await timeoutMember();
    const applied = removedRoles > 0 || timedOut;
    const detailParts = [`${removedRoles} cargo(s) removido(s)`];
    if (timedOut) detailParts.push(`timeout de ${settings.timeoutMinutes} minuto(s)`);
    if (protectedRoles.length) detailParts.push(`nao editaveis: ${protectedRoles.join(', ')}`);
    if (errors.length) detailParts.push(errors.join(' | '));
    if (!applied && protectedRoles.length) detailParts.push('coloque o cargo do bot acima do usuario');
    return { applied, action: 'remove_roles', detail: detailParts.join('; ') };
  }
  if (punishment === 'timeout') {
    await timeoutMember();
    return {
      applied: timedOut,
      action: 'timeout',
      detail: timedOut ? `Timeout de ${settings.timeoutMinutes} minuto(s).` : (errors.join(' | ') || 'O bot nao pode moderar este usuario; verifique a hierarquia.')
    };
  }
  if (punishment === 'kick') {
    if (!member.kickable) return { applied: false, detail: 'O bot nao pode expulsar este usuario; verifique a hierarquia.' };
    try {
      await member.kick(reason);
      return { applied: true, action: 'kick', detail: 'Usuario expulso.' };
    } catch (error) {
      return { applied: false, detail: error.message };
    }
  }
  if (punishment === 'ban') {
    if (!member.bannable) return { applied: false, detail: 'O bot nao pode banir este usuario; verifique a hierarquia.' };
    try {
      await member.ban({ deleteMessageSeconds: 0, reason });
      return { applied: true, action: 'ban', detail: 'Usuario banido.' };
    } catch (error) {
      return { applied: false, detail: error.message };
    }
  }
  return { applied: false, detail: 'Punicao desconhecida.' };
}

async function containProtectionActor(runtimeEntry, guild, actorId, settings, reason, source) {
  const cooldownKey = protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'cooldown');
  const now = Date.now();
  pruneTimedMap(protectionCooldowns, now);
  if ((protectionCooldowns.get(cooldownKey) || 0) > now) return null;
  protectionCooldowns.set(cooldownKey, now + 45_000);
  const outcome = await punishProtectionActor(guild, actorId, settings, reason).catch((error) => ({ applied: false, detail: error.message }));
  if (outcome.skipped) return outcome;
  await sendProtectionLog(
    guild,
    settings,
    outcome.applied
      ? `Nexus conteve <@${actorId}> [${source}]. ${reason}. Resultado: ${outcome.detail}`
      : `Nexus detectou <@${actorId}> [${source}], mas o castigo falhou. ${reason}. Motivo: ${outcome.detail}`
  );
  return outcome;
}

const protectionAuditActions = new Map([
  [AuditLogEvent.ChannelCreate, { label: 'criacao de canais' }],
  [AuditLogEvent.ChannelDelete, { label: 'exclusao de canais' }],
  [AuditLogEvent.ChannelUpdate, { label: 'alteracao de canais' }],
  [AuditLogEvent.RoleCreate, { label: 'criacao de cargos' }],
  [AuditLogEvent.RoleDelete, { label: 'exclusao de cargos' }],
  [AuditLogEvent.RoleUpdate, { label: 'alteracao de cargos' }],
  [AuditLogEvent.MemberBanAdd, { label: 'banimentos' }],
  [AuditLogEvent.MemberKick, { label: 'expulsoes' }],
  [AuditLogEvent.MemberRoleUpdate, { label: 'alteracao de cargos de membros' }],
  [AuditLogEvent.MemberPrune, { label: 'limpeza de membros', limit: 1 }],
  [AuditLogEvent.BotAdd, { label: 'adicao de bots', limit: 1 }],
  [AuditLogEvent.WebhookCreate, { label: 'criacao de webhooks', webhook: true }],
  [AuditLogEvent.WebhookDelete, { label: 'exclusao de webhooks', webhook: true }],
  [AuditLogEvent.WebhookUpdate, { label: 'alteracao de webhooks', webhook: true }],
  [AuditLogEvent.GuildUpdate, { label: 'alteracao do servidor', limit: 2 }],
  [AuditLogEvent.EmojiDelete, { label: 'exclusao de emojis' }],
  [AuditLogEvent.StickerDelete, { label: 'exclusao de stickers' }],
  [AuditLogEvent.IntegrationCreate, { label: 'criacao de integracoes' }],
  [AuditLogEvent.IntegrationDelete, { label: 'exclusao de integracoes' }]
].filter(([action]) => Number.isInteger(action)));

function auditTargetKey(runtimeEntry, guildId, action, targetId) {
  return `${protectionKey(runtimeEntry.token, guildId)}:${action}:${targetId || 'any'}`;
}

async function handleProtectionAuditEntry(runtimeEntry, guild, auditEntry) {
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, guild.id));
  if (!settings?.enabled) return;
  const definition = protectionAuditActions.get(Number(auditEntry?.action));
  if (!definition) return;
  const actorId = auditEntry.executorId || auditEntry.executor?.id || null;
  if (isTrustedActorId(guild, settings, actorId)) return;
  if (auditEntry.createdTimestamp && Date.now() - auditEntry.createdTimestamp > 30_000) return;

  pruneTimedMap(processedAuditEntries);
  const auditId = cleanText(auditEntry.id);
  const dedupeKey = auditId ? `${protectionKey(runtimeEntry.token, guild.id)}:${auditId}` : '';
  if (dedupeKey && processedAuditEntries.has(dedupeKey)) return;
  if (dedupeKey) processedAuditEntries.set(dedupeKey, Date.now() + 120_000);

  const targetId = auditEntry.targetId || auditEntry.target?.id || null;
  recentAuditTargets.set(auditTargetKey(runtimeEntry, guild.id, auditEntry.action, targetId), Date.now() + 15_000);

  const now = Date.now();
  const windowMs = Math.max(10, Number(settings.limitWindowSeconds || 60)) * 1000;
  const key = protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'audit');
  const eventCount = recordProtectionEvent(key, windowMs, now);
  const limit = definition.limit || (definition.webhook
    ? Math.max(1, Number(settings.webhookLimitPerMinute || 2))
    : Math.max(1, Number(settings.limitPerMinute || 5)));
  if (eventCount < limit) return;

  const reason = `${eventCount} acao(oes) em ${Math.round(windowMs / 1000)}s: ${definition.label}${targetId ? ` (alvo ${targetId})` : ''}`;
  await containProtectionActor(runtimeEntry, guild, actorId, settings, reason, 'audit-log');
  protectionWindows.delete(key);
}

async function findMatchingAuditEntry(guild, auditTypes, targetId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const auditType of auditTypes) {
      const logs = await guild.fetchAuditLogs({ limit: 6, type: auditType }).catch(() => null);
      const match = logs?.entries?.find((item) => {
        const recent = Date.now() - item.createdTimestamp < 20_000;
        const itemTargetId = item.targetId || item.target?.id || null;
        return recent && (!targetId || !itemTargetId || itemTargetId === targetId);
      });
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 350 + attempt * 250));
  }
  return null;
}

async function handleAuditFallback(runtimeEntry, guild, auditTypes, targetId = null) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  pruneTimedMap(recentAuditTargets);
  const wasReceivedDirectly = auditTypes.some((action) => recentAuditTargets.has(auditTargetKey(runtimeEntry, guild.id, action, targetId)));
  if (wasReceivedDirectly) return;
  const auditEntry = await findMatchingAuditEntry(guild, auditTypes, targetId);
  if (auditEntry) await handleProtectionAuditEntry(runtimeEntry, guild, auditEntry);
}

async function handleProtectionMessage(runtimeEntry, message) {
  const guild = message.guild;
  if (!guild || !message.author || message.author.bot || message.webhookId) return;
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, guild.id));
  if (!settings?.enabled || isTrustedActorId(guild, settings, message.author.id)) return;
  if (message.member && hasIgnoredRole(message.member, settings)) return;

  const now = Date.now();
  const actorId = message.author.id;
  const messageWindowMs = Number(settings.messageWindowSeconds || 12) * 1000;
  const messageCount = recordProtectionEvent(
    protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'messages'),
    messageWindowMs,
    now
  );
  const content = cleanText(message.content).toLowerCase();
  const rawMentionCount = content
    ? (content.match(/<@!?\d+>|<@&\d+>|@everyone|@here/g) || []).length
    : 0;
  const collectionMentionCount = Number(message.mentions?.users?.size || 0)
    + Number(message.mentions?.roles?.size || 0)
    + (message.mentions?.everyone ? Number(settings.mentionLimit || 4) : 0);
  const mentionCount = Math.max(rawMentionCount, collectionMentionCount);

  let trigger = '';
  if (settings.blockMentionSpam && mentionCount >= Number(settings.mentionLimit || 4)) {
    trigger = `${mentionCount} mencoes em uma mensagem`;
  }
  if (!trigger && messageCount >= Number(settings.messageLimit || 6)) {
    trigger = `${messageCount} mensagens em ${settings.messageWindowSeconds}s`;
  }
  if (!trigger && content) {
    const duplicateKey = protectionWindowKey(
      runtimeEntry.token,
      guild.id,
      actorId,
      `duplicate:${crypto.createHash('sha1').update(content.slice(0, 500)).digest('hex')}`
    );
    const duplicates = recordProtectionEvent(duplicateKey, Math.max(messageWindowMs, 20_000), now);
    if (duplicates >= Number(settings.duplicateMessageLimit || 4)) trigger = `${duplicates} mensagens repetidas`;
  }
  if (!trigger && settings.blockInviteSpam && /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i.test(content)) {
    const inviteCount = recordProtectionEvent(
      protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'invites'),
      60_000,
      now
    );
    if (inviteCount >= Number(settings.inviteLimitPerMinute || 2)) trigger = `${inviteCount} convites em um minuto`;
  }
  if (!trigger) return;

  await message.delete().catch(() => {});
  const reason = `Spam detectado: ${trigger}`;
  await containProtectionActor(runtimeEntry, guild, actorId, settings, reason, 'anti-spam');
  protectionWindows.delete(protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'messages'));
}

async function handleProtectionJoin(runtimeEntry, member) {
  if (!member?.guild || member.user?.bot) return;
  const guild = member.guild;
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, guild.id));
  if (!settings?.enabled || isTrustedActorId(guild, settings, member.id)) return;
  const windowMs = Number(settings.joinWindowSeconds || 20) * 1000;
  const joins = recordProtectionEvent(
    protectionWindowKey(runtimeEntry.token, guild.id, 'all', 'joins'),
    windowMs
  );
  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  const tooNew = accountAgeDays < Number(settings.minAccountAgeDays || 0);
  const raid = joins >= Number(settings.joinLimit || 8);
  if (!raid && !(tooNew && settings.verificationMode === 'high')) return;
  const reason = raid
    ? `Anti-raid: ${joins} entradas em ${settings.joinWindowSeconds}s`
    : `Conta criada ha ${Math.floor(accountAgeDays)} dia(s); minimo ${settings.minAccountAgeDays}`;
  await containProtectionActor(runtimeEntry, guild, member.id, settings, reason, 'anti-raid');
}

function attachProtectionHandlers(entry) {
  if (entry.protectionHandlersAttached) return;
  entry.protectionHandlersAttached = true;
  const client = entry.client;

  client.on(Events.GuildAuditLogEntryCreate, (auditEntry, guild) => {
    void handleProtectionAuditEntry(entry, guild, auditEntry);
  });

  const fallback = (eventName, auditTypes, guildFromTarget = (target) => target?.guild, targetIdFromTarget = (target) => target?.id) => {
    client.on(eventName, (target) => {
      const guild = guildFromTarget(target);
      if (!guild?.id) return;
      void handleAuditFallback(entry, guild, auditTypes, targetIdFromTarget(target));
    });
  };

  fallback(Events.ChannelCreate, [AuditLogEvent.ChannelCreate]);
  fallback(Events.ChannelDelete, [AuditLogEvent.ChannelDelete]);
  fallback(Events.ChannelUpdate, [AuditLogEvent.ChannelUpdate], (target) => target?.guild);
  fallback(Events.GuildRoleCreate, [AuditLogEvent.RoleCreate]);
  fallback(Events.GuildRoleDelete, [AuditLogEvent.RoleDelete]);
  fallback(Events.GuildRoleUpdate, [AuditLogEvent.RoleUpdate]);
  fallback(Events.GuildBanAdd, [AuditLogEvent.MemberBanAdd]);
  fallback(Events.WebhooksUpdate, [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate], (channel) => channel?.guild, () => null);
  client.on(Events.GuildUpdate, (_before, after) => {
    void handleAuditFallback(entry, after, [AuditLogEvent.GuildUpdate], after.id);
  });
  client.on(Events.GuildMemberUpdate, (before, after) => {
    const beforeRoles = [...before.roles.cache.keys()].sort().join(',');
    const afterRoles = [...after.roles.cache.keys()].sort().join(',');
    if (beforeRoles !== afterRoles) void handleAuditFallback(entry, after.guild, [AuditLogEvent.MemberRoleUpdate], after.id);
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void handleProtectionJoin(entry, member);
    if (member.user.bot) void handleAuditFallback(entry, member.guild, [AuditLogEvent.BotAdd], member.id);
  });
  client.on(Events.MessageCreate, (message) => {
    void handleProtectionMessage(entry, message);
  });
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

  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages
  ];
  if (config.discordBot.guildMembersIntent) intents.push(GatewayIntentBits.GuildMembers);
  if (config.discordBot.messageContentIntent) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({ intents });

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

async function persistDiscordProtection(token, guildId, botUserId, settings) {
  const id = crypto.createHash('sha256').update(`${token}:${guildId}`).digest('hex');
  const now = nowIso();
  await db.prepare(`
    INSERT INTO discord_protection_configs (
      id, guild_id, bot_user_id, bot_token_encrypted, settings_json, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      bot_user_id = excluded.bot_user_id,
      bot_token_encrypted = excluded.bot_token_encrypted,
      settings_json = excluded.settings_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    id,
    guildId,
    botUserId || null,
    encryptSecret(token),
    JSON.stringify(settings),
    settings.enabled ? 1 : 0,
    now,
    now
  );
}

export async function configureDiscordProtection({ botToken, guildId, enabled = true, ...settings } = {}, { persist = true } = {}) {
  const token = getRuntimeToken(botToken);
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const entry = await ensureClient({ botToken, status: 'online' });
  const nextSettings = normalizeProtectionSettings(settings, enabled);
  protectionSettings.set(protectionKey(token, guild), nextSettings);
  attachProtectionHandlers(entry);
  const discordGuild = await entry.client.guilds.fetch(guild);
  const diagnostics = await protectionDiagnostics(discordGuild, nextSettings);
  if (persist) await persistDiscordProtection(token, guild, entry.client.user?.id, nextSettings);
  await sendProtectionLog(
    discordGuild,
    nextSettings,
    `Protecao Nexus ${nextSettings.enabled ? 'ativada' : 'desativada'} para este servidor.${diagnostics.warnings.length ? ` Avisos: ${diagnostics.warnings.join(' | ')}` : ' Permissoes principais verificadas.'}`
  );
  return { ok: true, guildId: guild, protection: nextSettings, diagnostics };
}

export async function restoreDiscordProtections() {
  const storedRows = await db.prepare(`
    SELECT * FROM discord_protection_configs ORDER BY updated_at DESC
  `).all();
  const rows = storedRows.filter((row) => Number(row.enabled) === 1);
  const result = { restored: 0, failed: [] };
  if (storedRows.length === 0 && config.discordBot.token) {
    const defaultEntry = await ensureClient({ status: 'online' }).catch(() => null);
    // Mantem o mesmo fallback usado pelo painel: quando ainda nao existe uma
    // configuracao persistida, protege o primeiro servidor disponivel. Antes,
    // bots presentes em mais de um servidor iniciavam com zero protecoes.
    const fallbackGuildId = defaultEntry?.client?.guilds?.cache?.first()?.id || null;
    const initialGuildId = cleanText(config.discordBot.defaultGuildId) || fallbackGuildId;
    if (initialGuildId) {
      try {
        await configureDiscordProtection({
          guildId: initialGuildId,
          enabled: true,
          punishment: 'remove_roles',
          limitPerMinute: 5,
          limitWindowSeconds: 60,
          messageLimit: 6,
          messageWindowSeconds: 12,
          mentionLimit: 4,
          duplicateMessageLimit: 4,
          timeoutMinutes: 1440
        });
        result.restored += 1;
      } catch (error) {
        result.failed.push({ guildId: initialGuildId, error: error.message });
      }
      return result;
    }
  }
  for (const row of rows) {
    try {
      const token = decryptSecret(row.bot_token_encrypted);
      const settings = JSON.parse(row.settings_json || '{}');
      await configureDiscordProtection(
        { botToken: token, guildId: row.guild_id, ...settings, enabled: true },
        { persist: false }
      );
      result.restored += 1;
    } catch (error) {
      result.failed.push({ guildId: row.guild_id, error: error.message });
    }
  }
  return result;
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

// Pequena superficie interna para testes de regressao; nao e exposta por HTTP.
export const __discordProtectionTest = Object.freeze({
  normalizeProtectionSettings,
  punishProtectionActor
});
