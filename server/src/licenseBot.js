import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { config } from './config.js';
import { botApiRequest } from './botApiClient.js';
import {
  getExistingSupportConfig,
  saveExistingSupportConfig,
  showExistingSupport
} from './generatorBot.js';
import { logAudit } from './audit.js';
import { claimInteractionCooldown } from './interactionPolicy.js';

const COMMAND_NAMES = new Set(['nexus', 'licenca', 'resgatar', 'loader', 'hwid', 'historico']);
const COMPONENT_PREFIX = 'nexus_';
const cooldowns = new Map();
const COLOR = 0x0A0A0A;

function clean(value) {
  return String(value || '').trim();
}

function discordDate(value, style = 'f', fallback = 'Não disponível') {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? `<t:${Math.floor(timestamp / 1000)}:${style}>` : fallback;
}

function statusLabel(status) {
  return {
    active: 'Ativa',
    suspended: 'Suspensa',
    expired: 'Expirada',
    revoked: 'Revogada'
  }[status] || 'Indisponível';
}

function eventLabel(type) {
  return {
    validated: 'Licença validada',
    hwid_bound: 'HWID vinculado',
    hwid_mismatch: 'HWID diferente',
    hwid_reset: 'HWID resetado',
    auto_suspended: 'Suspensão automática',
    status_rejected: 'Acesso recusado',
    expired_rejected: 'Licença expirada',
    key_regenerated: 'Key alterada',
    key_redeemed: 'Key resgatada',
    loader_ticket_created: 'Acesso temporário criado',
    loader_ticket_used: 'Loader utilizado',
    loader_ticket_rejected: 'Acesso temporário recusado',
    license_viewed: 'Licença consultada',
    redeem_rejected: 'Resgate recusado',
    created: 'Licença criada',
    updated: 'Licença atualizada'
  }[type] || clean(type).replaceAll('_', ' ');
}

function baseEmbed(interaction, title, description = '') {
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(title)
    .setDescription(description || ' ')
    .setFooter({ text: 'Nexus • Licenciamento oficial' })
    .setTimestamp();
  const avatar = interaction.client?.user?.displayAvatarURL?.({ size: 256 });
  if (avatar) embed.setThumbnail(avatar);
  try {
    const banner = new URL('/nexus-discord-banner.png', config.apiPublicUrl);
    if (/^https?:$/.test(banner.protocol)) embed.setImage(banner.href);
  } catch {
    // O banner é opcional.
  }
  return embed;
}

function panelRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nexus_license_view').setLabel('Minha Licença').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus_key_redeem').setLabel('Resgatar Key').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus_loader_copy').setLabel('Copiar Loader').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nexus_hwid_reset').setLabel('Resetar HWID').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus_history_view').setLabel('Histórico').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus_support').setLabel('Suporte').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus_panel_refresh').setLabel('Atualizar').setStyle(ButtonStyle.Secondary)
    )
  ];
}

function panelEmbed(interaction) {
  return baseEmbed(
    interaction,
    'Nexus — Central do Usuário',
    'Gerencie sua licença, resgate sua key e acesse o loader oficial do Nexus.\n\nTodas as informações pessoais são exibidas somente para quem clicar.'
  );
}

