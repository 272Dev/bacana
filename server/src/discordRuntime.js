import {
  ActivityType,
  AuditLogEvent,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
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
import { db, getAuthorizedUser, nowIso } from './db.js';
import { logAudit } from './audit.js';
import { hasPermission, PERMISSIONS } from './permissions.js';
import {
  completeRobloxSalesDelivery,
  releaseRobloxSalesDelivery,
  reserveRandomRobloxSalesAccount
} from './robloxGenerator.js';
import {
  detectorCatalogResponse,
  detectorConfig,
  detectorDefinition,
  evaluateMessageDetectors,
  evaluateProfileDetectors,
  makeMessageRecord,
  normalizeDetectorSettings
} from './discordProtectionEngine.js';

const clients = new Map();
const voiceTimers = new Map();
const protectionSettings = new Map();
const protectionWindows = new Map();
const protectionCooldowns = new Map();
const processedAuditEntries = new Map();
const recentAuditTargets = new Map();
const messageHistories = new Map();
const resourceSnapshots = new Map();
const inviteSnapshots = new Map();
const salesCooldowns = new Map();
const SALES_COMMAND_NAME = 'conta';
const SALES_COOLDOWN_MS = 60_000;

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

function isDefaultBotToken(token) {
  return Boolean(config.discordBot.token)
    && !missingEnv(config.discordBot.token)
    && token === config.discordBot.token;
}

function safeCredential(value, max = 1000) {
  return String(value || '').replace(/`/g, 'ˋ').slice(0, max);
}

async function registerSalesCommand(entry) {
  if (!entry?.client?.isReady?.() || !isDefaultBotToken(entry.token)) return;
  const definition = {
    name: SALES_COMMAND_NAME,
    description: 'Receber uma conta do estoque Nexus no privado',
    dmPermission: false
  };
  const guildId = cleanText(config.discordBot.defaultGuildId);
  const manager = guildId
    ? (await entry.client.guilds.fetch(guildId)).commands
    : entry.client.application.commands;
  const commands = await manager.fetch();
  if (!commands.find((command) => command.name === SALES_COMMAND_NAME)) {
    await manager.create(definition);
  }
}

async function handleSalesInteraction(entry, interaction) {
  if (!interaction.isChatInputCommand?.() || interaction.commandName !== SALES_COMMAND_NAME) return;
  if (!isDefaultBotToken(entry.token)) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const authorized = await getAuthorizedUser(interaction.user.id);
  if (!authorized || !hasPermission(authorized, PERMISSIONS.SALES_USE)) {
    await interaction.editReply('Voce nao esta autorizado a usar o bot de vendas Nexus.');
    return;
  }

  const lastUse = salesCooldowns.get(interaction.user.id) || 0;
  const retryAfter = SALES_COOLDOWN_MS - (Date.now() - lastUse);
  if (retryAfter > 0) {
    await interaction.editReply(`Aguarde ${Math.ceil(retryAfter / 1000)} segundos antes de solicitar outra conta.`);
    return;
  }
  salesCooldowns.set(interaction.user.id, Date.now());

  let reservation = null;
  let dmSent = false;
  try {
    reservation = await reserveRandomRobloxSalesAccount({
      buyerDiscordId: interaction.user.id,
      channel: 'discord-command'
    });
    const { account, deliveryId } = reservation;
    const embed = new EmbedBuilder()
      .setColor(0x0A0A0A)
      .setTitle('Sua conta Nexus')
      .setDescription('Entrega privada autorizada. Nao compartilhe estes dados.')
      .addFields(
        { name: 'Usuario', value: `\`${safeCredential(account.username)}\`` },
        { name: 'Senha', value: `\`${safeCredential(account.password)}\`` },
        { name: 'Perfil', value: account.profileUrl ? safeCredential(account.profileUrl) : 'Nao vinculado' },
        { name: 'Entrega', value: `\`${deliveryId.slice(0, 8).toUpperCase()}\`` }
      )
      .setFooter({ text: 'Nexus • entrega manual protegida' })
      .setTimestamp();

    await interaction.user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    dmSent = true;
    await completeRobloxSalesDelivery({ deliveryId, buyerDiscordId: interaction.user.id });
    await logAudit({
      actorDiscordId: interaction.user.id,
      action: 'sales_bot.account_delivered',
      targetType: 'roblox_generator_account',
      targetId: account.id,
      metadata: { deliveryId, channel: 'discord-dm' }
    });
    await interaction.editReply('Conta entregue no seu privado. Confira suas mensagens diretas.');
  } catch (error) {
    if (reservation?.deliveryId && !dmSent) {
      await releaseRobloxSalesDelivery({
        deliveryId: reservation.deliveryId,
        buyerDiscordId: interaction.user.id
      }).catch(() => {});
    }
    salesCooldowns.delete(interaction.user.id);
    const message = error?.code === 50007
      ? 'Nao consegui enviar a DM. Ative mensagens privadas deste servidor e tente novamente.'
      : error?.message || 'Nao foi possivel entregar uma conta agora.';
    await interaction.editReply(message.slice(0, 1900)).catch(() => {});
  }
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
  const detectors = normalizeDetectorSettings(settings.detectors);
  if (!settings.detectors) {
    detectors.spam.threshold = clampNumber(settings.messageLimit, 6, 2, 50);
    detectors.spam.windowSeconds = clampNumber(settings.messageWindowSeconds, 12, 3, 120);
    detectors.fast_message_spam.threshold = Math.max(3, Math.min(detectors.spam.threshold, 6));
    detectors.duplicate_message.threshold = clampNumber(settings.duplicateMessageLimit, 4, 2, 20);
    detectors.mention_spam.threshold = clampNumber(settings.mentionLimit, 4, 2, 50);
    detectors.discord_invite.enabled = settings.blockInviteSpam !== false;
    detectors.mention_spam.enabled = settings.blockMentionSpam !== false;
    detectors.mass_join.threshold = clampNumber(settings.joinLimit, 8, 1, 100);
    detectors.mass_join.windowSeconds = clampNumber(settings.joinWindowSeconds, 20, 5, 300);
    detectors.young_account.threshold = clampNumber(settings.minAccountAgeDays, 7, 1, 365);
    detectors.webhook_spam.threshold = clampNumber(settings.webhookLimitPerMinute, 2, 1, 30);
  }
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
    notifyOwner: settings.notifyOwner !== false,
    ignoredChannels: cleanText(settings.ignoredChannels),
    notifyRoleIds: cleanText(settings.notifyRoleIds),
    autoRestore: settings.autoRestore !== false,
    warnMessage: cleanText(settings.warnMessage) || 'Sua mensagem violou as regras automaticas deste servidor.',
    detectors
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