function licenseEmbed(interaction, license, loader = null) {
  const remaining = license.expiresAt
    ? `${Math.max(0, Number(license.daysRemaining || 0))} dia(s)`
    : 'Lifetime';
  return baseEmbed(interaction, 'Nexus — Minha Licença', 'Informações privadas da sua licença Nexus.')
    .setAuthor({
      name: interaction.user.globalName || interaction.user.username,
      iconURL: interaction.user.displayAvatarURL({ size: 128 })
    })
    .addFields(
      { name: 'Discord', value: `<@${interaction.user.id}>\n\`${interaction.user.id}\``, inline: true },
      { name: 'Plano', value: license.plan || 'Não disponível', inline: true },
      { name: 'Status', value: statusLabel(license.status), inline: true },
      { name: 'Expiração', value: license.expiresAt ? discordDate(license.expiresAt) : 'Lifetime', inline: true },
      { name: 'Tempo restante', value: remaining, inline: true },
      { name: 'Key', value: `\`${license.keyPreview || 'Não disponível'}\``, inline: true },
      { name: 'HWID', value: license.hwidBound ? 'Vinculado' : 'Aguardando primeiro uso', inline: true },
      { name: 'Resets', value: `${license.hwidResetCount} de ${license.hwidResetLimit} utilizados`, inline: true },
      { name: 'Última utilização', value: discordDate(license.lastUsedAt, 'R'), inline: true },
      { name: 'Versão utilizada', value: license.lastLoaderVersion || 'Ainda não utilizada', inline: true },
      { name: 'Versão atual do loader', value: loader?.version || 'Nenhuma versão ativa', inline: true },
      { name: 'Cliente desde', value: discordDate(license.createdAt), inline: true }
    );
}

function privatePayload(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
}

async function replyPrivate(interaction, payload) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  if (
    (interaction.isButton?.() || interaction.isStringSelectMenu?.())
    && interaction.message?.flags?.has?.(MessageFlags.Ephemeral)
  ) {
    return interaction.update(payload);
  }
  return interaction.reply(privatePayload(payload));
}

async function deferPrivate(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

function enforceCooldown(interaction) {
  const key = `${interaction.user.id}:${interaction.customId || interaction.commandName || 'interaction'}`;
  const result = claimInteractionCooldown(
    cooldowns,
    key,
    config.loader.rateLimits.botCooldownSeconds * 1000
  );
  if (!result.allowed) {
    const error = new Error('Aguarde alguns segundos antes de tentar novamente.');
    error.code = 'RATE_LIMITED';
    throw error;
  }
}

async function api(path, options) {
  return botApiRequest(path, options);
}

async function ensureConfiguredPanelChannel(interaction) {
  if (!interaction.guildId || !interaction.channelId) return;
  if (config.discordBot.allowedGuildIds.length && !config.discordBot.allowedGuildIds.includes(interaction.guildId)) {
    throw new Error('Este servidor não está autorizado para o painel Nexus.');
  }
  const guildConfig = await getExistingSupportConfig(interaction.guildId);
  const allowed = new Set(config.discordBot.allowedChannelIds);
  if (guildConfig?.panelChannelId) allowed.add(guildConfig.panelChannelId);
  if (allowed.size && !allowed.has(interaction.channelId)) {
    throw new Error('Use o painel no canal autorizado do Nexus.');
  }
}

async function showLicense(interaction) {
  await deferPrivate(interaction);
  const payload = await api(`/api/bot/nexus/license?discordId=${interaction.user.id}`);
  return interaction.editReply({ embeds: [licenseEmbed(interaction, payload.license, payload.loader)], components: [] });
}

async function showLoader(interaction) {
  await deferPrivate(interaction);
  const payload = await api(`/api/bot/nexus/loader?discordId=${interaction.user.id}`);
  const loader = payload.loader;
  const embed = baseEmbed(interaction, 'Nexus — Loader Oficial', 'Use somente o endereço oficial abaixo.')
    .addFields(
      { name: 'Serviço', value: loader.status === 'online' ? 'Online' : 'Indisponível', inline: true },
      { name: 'Versão ativa', value: loader.version || 'Nenhuma', inline: true },
      { name: 'Última publicação', value: discordDate(loader.publishedAt), inline: true },
      { name: 'Link fixo', value: `\`\`\`text\n${loader.bootstrapUrl}\n\`\`\`` },
      { name: 'Loadstring', value: `\`\`\`lua\n${loader.loadstring}\n\`\`\`` }
    );
  return interaction.editReply({ embeds: [embed], components: [] });
}

async function showHistory(interaction) {
  await deferPrivate(interaction);
  const payload = await api(`/api/bot/nexus/history?discordId=${interaction.user.id}`);
  const lines = payload.events.length
    ? payload.events.map((event, index) => {
      const version = event.loaderVersion ? ` • \`${event.loaderVersion}\`` : '';
      return `**${index + 1}. ${eventLabel(event.type)}**${version}\n${discordDate(event.createdAt, 'R')}`;
    }).join('\n\n')
    : 'Nenhuma ocorrência registrada.';
  const embed = baseEmbed(interaction, 'Nexus — Histórico', 'Últimas 10 ocorrências da sua licença.')
    .addFields({ name: 'Atividade recente', value: lines.slice(0, 3900) });
  return interaction.editReply({ embeds: [embed], components: [] });
}

function redeemModal() {
  const input = new TextInputBuilder()
    .setCustomId('nexus_key_value')
    .setLabel('Key do Nexus')
    .setPlaceholder('NXS-XXXXX-XXXXX-XXXXX-XXXXX')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(12)
    .setMaxLength(160);
  return new ModalBuilder()
    .setCustomId('nexus_key_redeem_submit')
    .setTitle('Resgatar Key Nexus')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function redeemKey(interaction, key) {
  await deferPrivate(interaction);
  const payload = await api('/api/bot/nexus/redeem', {
    method: 'POST',
    body: { discordId: interaction.user.id, key }
  });
  const embed = licenseEmbed(interaction, payload.license)
    .setTitle('Nexus — Key Resgatada')
    .setDescription('Sua key foi vinculada com sucesso ao seu Discord.');
  return interaction.editReply({ embeds: [embed], components: [] });
}

async function showResetConfirmation(interaction) {
  await deferPrivate(interaction);
  const payload = await api(`/api/bot/nexus/license?discordId=${interaction.user.id}`);
  const license = payload.license;
  const embed = baseEmbed(interaction, 'Nexus — Confirmar Reset de HWID', [
    `Você utilizou **${license.hwidResetCount}** de **${license.hwidResetLimit}** reset(s).`,
    '',
    'A associação Roblox da tag será limpa.',
    'O próximo dispositivo será vinculado no próximo uso.'
  ].join('\n'));
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nexus_hwid_reset_confirm').setLabel('Confirmar reset').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('nexus_hwid_reset_cancel').setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  );
  return interaction.editReply({ embeds: [embed], components: [row] });
}

async function confirmReset(interaction) {
  await deferPrivate(interaction);
  const payload = await api('/api/bot/nexus/hwid/reset', {
    method: 'POST',
    body: { discordId: interaction.user.id }
  });
  const embed = licenseEmbed(interaction, payload.license)
    .setTitle('Nexus — HWID Resetado')
    .setDescription(payload.message);
  return interaction.editReply({ embeds: [embed], components: [] });
}

async function refreshPanel(interaction) {
  return interaction.update({
    embeds: [panelEmbed(interaction)],
    components: panelRows(),
    allowedMentions: { parse: [] }
  });
}

async function publishPanel(interaction) {
  if (!interaction.guild || !interaction.channel?.isTextBased?.()) {
    return interaction.reply(privatePayload({ content: 'Este comando só funciona em um canal de servidor.' }));
  }
  const access = await api(`/api/bot/nexus/panel/access?discordId=${interaction.user.id}`);
  if (!access.authorized) {
    return interaction.reply(privatePayload({ content: 'Você não possui autorização para publicar o painel.' }));
  }
  if (config.discordBot.allowedGuildIds.length && !config.discordBot.allowedGuildIds.includes(interaction.guildId)) {
    return interaction.reply(privatePayload({ content: 'Este servidor não está autorizado.' }));
  }
  if (config.discordBot.allowedChannelIds.length && !config.discordBot.allowedChannelIds.includes(interaction.channelId)) {
    return interaction.reply(privatePayload({ content: 'Este canal não está autorizado para o painel.' }));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = panelEmbed(interaction);
  const payload = { embeds: [embed], components: panelRows(), allowedMentions: { parse: [] } };
  const recent = await interaction.channel.messages.fetch({ limit: 50 }).catch(() => null);
  const existing = recent?.find((message) => (
    message.author.id === interaction.client.user.id
    && message.components?.some((row) => row.components?.some((component) => component.customId === 'nexus_license_view'))
  ));
  const panel = existing ? await existing.edit(payload) : await interaction.channel.send(payload);
  await saveExistingSupportConfig(interaction.guildId, { panelChannelId: interaction.channelId });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: existing ? 'discord_bot.panel_updated' : 'discord_bot.panel_published',
    targetType: 'discord_message',
    targetId: panel.id,
    metadata: { guildId: interaction.guildId, channelId: interaction.channelId }
  });
  return interaction.editReply(`Painel Nexus ${existing ? 'atualizado' : 'publicado'} em ${interaction.channel}.`);
}

async function routeComponent(interaction) {
  await ensureConfiguredPanelChannel(interaction);
  enforceCooldown(interaction);
  const id = interaction.customId;
  if (id === 'nexus_license_view') return showLicense(interaction);
  if (id === 'nexus_key_redeem') return interaction.showModal(redeemModal());
  if (id === 'nexus_loader_copy') return showLoader(interaction);
  if (id === 'nexus_hwid_reset') return showResetConfirmation(interaction);
  if (id === 'nexus_hwid_reset_confirm') return confirmReset(interaction);
  if (id === 'nexus_hwid_reset_cancel') {
    return replyPrivate(interaction, { content: 'Reset de HWID cancelado.', embeds: [], components: [] });
  }
  if (id === 'nexus_history_view') return showHistory(interaction);
  if (id === 'nexus_support') return showExistingSupport(interaction);
  if (id === 'nexus_panel_refresh') return refreshPanel(interaction);
}

export function licenseCommandDefinitions() {
  return [
    {
      name: 'nexus',
      description: 'Painel oficial de licenças Nexus',
      dmPermission: false,
      options: [{ type: 1, name: 'painel', description: 'Publicar ou atualizar o painel Nexus' }]
    },
    { name: 'licenca', description: 'Consultar sua licença Nexus', dmPermission: false },
    {
      name: 'resgatar',
      description: 'Resgatar uma key Nexus',
      dmPermission: false,
      options: [{
        type: 3,
        name: 'key',
        description: 'Sua key Nexus',
        required: true,
        min_length: 12,
        max_length: 160
      }]
    },
    { name: 'loader', description: 'Consultar o loader oficial Nexus', dmPermission: false },
    {
      name: 'hwid',
      description: 'Gerenciar seu HWID',
      dmPermission: false,
      options: [{ type: 1, name: 'resetar', description: 'Resetar seu HWID respeitando o limite' }]
    },
    { name: 'historico', description: 'Consultar seu histórico de licença', dmPermission: false }
  ];
}

export function isLicenseInteraction(interaction) {
  if (interaction.isChatInputCommand?.()) return COMMAND_NAMES.has(interaction.commandName);
  if (interaction.isButton?.() || interaction.isModalSubmit?.()) {
    return clean(interaction.customId).startsWith(COMPONENT_PREFIX);
  }
  return false;
}

export async function handleLicenseInteraction(_entry, interaction) {
  if (!isLicenseInteraction(interaction)) return;
  if (interaction.isModalSubmit?.() && interaction.customId === 'nexus_key_redeem_submit') {
    enforceCooldown(interaction);
    return redeemKey(interaction, interaction.fields.getTextInputValue('nexus_key_value'));
  }
  if (interaction.isButton?.()) return routeComponent(interaction);
  enforceCooldown(interaction);
  if (interaction.commandName === 'nexus') return publishPanel(interaction);
  if (interaction.commandName === 'licenca') return showLicense(interaction);
  if (interaction.commandName === 'resgatar') return redeemKey(interaction, interaction.options.getString('key', true));
  if (interaction.commandName === 'loader') return showLoader(interaction);
  if (interaction.commandName === 'hwid') return showResetConfirmation(interaction);
  if (interaction.commandName === 'historico') return showHistory(interaction);
}

export const licenseCommandNames = COMMAND_NAMES;