function formatProtectionTimestamp(date = new Date()) {
  return date.toISOString();
}

async function recordProtectionDetection({
  guildId,
  detectorId,
  userId = null,
  channelId = null,
  messageId = null,
  actionTaken = 'logged',
  punishment = 'none',
  reason,
  auditExecutorId = null,
  metadata = {},
  actionApplied = false
}) {
  const createdAt = nowIso();
  try {
    await db.prepare(`
      INSERT INTO discord_protection_events (
        id, guild_id, detector_id, user_id, channel_id, message_id,
        action_taken, punishment, reason, audit_executor_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), guildId, detectorId, userId, channelId, messageId,
      actionTaken, punishment, String(reason || '').slice(0, 1000), auditExecutorId,
      JSON.stringify(metadata || {}).slice(0, 8000), createdAt
    );
    await db.prepare(`
      INSERT INTO discord_protection_stats (guild_id, detector_id, detections, actions, last_detected_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(guild_id, detector_id) DO UPDATE SET
        detections = discord_protection_stats.detections + 1,
        actions = discord_protection_stats.actions + excluded.actions,
        last_detected_at = excluded.last_detected_at
    `).run(guildId, detectorId, actionApplied ? 1 : 0, createdAt);
  } catch (error) {
    console.warn(`Falha ao persistir deteccao ${detectorId}: ${error.message}`);
  }
}

async function sendDetailedProtectionLog({
  guild,
  settings,
  detection,
  actorId,
  channelId = null,
  message = null,
  outcome = null,
  auditEntry = null,
  deleted = false
}) {
  const logChannelId = cleanText(settings.logChannelId);
  if (!logChannelId) return;
  const channel = await guild.channels.fetch(logChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const punishment = detectorConfig(settings, detection.detectorId).punishment;
  const actionTaken = [deleted ? 'Mensagem apagada' : '', outcome?.applied ? outcome.action || punishment : 'Somente log']
    .filter(Boolean)
    .join(' + ');
  const embed = new EmbedBuilder()
    .setColor(detection.severity === 'critical' ? 0xff3b30 : detection.severity === 'medium' ? 0xffb020 : 0xff5c5c)
    .setTitle(`Nexus Detection - ${detection.detectorName}`)
    .setDescription(String(detection.reason || 'Violacao detectada.').slice(0, 4000))
    .addFields(
      { name: 'Detector', value: `\`${detection.detectorId}\``, inline: true },
      { name: 'Usuario', value: actorId ? `<@${actorId}> (\`${actorId}\`)` : 'Nao identificado', inline: true },
      { name: 'Servidor', value: `${guild.name} (\`${guild.id}\`)`, inline: false },
      { name: 'Canal', value: channelId ? `<#${channelId}> (\`${channelId}\`)` : 'Nao aplicavel', inline: true },
      { name: 'Acao', value: actionTaken || 'Registrado', inline: true },
      { name: 'Punicao', value: `\`${punishment}\``, inline: true },
      { name: 'Audit executor', value: auditEntry?.executorId || auditEntry?.executor?.id ? `<@${auditEntry.executorId || auditEntry.executor.id}>` : 'Nao disponivel', inline: true },
      { name: 'Resultado', value: String(outcome?.detail || 'Deteccao registrada.').slice(0, 1000), inline: false }
    )
    .setTimestamp(new Date());
  const content = String(message?.content || '').trim();
  if (content) embed.addFields({ name: 'Conteudo', value: `\`\`\`\n${content.slice(0, 850)}\n\`\`\`` });
  if (detection.evidence && detection.evidence !== content) embed.addFields({ name: 'Evidencia', value: String(detection.evidence).slice(0, 900) });
  const notifyRoles = parseLineList(settings.notifyRoleIds).filter((id) => /^\d{5,32}$/.test(id)).slice(0, 10);
  await channel.send({
    content: notifyRoles.length ? notifyRoles.map((id) => `<@&${id}>`).join(' ') : undefined,
    embeds: [embed],
    allowedMentions: { roles: notifyRoles, parse: [] }
  }).catch(() => {});
}

async function protectionDiagnostics(guild, settings) {
  const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
  const warnings = [];
  const configuredPunishments = new Set([
    settings.punishment,
    ...Object.values(settings.detectors || {}).filter((item) => item.enabled).map((item) => item.punishment)
  ]);
  if (!me) warnings.push('Nao foi possivel localizar o bot como membro do servidor.');
  const has = (permission) => Boolean(me?.permissions?.has(permission));
  if (!has(PermissionFlagsBits.ViewAuditLog)) warnings.push('Falta View Audit Log para identificar quem alterou cargos e canais.');
  if (['remove_roles', 'quarantine'].some((item) => configuredPunishments.has(item)) && !has(PermissionFlagsBits.ManageRoles)) warnings.push('Falta Manage Roles para retirar/restaurar cargos.');
  if (configuredPunishments.has('timeout') && !has(PermissionFlagsBits.ModerateMembers)) warnings.push('Falta Moderate Members para aplicar timeout.');
  if (configuredPunishments.has('kick') && !has(PermissionFlagsBits.KickMembers)) warnings.push('Falta Kick Members.');
  if (configuredPunishments.has('ban') && !has(PermissionFlagsBits.BanMembers)) warnings.push('Falta Ban Members.');
  if (!has(PermissionFlagsBits.ManageMessages)) warnings.push('Falta Manage Messages para apagar o spam detectado.');
  if (settings.autoRestore && settings.backupChannels && !has(PermissionFlagsBits.ManageChannels)) warnings.push('Falta Manage Channels para restaurar/reverter canais.');
  if (settings.autoRestore && settings.backupRoles && !has(PermissionFlagsBits.ManageRoles)) warnings.push('Falta Manage Roles para restaurar/reverter cargos.');
  if (settings.autoRestore && !has(PermissionFlagsBits.ManageWebhooks)) warnings.push('Falta Manage Webhooks para remover webhooks nao autorizados.');
  if (detectorConfig(settings, 'invite_raid').enabled && !has(PermissionFlagsBits.ManageGuild)) warnings.push('Falta Manage Server para identificar o convite usado em uma raid.');
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
  if (punishment === 'warn') return { applied: true, action: 'warn', detail: 'Usuario avisado no canal.' };

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

const severityRank = Object.freeze({ low: 1, medium: 2, high: 3, critical: 4 });

async function executeProtectionDetections({
  runtimeEntry,
  guild,
  actorId,
  settings,
  detections,
  message = null,
  channelId = null,
  auditEntry = null,
  source = 'detector'
}) {
  if (!detections?.length) return null;
  const ordered = [...detections].sort((left, right) => (severityRank[right.severity] || 0) - (severityRank[left.severity] || 0));
  const primary = ordered[0];
  const primaryConfig = detectorConfig(settings, primary.detectorId);
  let deleted = false;
  if (message && ordered.some((item) => detectorConfig(settings, item.detectorId).deleteMessage)) {
    deleted = await message.delete().then(() => true).catch(() => false);
  }

  const cooldownKey = protectionWindowKey(runtimeEntry.token, guild.id, actorId || 'unknown', 'punishment');
  const now = Date.now();
  pruneTimedMap(protectionCooldowns, now);
  let outcome = { applied: false, skipped: true, detail: 'Castigo em cooldown; deteccao e log mantidos.' };
  if ((protectionCooldowns.get(cooldownKey) || 0) <= now) {
    protectionCooldowns.set(cooldownKey, now + 45_000);
    const reason = `${primary.detectorName}: ${primary.reason}`;
    outcome = await punishProtectionActor(
      guild,
      actorId,
      { ...settings, punishment: primaryConfig.punishment },
      `Nexus ${source}: ${reason}`.slice(0, 500)
    ).catch((error) => ({ applied: false, detail: error.message }));
    if (primaryConfig.punishment === 'warn') {
      let delivered = false;
      if (message?.channel?.isTextBased?.()) {
        delivered = Boolean(await message.channel.send({
          content: `<@${actorId}> ${settings.warnMessage}`.slice(0, 1900),
          allowedMentions: { users: [actorId], parse: [] }
        }).catch(() => null));
      } else {
        const warnedMember = actorId ? await guild.members.fetch(actorId).catch(() => null) : null;
        delivered = Boolean(await warnedMember?.send({
          content: `${settings.warnMessage}\nServidor: ${guild.name}`.slice(0, 1900),
          allowedMentions: { parse: [] }
        }).catch(() => null));
      }
      outcome = {
        ...outcome,
        applied: delivered,
        action: 'warn',
        detail: delivered ? 'Aviso enviado ao usuario.' : 'Nao foi possivel entregar o aviso ao usuario.'
      };
    }
  }

  for (const detection of ordered) {
    const cfg = detectorConfig(settings, detection.detectorId);
    const actionTaken = [deleted ? 'delete_message' : '', outcome?.applied ? outcome.action || cfg.punishment : 'log'].filter(Boolean).join('+');
    await recordProtectionDetection({
      guildId: guild.id,
      detectorId: detection.detectorId,
      userId: actorId,
      channelId: channelId || message?.channelId || null,
      messageId: message?.id || null,
      actionTaken,
      punishment: cfg.punishment,
      reason: detection.reason,
      auditExecutorId: auditEntry?.executorId || auditEntry?.executor?.id || null,
      metadata: {
        source,
        detectorName: detection.detectorName,
        severity: detection.severity,
        evidence: detection.evidence,
        timestamp: formatProtectionTimestamp()
      },
      actionApplied: Boolean(outcome?.applied || deleted)
    });
    await sendDetailedProtectionLog({
      guild,
      settings,
      detection,
      actorId,
      channelId: channelId || message?.channelId || null,
      message,
      outcome,
      auditEntry,
      deleted
    });
  }
  if (settings.notifyOwner && ordered.some((item) => item.severity === 'critical')) {
    const ownerNoticeKey = protectionWindowKey(runtimeEntry.token, guild.id, guild.ownerId, `owner-notice:${primary.detectorId}`);
    pruneTimedMap(protectionCooldowns, now);
    if ((protectionCooldowns.get(ownerNoticeKey) || 0) <= now) {
      protectionCooldowns.set(ownerNoticeKey, now + 60_000);
      const owner = await guild.fetchOwner().catch(() => null);
      await owner?.send({
        content: `Nexus detectou **${primary.detectorName}** em **${guild.name}**. Usuario: ${actorId || 'nao identificado'}. Acao: ${outcome?.detail || 'registrada nos logs'}.`.slice(0, 1900),
        allowedMentions: { parse: [] }
      }).catch(() => {});
    }
  }
  return outcome;
}

const protectionAuditActions = new Map([
  [AuditLogEvent.ChannelCreate, { label: 'criacao de canais', detectors: ['channel_create_spam', 'mass_channel_create'] }],
  [AuditLogEvent.ChannelDelete, { label: 'exclusao de canais', detectors: ['channel_delete_spam', 'mass_channel_delete'] }],
  [AuditLogEvent.ChannelUpdate, { label: 'alteracao de canais', detectors: ['channel_update_spam'] }],
  [AuditLogEvent.ChannelOverwriteCreate, { label: 'criacao de permissoes de canal', detectors: ['mass_permission_changes', 'dangerous_permission'] }],
  [AuditLogEvent.ChannelOverwriteUpdate, { label: 'alteracao de permissoes de canal', detectors: ['mass_permission_changes', 'dangerous_permission'] }],
  [AuditLogEvent.ChannelOverwriteDelete, { label: 'exclusao de permissoes de canal', detectors: ['mass_permission_changes'] }],
  [AuditLogEvent.RoleCreate, { label: 'criacao de cargos', detectors: ['role_create_spam', 'mass_role_create'] }],
  [AuditLogEvent.RoleDelete, { label: 'exclusao de cargos', detectors: ['role_delete_spam', 'mass_role_delete'] }],
  [AuditLogEvent.RoleUpdate, { label: 'alteracao de cargos', detectors: ['role_update_spam', 'mass_permission_changes'] }],
  [AuditLogEvent.MemberBanAdd, { label: 'banimentos', detectors: ['mass_ban'] }],
  [AuditLogEvent.MemberBanRemove, { label: 'desbanimentos', detectors: ['mass_unban'] }],
  [AuditLogEvent.MemberKick, { label: 'expulsoes', detectors: ['mass_kick'] }],
  [AuditLogEvent.MemberUpdate, { label: 'alteracao de membros', detectors: ['mass_timeout', 'member_mass_nickname'] }],
  [AuditLogEvent.MemberRoleUpdate, { label: 'alteracao de cargos de membros', detectors: ['mass_role_assignment', 'permission_escalation'] }],
  [AuditLogEvent.MemberMove, { label: 'movimentacao de voz', detectors: ['voice_move_spam'] }],
  [AuditLogEvent.MemberPrune, { label: 'limpeza de membros', detectors: ['mass_kick'] }],
  [AuditLogEvent.BotAdd, { label: 'adicao de bots', detectors: ['mass_bot_additions'] }],
  [AuditLogEvent.WebhookCreate, { label: 'criacao de webhooks', detectors: ['webhook_creation', 'webhook_spam', 'unauthorized_webhook', 'mass_webhook_create'] }],
  [AuditLogEvent.WebhookDelete, { label: 'exclusao de webhooks', detectors: ['webhook_deletion', 'webhook_spam', 'mass_webhook_delete'] }],
  [AuditLogEvent.WebhookUpdate, { label: 'alteracao de webhooks', detectors: ['webhook_spam', 'unauthorized_webhook'] }],
  [AuditLogEvent.GuildUpdate, { label: 'alteracao do servidor', detectors: ['mass_server_updates'] }],
  [AuditLogEvent.AutoModerationRuleCreate, { label: 'criacao de AutoMod', detectors: ['automod_change'] }],
  [AuditLogEvent.AutoModerationRuleUpdate, { label: 'alteracao de AutoMod', detectors: ['automod_change'] }],
  [AuditLogEvent.AutoModerationRuleDelete, { label: 'exclusao de AutoMod', detectors: ['automod_change'] }],
  [AuditLogEvent.EmojiCreate, { label: 'criacao de emojis', detectors: ['emoji_create_spam'] }],
  [AuditLogEvent.EmojiUpdate, { label: 'alteracao de emojis', detectors: ['emoji_update_spam'] }],
  [AuditLogEvent.EmojiDelete, { label: 'exclusao de emojis', detectors: ['emoji_delete_spam', 'mass_emoji_delete'] }],
  [AuditLogEvent.StickerCreate, { label: 'criacao de stickers', detectors: ['sticker_create_spam'] }],
  [AuditLogEvent.StickerUpdate, { label: 'alteracao de stickers', detectors: ['sticker_update_spam'] }],
  [AuditLogEvent.StickerDelete, { label: 'exclusao de stickers', detectors: ['sticker_delete_spam', 'mass_sticker_delete'] }],
  [AuditLogEvent.IntegrationCreate, { label: 'criacao de integracoes', detectors: ['integration_change', 'mass_integration_changes'] }],
  [AuditLogEvent.IntegrationUpdate, { label: 'alteracao de integracoes', detectors: ['integration_change', 'mass_integration_changes'] }],
  [AuditLogEvent.IntegrationDelete, { label: 'exclusao de integracoes', detectors: ['integration_change', 'mass_integration_changes'] }],
  [AuditLogEvent.ThreadCreate, { label: 'criacao de threads', detectors: ['thread_create_spam'] }],
  [AuditLogEvent.ThreadUpdate, { label: 'alteracao de threads', detectors: ['thread_update_spam'] }],
  [AuditLogEvent.ThreadDelete, { label: 'exclusao de threads', detectors: ['thread_delete_spam'] }],
  [AuditLogEvent.SoundboardSoundCreate, { label: 'criacao de som', detectors: ['soundboard_spam'] }],
  [AuditLogEvent.SoundboardSoundUpdate, { label: 'alteracao de som', detectors: ['soundboard_spam'] }],
  [AuditLogEvent.SoundboardSoundDelete, { label: 'exclusao de som', detectors: ['soundboard_spam'] }],
  [AuditLogEvent.StageInstanceCreate, { label: 'criacao de palco', detectors: ['stage_abuse'] }],
  [AuditLogEvent.StageInstanceUpdate, { label: 'alteracao de palco', detectors: ['stage_abuse'] }],
  [AuditLogEvent.StageInstanceDelete, { label: 'exclusao de palco', detectors: ['stage_abuse'] }]
].filter(([action]) => Number.isInteger(action)));

function auditChangeKeys(auditEntry) {
  return new Set((auditEntry?.changes || []).map((change) => String(change.key || '').toLowerCase()));
}

function auditDetectorIds(auditEntry, definition) {
  const ids = new Set(definition.detectors || []);
  const action = Number(auditEntry?.action);
  const target = auditEntry?.target;
  if ([AuditLogEvent.ChannelCreate, AuditLogEvent.ChannelDelete, AuditLogEvent.ChannelUpdate].includes(action) && Number(target?.type) === ChannelType.GuildCategory) {
    ids.delete('channel_create_spam');
    ids.delete('channel_delete_spam');
    ids.delete('channel_update_spam');
    if (action === AuditLogEvent.ChannelCreate) ids.add('category_create_spam');
    if (action === AuditLogEvent.ChannelDelete) ids.add('category_delete_spam');
    if (action === AuditLogEvent.ChannelUpdate) ids.add('category_update_spam');
  }
  if (action === AuditLogEvent.ChannelCreate && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(Number(target?.type))) {
    ids.add('voice_channel_spam');
  }
  const changes = auditChangeKeys(auditEntry);
  if (action === AuditLogEvent.RoleUpdate || action === AuditLogEvent.RoleCreate) {
    let permissionBits = 0n;
    try {
      const permissionChange = (auditEntry?.changes || []).find((change) => String(change.key).toLowerCase() === 'permissions');
      permissionBits = BigInt(permissionChange?.new || target?.permissions?.bitfield || 0);
    } catch {
      permissionBits = 0n;
    }
    const dangerousMask = PermissionFlagsBits.Administrator
      | PermissionFlagsBits.ManageGuild
      | PermissionFlagsBits.ManageRoles
      | PermissionFlagsBits.ManageChannels
      | PermissionFlagsBits.ManageWebhooks
      | PermissionFlagsBits.BanMembers
      | PermissionFlagsBits.KickMembers;
    if ((permissionBits & PermissionFlagsBits.Administrator) !== 0n) ids.add('administrator_permission');
    if ((permissionBits & dangerousMask) !== 0n) ids.add('dangerous_permission');
    if (changes.has('permissions')) ids.add('permission_escalation');
  }
  if (action === AuditLogEvent.MemberUpdate) {
    if (!changes.has('communication_disabled_until')) ids.delete('mass_timeout');
    if (!changes.has('nick')) {
      ids.delete('member_mass_nickname');
      ids.delete('mass_nickname_change');
    } else {
      ids.add('mass_nickname_change');
    }
  }
  if (action === AuditLogEvent.GuildUpdate) {
    if (changes.has('name')) ids.add('server_name_change');
    if (changes.has('icon_hash') || changes.has('icon')) ids.add('server_icon_change');
    if (changes.has('banner_hash') || changes.has('banner')) ids.add('server_banner_change');
    if (changes.has('vanity_url_code')) ids.add('vanity_url_change');
    if (changes.has('verification_level')) ids.add('verification_level_change');
    if (changes.has('features') || changes.has('rules_channel_id') || changes.has('public_updates_channel_id')) ids.add('community_setting_change');
  }
  return [...ids];
}

function auditTargetKey(runtimeEntry, guildId, action, targetId) {
  return `${protectionKey(runtimeEntry.token, guildId)}:${action}:${targetId || 'any'}`;
}

function resourceSnapshotKey(runtimeEntry, guildId, targetId) {
  return `${protectionKey(runtimeEntry.token, guildId)}:${targetId}`;
}

function rememberResourceSnapshot(runtimeEntry, guild, target, snapshot) {
  if (!guild?.id || !target?.id) return;
  resourceSnapshots.set(resourceSnapshotKey(runtimeEntry, guild.id, target.id), {
    ...snapshot,
    target,
    expiresAt: Date.now() + 60_000
  });
}

async function restoreProtectedResource(runtimeEntry, guild, auditEntry, settings) {
  if (!settings.autoRestore) return null;
  for (const [key, value] of resourceSnapshots) {
    if (Number(value?.expiresAt || 0) <= Date.now()) resourceSnapshots.delete(key);
  }
  const targetId = auditEntry.targetId || auditEntry.target?.id || null;
  if (!targetId) return null;
  const action = Number(auditEntry.action);
  const reason = `Nexus: reversao automatica da acao ${auditEntry.id}`;
  try {
    if (action === AuditLogEvent.ChannelCreate) {
      const channel = await guild.channels.fetch(targetId).catch(() => null);
      if (channel?.deletable) {
        await channel.delete(reason);
        return `Canal criado sem autorizacao foi removido (${targetId}).`;
      }
    }
    if (action === AuditLogEvent.RoleCreate) {
      const role = await guild.roles.fetch(targetId).catch(() => null);
      if (role?.editable) {
        await role.delete(reason);
        return `Cargo criado sem autorizacao foi removido (${targetId}).`;
      }
    }
    if (action === AuditLogEvent.WebhookCreate) {
      const webhooks = await guild.fetchWebhooks().catch(() => null);
      const webhook = webhooks?.get(targetId);
      if (webhook) {
        await webhook.delete(reason);
        return `Webhook nao autorizado removido (${targetId}).`;
      }
    }
    if (action === AuditLogEvent.BotAdd) {
      const botMember = await guild.members.fetch(targetId).catch(() => null);
      if (botMember?.user?.bot && botMember.kickable) {
        await botMember.kick(reason);
        return `Bot adicionado durante ataque foi removido (${targetId}).`;
      }
    }
  } catch (error) {
    return `Falha ao reverter recurso criado: ${error.message}`;
  }
  const key = resourceSnapshotKey(runtimeEntry, guild.id, targetId);
  const snapshot = resourceSnapshots.get(key);
  if (!snapshot) return null;
  resourceSnapshots.delete(key);
  try {
    if (snapshot.kind === 'channel-delete' && settings.backupChannels && typeof snapshot.target.clone === 'function') {
      const restored = await snapshot.target.clone({ reason });
      if (Number.isInteger(snapshot.position)) await restored.setPosition(snapshot.position, { reason }).catch(() => {});
      return `Canal restaurado como #${restored.name} (${restored.id}).`;
    }
    if (snapshot.kind === 'role-delete' && settings.backupRoles) {
      const restored = await guild.roles.create({
        name: snapshot.target.name,
        color: snapshot.target.color,
        hoist: snapshot.target.hoist,
        permissions: snapshot.target.permissions.bitfield,
        mentionable: snapshot.target.mentionable,
        icon: snapshot.target.iconURL?.() || undefined,
        unicodeEmoji: snapshot.target.unicodeEmoji || undefined,
        reason
      });
      if (Number.isInteger(snapshot.position)) await restored.setPosition(snapshot.position, { reason }).catch(() => {});
      return `Cargo restaurado como ${restored.name} (${restored.id}).`;
    }
    if (snapshot.kind === 'channel-update' && settings.backupChannels && typeof snapshot.target?.edit === 'function') {
      await snapshot.target.edit({ ...snapshot.options, reason });
      return `Alteracao do canal ${snapshot.target.id} revertida.`;
    }
    if (snapshot.kind === 'role-update' && settings.backupRoles && snapshot.target?.editable && typeof snapshot.target?.edit === 'function') {
      await snapshot.target.edit({ ...snapshot.options, reason });
      return `Alteracao do cargo ${snapshot.target.id} revertida.`;
    }
    if (snapshot.kind === 'guild-update' && typeof snapshot.target?.edit === 'function') {
      await snapshot.target.edit({ ...snapshot.options, reason });
      return `Alteracoes criticas do servidor ${snapshot.target.id} foram revertidas.`;
    }
  } catch (error) {
    return `Falha ao restaurar recurso: ${error.message}`;
  }
  return null;
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
  const detections = [];
  const resolvedDetectorIds = new Set(auditDetectorIds(auditEntry, definition));
  if (Number(auditEntry.action) === AuditLogEvent.MemberRoleUpdate && resolvedDetectorIds.has('permission_escalation')) {
    const addedRoleIds = (auditEntry.changes || [])
      .filter((change) => String(change.key).toLowerCase() === '$add')
      .flatMap((change) => Array.isArray(change.new) ? change.new : [])
      .map((role) => role.id)
      .filter(Boolean);
    const dangerousMask = PermissionFlagsBits.Administrator
      | PermissionFlagsBits.ManageGuild
      | PermissionFlagsBits.ManageRoles
      | PermissionFlagsBits.ManageChannels
      | PermissionFlagsBits.ManageWebhooks
      | PermissionFlagsBits.BanMembers
      | PermissionFlagsBits.KickMembers;
    const dangerousAssigned = addedRoleIds.some((roleId) => {
      const role = guild.roles.cache.get(roleId);
      return role && (role.permissions.bitfield & dangerousMask) !== 0n;
    });
    if (!dangerousAssigned) resolvedDetectorIds.delete('permission_escalation');
  }
  for (const detectorId of resolvedDetectorIds) {
    const cfg = detectorConfig(settings, detectorId);
    if (!cfg.enabled) continue;
    const key = protectionWindowKey(runtimeEntry.token, guild.id, actorId, `audit:${detectorId}`);
    const eventCount = recordProtectionEvent(key, cfg.windowSeconds * 1000, now);
    if (eventCount < cfg.threshold) continue;
    const detector = detectorDefinition(detectorId);
    detections.push({
      detectorId,
      detectorName: detector?.label || detectorId,
      category: detector?.category || 'audit',
      severity: detector?.severity || 'high',
      reason: `${eventCount} acao(oes) em ${cfg.windowSeconds}s: ${definition.label}${targetId ? ` (alvo ${targetId})` : ''}`,
      evidence: (auditEntry.changes || []).map((change) => change.key).filter(Boolean).join(', ')
    });
    protectionWindows.delete(key);
  }
  if (!detections.length) return;
  const outcome = await executeProtectionDetections({
    runtimeEntry,
    guild,
    actorId,
    settings,
    detections,
    channelId: auditEntry.target?.channelId || auditEntry.target?.parentId || null,
    auditEntry,
    source: 'audit-log'
  });
  const restoration = await restoreProtectedResource(runtimeEntry, guild, auditEntry, settings);
  if (restoration) {
    await sendProtectionLog(guild, settings, `Nexus recovery: ${restoration}`);
    if (outcome) outcome.detail = `${outcome.detail || ''} ${restoration}`.trim();
  }
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
  const ignoredChannels = new Set(parseLineList(settings.ignoredChannels));
  if (ignoredChannels.has(message.channelId) || (message.channel?.parentId && ignoredChannels.has(message.channel.parentId))) return;

  const now = Date.now();
  const actorId = message.author.id;
  const historyKey = protectionWindowKey(runtimeEntry.token, guild.id, actorId, 'message-history');
  const records = (messageHistories.get(historyKey) || []).filter((record) => record.timestamp >= now - 5 * 60_000);
  records.push(makeMessageRecord(message, now));
  while (records.length > 100) records.shift();
  messageHistories.set(historyKey, records);
  const detections = evaluateMessageDetectors({ message, records, settings, now });
  if (!detections.length) return;
  await executeProtectionDetections({
    runtimeEntry,
    guild,
    actorId,
    settings,
    detections,
    message,
    channelId: message.channelId,
    source: 'message'
  });
}

async function handleProtectionJoin(runtimeEntry, member) {
  if (!member?.guild) return;
  const guild = member.guild;
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, guild.id));
  if (!settings?.enabled || isTrustedActorId(guild, settings, member.id)) return;
  const detections = evaluateProfileDetectors({
    member,
    settings,
    guildName: guild.name,
    botName: guild.client.user?.username || ''
  });
  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  const now = Date.now();
  for (const detectorId of ['mass_join', 'join_rate', 'bot_raid', 'new_account_raid']) {
    const cfg = detectorConfig(settings, detectorId);
    if (!cfg.enabled) continue;
    if (detectorId === 'bot_raid' && !member.user.bot) continue;
    if (detectorId === 'new_account_raid' && accountAgeDays >= Number(settings.minAccountAgeDays || 7)) continue;
    const count = recordProtectionEvent(
      protectionWindowKey(runtimeEntry.token, guild.id, 'all', `join:${detectorId}`),
      cfg.windowSeconds * 1000,
      now
    );
    if (count < cfg.threshold) continue;
    const definition = detectorDefinition(detectorId);
    detections.push({
      detectorId,
      detectorName: definition?.label || detectorId,
      category: definition?.category || 'raids',
      severity: definition?.severity || 'high',
      reason: `${count} entrada(s) em ${cfg.windowSeconds}s`,
      evidence: `conta=${member.id}; idade=${accountAgeDays.toFixed(1)}d; bot=${member.user.bot}`
    });
  }
  if (!detections.length) return;
  await executeProtectionDetections({
    runtimeEntry,
    guild,
    actorId: member.id,
    settings,
    detections,
    source: 'member-join'
  });
}

async function handleProtectionProfileUpdate(runtimeEntry, before, after) {
  if (!after?.guild || after.user?.bot) return;
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, after.guild.id));
  if (!settings?.enabled || isTrustedActorId(after.guild, settings, after.id) || hasIgnoredRole(after, settings)) return;
  const identityChanged = before.nickname !== after.nickname
    || before.user?.username !== after.user?.username
    || before.user?.globalName !== after.user?.globalName;
  if (!identityChanged) return;
  const detections = evaluateProfileDetectors({
    member: after,
    settings,
    guildName: after.guild.name,
    botName: after.client.user?.username || ''
  }).filter((item) => !['new_account', 'young_account', 'default_avatar', 'alt_account'].includes(item.detectorId));
  if (!detections.length) return;
  await executeProtectionDetections({
    runtimeEntry,
    guild: after.guild,
    actorId: after.id,
    settings,
    detections,
    source: 'profile-update'
  });
}

async function handleProtectionRateDetector(runtimeEntry, guild, actorId, detectorId, evidence = '', channelId = null, counterScope = actorId) {
  if (!guild?.id || !actorId) return;
  const settings = protectionSettings.get(protectionKey(runtimeEntry.token, guild.id));
  if (!settings?.enabled || isTrustedActorId(guild, settings, actorId)) return;
  const member = guild.members.cache.get(actorId);
  if (member && hasIgnoredRole(member, settings)) return;
  const cfg = detectorConfig(settings, detectorId);
  if (!cfg.enabled) return;
  const count = recordProtectionEvent(
    protectionWindowKey(runtimeEntry.token, guild.id, counterScope, `rate:${detectorId}`),
    cfg.windowSeconds * 1000
  );
  if (count < cfg.threshold) return;
  protectionWindows.delete(protectionWindowKey(runtimeEntry.token, guild.id, counterScope, `rate:${detectorId}`));
  const definition = detectorDefinition(detectorId);
  await executeProtectionDetections({
    runtimeEntry,
    guild,
    actorId,
    settings,
    channelId,
    source: detectorId,
    detections: [{
      detectorId,
      detectorName: definition?.label || detectorId,
      category: definition?.category || 'unknown',
      severity: definition?.severity || 'high',
      reason: `${count} evento(s) em ${cfg.windowSeconds}s`,
      evidence
    }]
  });
}

async function refreshInviteSnapshot(runtimeEntry, guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  const key = protectionKey(runtimeEntry.token, guild.id);
  const current = new Map(invites.map((invite) => [invite.code, Number(invite.uses || 0)]));
  const previous = inviteSnapshots.get(key) || new Map();
  inviteSnapshots.set(key, current);
  return { previous, current };
}

async function handleInviteRaid(runtimeEntry, member) {
  const compared = await refreshInviteSnapshot(runtimeEntry, member.guild);
  if (!compared || !compared.previous.size) return;
  const usedCode = [...compared.current].find(([code, uses]) => uses > Number(compared.previous.get(code) || 0))?.[0];
  if (!usedCode) return;
  await handleProtectionRateDetector(
    runtimeEntry,
    member.guild,
    member.id,
    'invite_raid',
    `convite=${usedCode}; membro=${member.id}`,
    null,
    `invite:${usedCode}`
  );
}

function attachProtectionHandlers(entry) {
  if (entry.protectionHandlersAttached) return;
  entry.protectionHandlersAttached = true;
  const client = entry.client;

  client.on(Events.InteractionCreate, (interaction) => {
    void handleSalesInteraction(entry, interaction).catch((error) => {
      console.warn(`[nexus] Falha no comando de vendas: ${error.message}`);
    });
  });

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
  client.on(Events.ChannelDelete, (channel) => {
    rememberResourceSnapshot(entry, channel.guild, channel, { kind: 'channel-delete', position: channel.rawPosition });
    void handleAuditFallback(entry, channel.guild, [AuditLogEvent.ChannelDelete], channel.id);
  });
  client.on(Events.ChannelUpdate, (before, after) => {
    rememberResourceSnapshot(entry, after.guild, after, {
      kind: 'channel-update',
      options: {
        name: before.name,
        parent: before.parentId,
        position: before.rawPosition,
        topic: before.topic,
        nsfw: before.nsfw,
        rateLimitPerUser: before.rateLimitPerUser,
        permissionOverwrites: before.permissionOverwrites?.cache?.map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield
        }))
      }
    });
    void handleAuditFallback(entry, after.guild, [AuditLogEvent.ChannelUpdate], after.id);
  });
  fallback(Events.GuildRoleCreate, [AuditLogEvent.RoleCreate]);
  client.on(Events.GuildRoleDelete, (role) => {
    rememberResourceSnapshot(entry, role.guild, role, { kind: 'role-delete', position: role.rawPosition });
    void handleAuditFallback(entry, role.guild, [AuditLogEvent.RoleDelete], role.id);
  });
  client.on(Events.GuildRoleUpdate, (before, after) => {
    rememberResourceSnapshot(entry, after.guild, after, {
      kind: 'role-update',
      options: {
        name: before.name,
        color: before.color,
        hoist: before.hoist,
        permissions: before.permissions.bitfield,
        mentionable: before.mentionable
      }
    });
    void handleAuditFallback(entry, after.guild, [AuditLogEvent.RoleUpdate], after.id);
  });
  fallback(Events.GuildBanAdd, [AuditLogEvent.MemberBanAdd]);
  fallback(Events.GuildBanRemove, [AuditLogEvent.MemberBanRemove]);
  fallback(Events.WebhooksUpdate, [AuditLogEvent.WebhookCreate, AuditLogEvent.WebhookDelete, AuditLogEvent.WebhookUpdate], (channel) => channel?.guild, () => null);
  fallback(Events.ThreadCreate, [AuditLogEvent.ThreadCreate]);
  fallback(Events.ThreadDelete, [AuditLogEvent.ThreadDelete]);
  fallback(Events.ThreadUpdate, [AuditLogEvent.ThreadUpdate]);
  fallback(Events.GuildEmojiCreate, [AuditLogEvent.EmojiCreate], (emoji) => emoji.guild);
  fallback(Events.GuildEmojiDelete, [AuditLogEvent.EmojiDelete], (emoji) => emoji.guild);
  fallback(Events.GuildEmojiUpdate, [AuditLogEvent.EmojiUpdate], (emoji) => emoji.guild);
  fallback(Events.GuildStickerCreate, [AuditLogEvent.StickerCreate], (sticker) => sticker.guild);
  fallback(Events.GuildStickerDelete, [AuditLogEvent.StickerDelete], (sticker) => sticker.guild);
  fallback(Events.GuildStickerUpdate, [AuditLogEvent.StickerUpdate], (sticker) => sticker.guild);
  fallback(Events.AutoModerationRuleCreate, [AuditLogEvent.AutoModerationRuleCreate], (rule) => rule.guild);
  fallback(Events.AutoModerationRuleDelete, [AuditLogEvent.AutoModerationRuleDelete], (rule) => rule.guild);
  fallback(Events.AutoModerationRuleUpdate, [AuditLogEvent.AutoModerationRuleUpdate], (rule) => rule.guild);
  fallback(Events.GuildSoundboardSoundCreate, [AuditLogEvent.SoundboardSoundCreate], (sound) => sound.guild);
  fallback(Events.GuildSoundboardSoundDelete, [AuditLogEvent.SoundboardSoundDelete], (sound) => sound.guild);
  fallback(Events.GuildSoundboardSoundUpdate, [AuditLogEvent.SoundboardSoundUpdate], (sound) => sound.guild);
  fallback(Events.StageInstanceCreate, [AuditLogEvent.StageInstanceCreate], (stage) => stage.guild);
  fallback(Events.StageInstanceDelete, [AuditLogEvent.StageInstanceDelete], (stage) => stage.guild);
  fallback(Events.StageInstanceUpdate, [AuditLogEvent.StageInstanceUpdate], (stage) => stage.guild);
  client.on(Events.GuildIntegrationsUpdate, (guild) => {
    void handleAuditFallback(entry, guild, [AuditLogEvent.IntegrationCreate, AuditLogEvent.IntegrationUpdate, AuditLogEvent.IntegrationDelete], null);
  });
  client.on(Events.GuildUpdate, (before, after) => {
    rememberResourceSnapshot(entry, after, after, {
      kind: 'guild-update',
      options: {
        name: before.name,
        icon: before.iconURL?.({ extension: 'png', size: 1024 }) || null,
        banner: before.bannerURL?.({ extension: 'png', size: 1024 }) || null,
        verificationLevel: before.verificationLevel,
        explicitContentFilter: before.explicitContentFilter,
        defaultMessageNotifications: before.defaultMessageNotifications,
        afkChannel: before.afkChannelId,
        afkTimeout: before.afkTimeout,
        systemChannel: before.systemChannelId,
        systemChannelFlags: before.systemChannelFlags?.bitfield,
        rulesChannel: before.rulesChannelId,
        publicUpdatesChannel: before.publicUpdatesChannelId,
        preferredLocale: before.preferredLocale,
        description: before.description
      }
    });
    void handleAuditFallback(entry, after, [AuditLogEvent.GuildUpdate], after.id);
  });
  client.on(Events.GuildMemberUpdate, (before, after) => {
    const beforeRoles = [...before.roles.cache.keys()].sort().join(',');
    const afterRoles = [...after.roles.cache.keys()].sort().join(',');
    if (beforeRoles !== afterRoles) void handleAuditFallback(entry, after.guild, [AuditLogEvent.MemberRoleUpdate], after.id);
    if (before.nickname !== after.nickname) void handleAuditFallback(entry, after.guild, [AuditLogEvent.MemberUpdate], after.id);
    void handleProtectionProfileUpdate(entry, before, after);
  });
  client.on(Events.GuildMemberAdd, (member) => {
    void handleProtectionJoin(entry, member);
    void handleInviteRaid(entry, member);
    if (member.user.bot) void handleAuditFallback(entry, member.guild, [AuditLogEvent.BotAdd], member.id);
  });
  client.on(Events.InviteCreate, (invite) => {
    if (invite.guild) void refreshInviteSnapshot(entry, invite.guild);
  });
  client.on(Events.InviteDelete, (invite) => {
    if (invite.guild) void refreshInviteSnapshot(entry, invite.guild);
  });
  client.on(Events.VoiceStateUpdate, (before, after) => {
    const member = after.member || before.member;
    if (!member || member.user.bot) return;
    if (!before.channelId && after.channelId) {
      void handleProtectionRateDetector(entry, member.guild, member.id, 'voice_join_spam', `canal=${after.channelId}`, after.channelId);
    } else if (before.channelId && !after.channelId) {
      void handleProtectionRateDetector(entry, member.guild, member.id, 'voice_leave_spam', `canal=${before.channelId}`, before.channelId);
    } else if (before.channelId && after.channelId && before.channelId !== after.channelId) {
      void handleProtectionRateDetector(entry, member.guild, member.id, 'voice_move_spam', `${before.channelId} -> ${after.channelId}`, after.channelId);
    }
    if (before.suppress !== after.suppress || before.requestToSpeakTimestamp !== after.requestToSpeakTimestamp) {
      void handleProtectionRateDetector(entry, member.guild, member.id, 'stage_abuse', 'Mudancas repetidas no estado de palco.', after.channelId || before.channelId);
    }
  });
  client.on(Events.VoiceChannelEffectSend, (effect) => {
    void handleProtectionRateDetector(entry, effect.guild, effect.userId, 'soundboard_spam', `som=${effect.soundId || 'efeito'}`, effect.channelId);
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
      void registerSalesCommand(entry).catch((error) => {
        console.warn(`[nexus] Comando de vendas nao registrado: ${error.message}`);
      });
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
  await refreshInviteSnapshot(entry, discordGuild).catch(() => null);
  const diagnostics = await protectionDiagnostics(discordGuild, nextSettings);
  if (persist) await persistDiscordProtection(token, guild, entry.client.user?.id, nextSettings);
  await sendProtectionLog(
    discordGuild,
    nextSettings,
    `Protecao Nexus ${nextSettings.enabled ? 'ativada' : 'desativada'} para este servidor.${diagnostics.warnings.length ? ` Avisos: ${diagnostics.warnings.join(' | ')}` : ' Permissoes principais verificadas.'}`
  );
  return { ok: true, guildId: guild, protection: nextSettings, diagnostics };
}

export function getDiscordProtectionCatalog() {
  return detectorCatalogResponse();
}

export async function getDiscordProtectionStats({ guildId, limit = 50 } = {}) {
  const guild = assertSnowflake(guildId, 'Servidor ID');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const stats = await db.prepare(`
    SELECT guild_id, detector_id, detections, actions, last_detected_at
    FROM discord_protection_stats
    WHERE guild_id = ?
    ORDER BY detections DESC, detector_id ASC
  `).all(guild);
  const events = await db.prepare(`
    SELECT id, guild_id, detector_id, user_id, channel_id, message_id,
           action_taken, punishment, reason, audit_executor_id, metadata_json, created_at
    FROM discord_protection_events
    WHERE guild_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(guild, safeLimit);
  return {
    guildId: guild,
    totals: {
      detections: stats.reduce((total, row) => total + Number(row.detections || 0), 0),
      actions: stats.reduce((total, row) => total + Number(row.actions || 0), 0)
    },
    stats,
    events: events.map((event) => {
      let metadata = {};
      try {
        metadata = JSON.parse(event.metadata_json || '{}');
      } catch {
        metadata = {};
      }
      const { metadata_json: _metadataJson, ...rest } = event;
      return { ...rest, metadata };
    })
  };
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
