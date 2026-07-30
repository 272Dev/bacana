import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { logAudit } from './audit.js';
import { createLivePixPayment, createLivePixQrCode } from './livePix.js';
import {
  attachLivePixDiscordMessage,
  claimLivePixPaymentFulfillment,
  completeLivePixPaymentFulfillment,
  createLivePixPaymentIntent,
  failLivePixPaymentFulfillment,
  getLivePixPaymentIntent,
  markLivePixPaymentNotified,
  syncLivePixPaymentIntent
} from './livePixPayments.js';
import {
  getGeneratorAccess,
  getGeneratorDeliveryForBuyer,
  getGeneratorHistory,
  getGeneratorProfile,
  generateGeneratorKeys,
  generateGeneratorPaymentKey,
  listGeneratorPlans,
  recordGeneratorUse,
  redeemGeneratorKey
} from './generatorCommerce.js';
import {
  activateLicensePlanPayment,
  findLicensePlan,
  listLicensePlans
} from './licensing.js';
import {
  completeRobloxSalesDelivery,
  getRobloxGeneratorSettings,
  releaseRobloxSalesDelivery,
  reserveRandomRobloxSalesAccount
} from './robloxGenerator.js';

const GENERATOR_COMMAND_NAMES = new Set(['nexus', 'conta', 'pix']);
const GENERATOR_PREFIX = 'nexus:';
const requestsInFlight = new Set();
const pixRequestsInFlight = new Set();
const BRAND_COLOR = 0x0A0A0A;
const DEFAULT_FOOTER = 'Nexus • Gerador premium';
const PURCHASE_TICKET_TTL_MS = 20 * 60 * 1000;
const SUPPORT_TYPES = {
  generation: 'Problema na geração',
  purchase: 'Compra',
  plan: 'Plano',
  payment: 'Pagamento',
  other: 'Outro'
};

function cleanText(value) {
  return String(value || '').trim();
}

function safeText(value, max = 1000) {
  return cleanText(value).replace(/`/g, 'ˋ').slice(0, max);
}

function formatDate(value, fallback = 'Não disponível') {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return fallback;
  return `<t:${Math.floor(timestamp / 1000)}:f>`;
}

function formatRelative(value, fallback = 'Não disponível') {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return fallback;
  return `<t:${Math.floor(timestamp / 1000)}:R>`;
}

function formatPrice(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Math.max(0, Number(cents || 0)) / 100);
}

function formatDuration(days) {
  if (days == null) return 'Vitalício';
  if (Number(days) === 1) return '24 horas';
  return `${Number(days)} dias`;
}

function planLimit(plan) {
  return Number(plan?.generationLimit || 0) === 0 ? 'Ilimitadas' : String(plan.generationLimit);
}

function normalizedPlanLookup(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function findGeneratorPlan(value, { activeOnly = true } = {}) {
  const requested = normalizedPlanLookup(value);
  const plans = await listGeneratorPlans({ activeOnly });
  return plans.find((plan) => (
    normalizedPlanLookup(plan.id) === requested
    || normalizedPlanLookup(plan.name) === requested
  )) || null;
}

function bannerUrl() {
  try {
    const url = new URL('/nexus-discord-banner.png', config.apiPublicUrl);
    return /^https?:$/i.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function getGuildConfig(guildId) {
  if (!guildId) return null;
  const row = await db.prepare('SELECT * FROM generator_guild_configs WHERE guild_id = ?').get(guildId);
  if (!row) return null;
  let logs = {};
  try {
    logs = JSON.parse(row.logs_json || '{}') || {};
  } catch {
    logs = {};
  }
  return {
    guildId: row.guild_id,
    panelChannelId: row.panel_channel_id,
    supportCategoryId: row.support_category_id,
    logs,
    vipRoleId: row.vip_role_id,
    bannerUrl: row.banner_url,
    footerText: row.footer_text || DEFAULT_FOOTER
  };
}

async function saveGuildConfig(guildId, input = {}) {
  const current = await getGuildConfig(guildId);
  const timestamp = nowIso();
  const next = {
    panelChannelId: input.panelChannelId ?? current?.panelChannelId ?? null,
    supportCategoryId: input.supportCategoryId ?? current?.supportCategoryId ?? null,
    logs: input.logs ?? current?.logs ?? {},
    vipRoleId: input.vipRoleId ?? current?.vipRoleId ?? null,
    bannerUrl: input.bannerUrl ?? current?.bannerUrl ?? null,
    footerText: input.footerText ?? current?.footerText ?? DEFAULT_FOOTER
  };
  await db.prepare(`
    INSERT INTO generator_guild_configs (
      guild_id, panel_channel_id, support_category_id, logs_json,
      vip_role_id, banner_url, footer_text, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (guild_id) DO UPDATE SET
      panel_channel_id = excluded.panel_channel_id,
      support_category_id = excluded.support_category_id,
      logs_json = excluded.logs_json,
      vip_role_id = excluded.vip_role_id,
      banner_url = excluded.banner_url,
      footer_text = excluded.footer_text,
      updated_at = excluded.updated_at
  `).run(
    guildId,
    next.panelChannelId,
    next.supportCategoryId,
    JSON.stringify(next.logs),
    next.vipRoleId,
    next.bannerUrl,
    next.footerText,
    timestamp,
    timestamp
  );
  return getGuildConfig(guildId);
}

export async function getExistingSupportConfig(guildId) {
  return getGuildConfig(guildId);
}

export async function saveExistingSupportConfig(guildId, input = {}) {
  return saveGuildConfig(guildId, input);
}

async function brandEmbed(interaction, { title, description = '', fields = [], image = true, thumbnail = true } = {}) {
  const guildConfig = await getGuildConfig(interaction.guildId);
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(title || 'Nexus')
    .setDescription(description || ' ')
    .setFooter({ text: guildConfig?.footerText || DEFAULT_FOOTER })
    .setTimestamp();
  if (fields.length) embed.addFields(fields);
  const avatar = interaction.client?.user?.displayAvatarURL?.({ size: 256 });
  if (thumbnail && avatar) embed.setThumbnail(avatar);
  const imageUrl = guildConfig?.bannerUrl || bannerUrl();
  if (image && imageUrl) embed.setImage(imageUrl);
  return embed;
}

function navigationRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nexus:generate').setLabel('Gerar conta').setEmoji('🎲').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nexus:plans').setLabel('Planos').setEmoji('📦').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:vip').setLabel('VIP').setEmoji('⭐').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:profile').setLabel('Meu perfil').setEmoji('👤').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:history').setLabel('Histórico').setEmoji('📜').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nexus:key').setLabel('Resgatar key').setEmoji('🔑').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:support').setLabel('Suporte').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:how').setLabel('Como funciona').setEmoji('📖').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:settings').setLabel('Configurações').setEmoji('⚙️').setStyle(ButtonStyle.Secondary)
    )
  ];
}

function backRow(extra = []) {
  return new ActionRowBuilder().addComponents(
    ...extra,
    new ButtonBuilder().setCustomId('nexus:home').setLabel('Voltar').setEmoji('↩️').setStyle(ButtonStyle.Secondary)
  );
}

function privateReplyOptions(interaction, payload) {
  if (!interaction.guildId) return payload;
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function show(interaction, payload) {
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.()) {
    const sourceIsPrivate = interaction.message?.flags?.has?.(MessageFlags.Ephemeral) === true;
    if (!interaction.replied && !interaction.deferred && sourceIsPrivate) return interaction.update(payload);
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply(privateReplyOptions(interaction, payload));
    }
  }
  if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
  return interaction.reply(privateReplyOptions(interaction, payload));
}

async function showHome(interaction) {
  const embed = await brandEmbed(interaction, {
    title: 'Nexus • Gerador de contas',
    description: [
      '**Sua central de geração, planos e suporte.**',
      'Use os botões abaixo para navegar. Dados de contas são enviados apenas no seu privado.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n')
  });
  return show(interaction, { embeds: [embed], components: navigationRows(), allowedMentions: { parse: [] } });
}

function accessStatus(profile) {
  if (profile.source === 'permission') return 'Equipe autorizada';
  if (profile.subscription?.status === 'active') return 'Plano ativo';
  if (profile.source === 'plan_limit') return 'Limite atingido';
  return 'Sem plano ativo';
}

function cooldownRemaining(profile, fallbackCooldown = 0) {
  const cooldown = profile.policy?.cooldownSeconds ?? fallbackCooldown;
  const last = Date.parse(profile.lastGenerationAt || '');
  if (!Number.isFinite(last) || cooldown <= 0) return 0;
  return Math.max(0, Math.ceil(((last + cooldown * 1000) - Date.now()) / 1000));
}

async function showGenerate(interaction) {
  const [profile, settings] = await Promise.all([
    getGeneratorProfile(interaction.user.id),
    getRobloxGeneratorSettings()
  ]);
  const subscription = profile.subscription;
  const remaining = subscription?.generationsRemaining == null
    ? (profile.source === 'permission' ? 'Conforme regra administrativa' : 'Ilimitadas')
    : String(subscription.generationsRemaining);
  const cooldown = cooldownRemaining(profile, profile.source === 'permission' ? settings.cooldownSeconds : 0);
  const canGenerate = profile.allowed && cooldown === 0 && settings.generatorEnabled;
  const reason = !settings.generatorEnabled
    ? 'Gerador pausado'
    : !profile.allowed
      ? 'Plano necessário ou limite atingido'
      : cooldown > 0
        ? `Cooldown: ${cooldown}s`
        : 'Pronto para gerar';
  const embed = await brandEmbed(interaction, {
    title: 'Confirmar geração',
    description: [
      'Confira seu acesso antes de confirmar.',
      '',
      `**Status:** ${reason}`,
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n'),
    fields: [
      { name: 'Plano', value: subscription?.plan?.name || (profile.source === 'permission' ? 'Acesso da equipe' : 'Nenhum'), inline: true },
      { name: 'Gerações restantes', value: remaining, inline: true },
      { name: 'Validade', value: subscription?.expiresAt ? formatRelative(subscription.expiresAt) : subscription ? 'Vitalício' : '—', inline: true },
      { name: 'Cooldown', value: cooldown > 0 ? `${cooldown}s restantes` : 'Liberado', inline: true },
      { name: 'Total gerado', value: String(profile.totalGenerated), inline: true },
      { name: 'Entrega', value: 'Mensagem privada', inline: true }
    ]
  });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('nexus:generate:confirm')
      .setLabel('Gerar agora')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!canGenerate),
    new ButtonBuilder().setCustomId('nexus:generate').setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('nexus:home').setLabel('Cancelar').setEmoji('✖️').setStyle(ButtonStyle.Secondary)
  );
  return show(interaction, { embeds: [embed], components: [row] });
}

async function logGeneratorEvent(interaction, type, embed) {
  const guildConfig = await getGuildConfig(interaction.guildId);
  const channelId = guildConfig?.logs?.[type];
  if (!channelId) return;
  const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null);
  if (channel?.isTextBased?.()) await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
}

async function createPixCharge(interaction) {
  if (pixRequestsInFlight.has(interaction.user.id)) {
    return interaction.reply({
      content: 'Sua cobranca anterior ainda esta sendo criada.',
      flags: MessageFlags.Ephemeral
    });
  }

  const value = interaction.options.getNumber('valor', true);
  const buyer = interaction.user;
  const amountCents = Math.round(value * 100);
  pixRequestsInFlight.add(interaction.user.id);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const matchingPlans = (await listGeneratorPlans({ activeOnly: true }))
      .filter((candidate) => candidate.priceCents > 0 && candidate.priceCents === amountCents);
    const plan = matchingPlans.length === 1 ? matchingPlans[0] : null;

    const payment = await createLivePixPayment(amountCents);
    await createLivePixPaymentIntent({
      reference: payment.reference,
      checkoutUrl: payment.checkoutUrl,
      amountCents: payment.amountCents,
      currency: payment.currency,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      createdByDiscordId: interaction.user.id,
      buyerDiscordId: buyer.id,
      productType: plan ? 'generator_plan' : 'manual',
      productId: plan?.id || null,
      metadata: {
        source: 'discord_slash_command',
        command: 'pix',
        ...(plan ? {
          planName: plan.name,
          planPriceCents: plan.priceCents
        } : {})
      }
    });
    const qrCode = await createLivePixQrCode(payment.checkoutUrl);
    const qrCodeName = 'nexus-pix-qr.png';
    const paymentEmbed = await brandEmbed(interaction, {
      title: 'Pagamento Pix',
      description: [
        '**Cobranca gerada com seguranca pela LivePix.**',
        'Escaneie com a camera do celular para abrir o checkout e pagar.',
        'Se preferir, use o botao para abrir o checkout no aparelho.',
        'O status sera atualizado automaticamente apos a confirmacao.',
        '',
        '━━━━━━━━━━━━━━━━━━━━'
      ].join('\n'),
      fields: [
        { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
        ...(plan ? [{ name: 'Plano', value: safeText(plan.name, 80), inline: true }] : []),
        { name: 'Comprador', value: `<@${buyer.id}>`, inline: true },
        { name: 'Status', value: 'Aguardando pagamento', inline: true },
        { name: 'Referencia', value: `\`${safeText(payment.reference, 100)}\``, inline: false }
      ],
      image: false
    });
    paymentEmbed.setImage(`attachment://${qrCodeName}`);
    const paymentRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Pagar com Pix')
        .setEmoji('💠')
        .setStyle(ButtonStyle.Link)
        .setURL(payment.checkoutUrl),
      new ButtonBuilder()
        .setCustomId(`nexus:pix:status:${payment.reference}`)
        .setLabel('Verificar pagamento')
        .setStyle(ButtonStyle.Secondary)
    );
    const payload = {
      embeds: [paymentEmbed],
      components: [paymentRow],
      files: [{ attachment: qrCode, name: qrCodeName }],
      allowedMentions: { parse: [] }
    };

    const posted = interaction.channel?.isTextBased?.()
      ? await interaction.channel.send(payload).catch(() => null)
      : null;
    if (posted) {
      await attachLivePixDiscordMessage(payment.reference, {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: posted.id
      });
    }

    await logAudit({
      actorDiscordId: interaction.user.id,
      action: 'generator_bot.pix_created',
      targetType: 'livepix_payment',
      targetId: payment.reference,
      metadata: {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: posted?.id || null,
        amountCents: payment.amountCents,
        currency: payment.currency,
        buyerDiscordId: buyer.id,
        planId: plan?.id || null
      }
    }).catch(() => {});

    const logEmbed = await brandEmbed(interaction, {
      title: 'Nova cobranca Pix',
      description: `Cobranca criada por <@${interaction.user.id}>.`,
      fields: [
        { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
        ...(plan ? [{ name: 'Plano', value: safeText(plan.name, 80), inline: true }] : []),
        { name: 'Comprador', value: `<@${buyer.id}>`, inline: true },
        { name: 'Referencia', value: safeText(payment.reference, 100), inline: true },
        { name: 'Canal', value: `<#${interaction.channelId}>`, inline: true }
      ],
      image: false
    });
    await logGeneratorEvent(interaction, 'purchases', logEmbed).catch(() => {});

    if (!posted) {
      return interaction.editReply({
        content: 'A cobranca foi criada, mas o bot nao conseguiu publica-la neste canal. Use o checkout abaixo.',
        ...payload
      });
    }
    return interaction.editReply({
      content: `Cobranca de **${formatPrice(payment.amountCents)}** publicada: ${posted.url}`,
      allowedMentions: { parse: [] }
    });
  } catch (error) {
    await logAudit({
      actorDiscordId: interaction.user.id,
      action: 'generator_bot.pix_failed',
      targetType: 'livepix_payment',
      metadata: {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        amountCents,
        errorCode: cleanText(error?.code || 'LIVEPIX_UNKNOWN_ERROR')
      }
    }).catch(() => {});
    return interaction.editReply({
      content: `Nao foi possivel gerar o Pix: ${safeText(error?.message || 'erro inesperado', 500)}`,
      embeds: [],
      components: []
    });
  } finally {
    pixRequestsInFlight.delete(interaction.user.id);
  }
}

export async function fulfillLivePixPaymentIntent(client, intent) {
  if (!intent?.reference || intent.status !== 'paid') return intent;
  if (intent.productType === 'manual' || intent.fulfillmentStatus === 'not_required') return intent;
  if (intent.fulfillmentStatus === 'completed') return intent;

  const claimed = await claimLivePixPaymentFulfillment(intent.reference);
  if (!claimed) return getLivePixPaymentIntent(intent.reference);

  try {
    if (!['generator_plan', 'license_plan'].includes(claimed.productType)) {
      throw new Error(`Produto automatico nao suportado: ${claimed.productType}`);
    }
    if (!claimed.buyerDiscordId || !claimed.productId) {
      throw new Error('Pagamento sem comprador ou plano vinculado.');
    }

    const isLicensePlan = claimed.productType === 'license_plan';
    const plan = isLicensePlan
      ? await findLicensePlan(claimed.productId, { activeOnly: false })
      : await findGeneratorPlan(claimed.productId, { activeOnly: false });
    if (!plan) throw new Error('O plano vinculado ao pagamento nao foi encontrado.');
    const agreedPrice = Number(claimed.metadata?.planPriceCents);
    if (
      claimed.currency !== 'BRL'
      || !Number.isSafeInteger(agreedPrice)
      || claimed.amountCents !== agreedPrice
    ) {
      throw new Error('O valor confirmado nao corresponde ao preco contratado.');
    }

    const generated = isLicensePlan
      ? await activateLicensePlanPayment({
          planId: plan.id,
          discordId: claimed.buyerDiscordId,
          actorDiscordId: claimed.createdByDiscordId,
          paymentReference: claimed.reference
        })
      : await generateGeneratorPaymentKey({
          planId: plan.id,
          paymentReference: claimed.reference,
          createdByDiscordId: claimed.createdByDiscordId
        });
    const buyer = await client.users.fetch(claimed.buyerDiscordId);
    const deliveryEmbed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(isLicensePlan ? 'Pagamento confirmado • Licença Nexus' : 'Pagamento confirmado • Sua key Nexus')
      .setDescription([
        'Seu pagamento foi confirmado automaticamente pela LivePix.',
        isLicensePlan
          ? 'A licença do script já foi ativada no seu Discord.'
          : 'Use o botão abaixo para ativar seu plano do gerador.',
        '',
        '━━━━━━━━━━━━━━━━━━━━'
      ].join('\n'))
      .addFields(
        { name: 'Key', value: `\`${generated.key}\`` },
        { name: 'Plano', value: safeText(plan.name, 80), inline: true },
        { name: 'Valor pago', value: formatPrice(claimed.amountCents), inline: true },
        { name: 'Validade', value: formatDuration(plan.durationDays), inline: true },
        { name: 'Referencia', value: `\`${safeText(claimed.reference, 100)}\`` }
      )
      .setFooter({ text: DEFAULT_FOOTER })
      .setTimestamp();
    const avatar = client.user?.displayAvatarURL?.({ size: 256 });
    if (avatar) deliveryEmbed.setThumbnail(avatar);
    const deliveryRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(isLicensePlan ? 'nexus_loader_copy' : 'nexus:key')
        .setLabel(isLicensePlan ? 'Copiar loader' : 'Ativar key')
        .setStyle(ButtonStyle.Primary)
    );
    const delivery = await buyer.send({
      embeds: [deliveryEmbed],
      components: [deliveryRow],
      allowedMentions: { parse: [] }
    });
    const completed = await completeLivePixPaymentFulfillment(claimed.reference, {
      resourceId: generated.id,
      deliveryMessageId: delivery.id
    });
    await logAudit({
      actorDiscordId: claimed.createdByDiscordId,
      action: isLicensePlan ? 'license_bot.pix_license_delivered' : 'generator_bot.pix_key_delivered',
      targetType: 'livepix_payment',
      targetId: claimed.reference,
      metadata: {
        buyerDiscordId: claimed.buyerDiscordId,
        planId: plan.id,
        resourceId: generated.id,
        productType: claimed.productType,
        amountCents: claimed.amountCents,
        deliveryMessageId: delivery.id
      }
    }).catch(() => {});
    return completed;
  } catch (error) {
    await failLivePixPaymentFulfillment(claimed.reference, error);
    console.warn(`[nexus] Falha ao entregar compra Pix ${claimed.reference}: ${error.message}`);
    return getLivePixPaymentIntent(claimed.reference);
  }
}

export async function updateLivePixPaymentMessage(client, intent) {
  if (!client?.isReady?.() || !intent?.guildId || !intent?.channelId || !intent?.messageId) return false;
  const guild = client.guilds.cache.get(intent.guildId)
    || await client.guilds.fetch(intent.guildId).catch(() => null);
  if (!guild) return false;
  const channel = await guild.channels.fetch(intent.channelId).catch(() => null);
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return false;
  const message = await channel.messages.fetch(intent.messageId).catch(() => null);
  if (!message) return false;

  const current = message.embeds?.[0];
  const embed = current
    ? EmbedBuilder.from(current)
    : new EmbedBuilder().setTitle('Pagamento Pix').setColor(BRAND_COLOR);
  const automaticDelivery = ['generator_plan', 'license_plan'].includes(intent.productType);
  const delivered = intent.fulfillmentStatus === 'completed';
  const deliveryFailed = intent.fulfillmentStatus === 'failed';
  const statusText = automaticDelivery
    ? delivered
      ? 'Confirmado • key enviada no privado'
      : deliveryFailed
        ? 'Confirmado • abra seu privado para receber'
        : 'Confirmado • preparando sua key'
    : 'Pagamento confirmado';
  embed
    .setDescription([
      '**Pagamento confirmado pela LivePix.**',
      automaticDelivery
        ? delivered
          ? 'A key foi gerada e entregue automaticamente no privado do comprador.'
          : 'A key esta segura. O bot tentara entrega-la novamente assim que o privado estiver aberto.'
        : 'A referencia, o valor e o comprovante foram validados diretamente na API.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n'))
    .setFields(
      { name: 'Valor', value: formatPrice(intent.amountCents), inline: true },
      { name: 'Status', value: statusText, inline: true },
      ...(automaticDelivery
        ? [
            { name: 'Plano', value: safeText(intent.metadata?.planName || intent.productId, 80), inline: true },
            { name: 'Comprador', value: `<@${intent.buyerDiscordId}>`, inline: true }
          ]
        : []),
      { name: 'Referencia', value: `\`${safeText(intent.reference, 100)}\``, inline: false }
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nexus:pix:paid:${intent.reference}`)
      .setLabel(delivered ? 'Key entregue' : 'Pagamento confirmado')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
  await message.edit({
    embeds: [embed],
    components: [row],
    allowedMentions: { parse: [] }
  });
  return true;
}

async function checkPixPayment(interaction, reference) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const result = await syncLivePixPaymentIntent(reference);
    if (!result.found) {
      return interaction.editReply('Esta cobranca nao foi encontrada no Nexus.');
    }
    if (!result.paid) {
      return interaction.editReply(
        result.reason === 'not_received'
          ? 'Pagamento ainda nao confirmado pela LivePix. Aguarde alguns segundos apos pagar e tente novamente.'
          : `Pagamento ainda pendente (${safeText(result.reason, 80)}).`
      );
    }

    const fulfilledIntent = await fulfillLivePixPaymentIntent(interaction.client, result.intent);
    const updated = await updateLivePixPaymentMessage(interaction.client, fulfilledIntent).catch(() => false);
    if (updated) await markLivePixPaymentNotified(result.intent.reference);
    return interaction.editReply(
      fulfilledIntent.fulfillmentStatus === 'completed'
        ? 'Pagamento confirmado. A key foi enviada automaticamente no privado do comprador.'
        : 'Pagamento confirmado. A key esta guardada e o bot tentara envia-la no privado automaticamente.'
    );
  } catch (error) {
    return interaction.editReply(
      `Nao foi possivel verificar agora: ${safeText(error?.message || 'erro inesperado', 400)}`
    );
  }
}

async function confirmGeneration(interaction) {
  if (requestsInFlight.has(interaction.user.id)) {
    return show(interaction, { content: 'Sua geração anterior ainda está sendo processada.', embeds: [], components: [backRow()] });
  }
  requestsInFlight.add(interaction.user.id);
  await interaction.deferUpdate();
  await interaction.editReply({ content: '◌ Validando plano e separando uma conta...', embeds: [], components: [] });

  let reservation = null;
  let delivered = false;
  try {
    const access = await getGeneratorAccess(interaction.user.id);
    if (!access.allowed) throw new Error('Você não possui um plano ativo ou atingiu o limite de gerações.');
    reservation = await reserveRandomRobloxSalesAccount({
      buyerDiscordId: interaction.user.id,
      channel: 'discord-panel',
      policy: access.policy
    });
    const { account, deliveryId } = reservation;
    const planName = access.subscription?.plan?.name || (access.source === 'permission' ? 'Acesso da equipe' : 'Nexus');
    const deliveryEmbed = await brandEmbed(interaction, {
      title: 'Conta gerada com sucesso',
      description: [
        'Seus dados foram entregues com segurança.',
        '',
        '━━━━━━━━━━━━━━━━━━━━'
      ].join('\n'),
      fields: [
        { name: 'Usuário', value: `\`${safeText(account.username)}\`` },
        { name: 'Senha', value: `\`${safeText(account.password)}\`` },
        { name: 'Data', value: formatDate(new Date().toISOString()), inline: true },
        { name: 'ID da geração', value: `\`${deliveryId.slice(0, 12).toUpperCase()}\``, inline: true },
        { name: 'Plano utilizado', value: planName, inline: true }
      ]
    });
    const actions = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`nexus:copy:${deliveryId}`).setLabel('Copiar dados').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:generate').setLabel('Gerar novamente').setEmoji('🔄').setStyle(ButtonStyle.Primary)
    );
    await interaction.user.send({ embeds: [deliveryEmbed], components: [actions], allowedMentions: { parse: [] } });
    await completeRobloxSalesDelivery({ deliveryId, buyerDiscordId: interaction.user.id });
    delivered = true;
    if (access.source === 'plan') await recordGeneratorUse(interaction.user.id);
    await logAudit({
      actorDiscordId: interaction.user.id,
      action: 'generator_bot.account_delivered',
      targetType: 'roblox_generator_account',
      targetId: account.id,
      metadata: { deliveryId, plan: planName, channel: 'discord-dm' }
    });
    const logEmbed = await brandEmbed(interaction, {
      title: 'Nova geração',
      image: false,
      fields: [
        { name: 'Usuário Discord', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)` },
        { name: 'Conta', value: `\`${safeText(account.username)}\``, inline: true },
        { name: 'Plano', value: planName, inline: true },
        { name: 'ID', value: `\`${deliveryId}\`` }
      ]
    });
    await logGeneratorEvent(interaction, 'generations', logEmbed);
    const successEmbed = await brandEmbed(interaction, {
      title: 'Geração concluída',
      description: 'A conta foi enviada no seu privado. Confira suas mensagens diretas.',
      fields: [{ name: 'ID da geração', value: `\`${deliveryId.slice(0, 12).toUpperCase()}\`` }]
    });
    await interaction.editReply({ content: '', embeds: [successEmbed], components: [backRow([
      new ButtonBuilder().setCustomId('nexus:generate').setLabel('Gerar novamente').setEmoji('🔄').setStyle(ButtonStyle.Primary)
    ])] });
  } catch (error) {
    if (reservation?.deliveryId && !delivered) {
      await releaseRobloxSalesDelivery({
        deliveryId: reservation.deliveryId,
        buyerDiscordId: interaction.user.id
      }).catch(() => {});
    }
    const message = error?.code === 50007
      ? 'Não consegui enviar a DM. Ative mensagens privadas deste servidor e tente novamente.'
      : error?.message || 'Não foi possível gerar uma conta agora.';
    const embed = await brandEmbed(interaction, {
      title: 'Geração não concluída',
      description: `**Motivo:** ${safeText(message, 1700)}`
    });
    await interaction.editReply({ content: '', embeds: [embed], components: [backRow([
      new ButtonBuilder().setCustomId('nexus:generate').setLabel('Tentar novamente').setEmoji('🔄').setStyle(ButtonStyle.Primary)
    ])] }).catch(() => {});
    await logGeneratorEvent(interaction, 'errors', embed);
  } finally {
    requestsInFlight.delete(interaction.user.id);
  }
}

async function showPlans(interaction) {
  const plans = await listGeneratorPlans({ activeOnly: true });
  const purchasablePlans = plans.filter((plan) => plan.priceCents > 0);
  const embed = await brandEmbed(interaction, {
    title: 'Planos Nexus',
    description: [
      'Escolha o plano ideal. Os valores e limites podem ser atualizados no painel administrativo.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n'),
    fields: plans.slice(0, 10).map((plan) => ({
      name: `${plan.featured ? '◆ MAIS VENDIDO • ' : ''}${plan.vip ? '★ ' : ''}${plan.name}`,
      value: [
        `**${formatPrice(plan.priceCents)}** • ${formatDuration(plan.durationDays)}`,
        `${planLimit(plan)} gerações • cooldown ${plan.cooldownSeconds}s`,
        plan.benefits.slice(0, 4).map((benefit) => `• ${benefit}`).join('\n') || '• Acesso ao gerador'
      ].join('\n'),
      inline: false
    }))
  });
  const components = [];
  if (purchasablePlans.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('nexus:buy')
        .setPlaceholder('Selecionar plano para comprar')
        .addOptions(purchasablePlans.slice(0, 25).map((plan) => ({
          label: plan.name.slice(0, 100),
          description: `${formatPrice(plan.priceCents)} • ${formatDuration(plan.durationDays)}`.slice(0, 100),
          value: plan.id,
          emoji: plan.vip ? '⭐' : '📦'
        })))
    ));
  }
  components.push(backRow());
  return show(interaction, { embeds: [embed], components });
}

async function showVip(interaction) {
  const plans = await listGeneratorPlans({ activeOnly: true });
  const vipPlans = plans.filter((plan) => plan.vip);
  const embed = await brandEmbed(interaction, {
    title: 'Nexus VIP',
    description: [
      '**Mais velocidade, volume e prioridade.**',
      '',
      '• Menor cooldown',
      '• Mais gerações',
      '• Prioridade nas filas',
      '• Suporte prioritário',
      '• Cargo exclusivo quando configurado',
      '• Promoções exclusivas',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n'),
    fields: vipPlans.map((plan) => ({
      name: `★ ${plan.name}`,
      value: `${formatPrice(plan.priceCents)} • ${planLimit(plan)} gerações • ${formatDuration(plan.durationDays)}`
    }))
  });
  const extras = [];
  if (vipPlans[0]) {
    extras.push(new ButtonBuilder().setCustomId(`nexus:purchase:${vipPlans[0].id}`).setLabel('Comprar VIP').setEmoji('🛒').setStyle(ButtonStyle.Primary));
  }
  return show(interaction, { embeds: [embed], components: [backRow(extras)] });
}

async function showProfile(interaction) {
  const profile = await getGeneratorProfile(interaction.user.id);
  const subscription = profile.subscription;
  const embed = await brandEmbed(interaction, {
    title: `Perfil de ${interaction.user.globalName || interaction.user.username}`,
    description: `**${accessStatus(profile)}**\n\n━━━━━━━━━━━━━━━━━━━━`,
    image: false,
    fields: [
      { name: 'ID Discord', value: `\`${interaction.user.id}\``, inline: true },
      { name: 'Plano atual', value: subscription?.plan?.name || (profile.source === 'permission' ? 'Equipe autorizada' : 'Nenhum'), inline: true },
      { name: 'Status', value: subscription?.status || (profile.allowed ? 'ativo' : 'inativo'), inline: true },
      { name: 'Gerações utilizadas', value: String(subscription?.generationsUsed ?? profile.totalGenerated), inline: true },
      { name: 'Gerações restantes', value: subscription?.generationsRemaining == null ? (profile.allowed ? 'Ilimitadas/regra admin' : '0') : String(subscription.generationsRemaining), inline: true },
      { name: 'Total de contas', value: String(profile.totalGenerated), inline: true },
      { name: 'Última geração', value: formatRelative(profile.lastGenerationAt, 'Nunca'), inline: true },
      { name: 'Cliente desde', value: formatDate(subscription?.customerSince, 'Ainda não ativado'), inline: true },
      { name: 'Validade', value: subscription?.expiresAt ? formatRelative(subscription.expiresAt) : subscription ? 'Vitalício' : '—', inline: true }
    ]
  });
  embed.setThumbnail(interaction.user.displayAvatarURL({ size: 256 }));
  return show(interaction, {
    embeds: [embed],
    components: [backRow([
      new ButtonBuilder().setCustomId('nexus:history').setLabel('Histórico').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('nexus:plans').setLabel('Renovar plano').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nexus:vip').setLabel('Comprar upgrade').setStyle(ButtonStyle.Secondary)
    ])]
  });
}

async function showHistory(interaction) {
  const history = await getGeneratorHistory(interaction.user.id, 10);
  const embed = await brandEmbed(interaction, {
    title: 'Histórico de gerações',
    description: history.length
      ? history.map((item, index) => [
        `**${index + 1}. ${item.status === 'delivered' ? 'Entregue' : 'Processando'}**`,
        `ID: \`${item.id.slice(0, 12).toUpperCase()}\` • ${formatRelative(item.deliveredAt || item.createdAt)}`
      ].join('\n')).join('\n\n')
      : 'Você ainda não possui gerações.',
    fields: []
  });
  return show(interaction, {
    embeds: [embed],
    components: [backRow([
      new ButtonBuilder().setCustomId('nexus:history').setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    ])]
  });
}

async function showKeyModal(interaction) {
  const modal = new ModalBuilder().setCustomId('nexus:key:submit').setTitle('Resgatar key Nexus');
  const input = new TextInputBuilder()
    .setCustomId('key')
    .setLabel('Sua key')
    .setPlaceholder('NEXUS-GEN-XXXX-XXXX-XXXX-XXXX')
    .setRequired(true)
    .setMinLength(16)
    .setMaxLength(80)
    .setStyle(TextInputStyle.Short);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}

async function redeemKeyFromModal(interaction) {
  await interaction.deferReply(privateReplyOptions(interaction, {}).flags ? { flags: MessageFlags.Ephemeral } : {});
  const subscription = await redeemGeneratorKey({
    discordId: interaction.user.id,
    key: interaction.fields.getTextInputValue('key')
  });
  if (interaction.guild && subscription.plan.vip) {
    const guildConfig = await getGuildConfig(interaction.guildId);
    if (guildConfig?.vipRoleId) {
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      await member?.roles.add(guildConfig.vipRoleId, 'Plano VIP Nexus ativado').catch(() => {});
    }
  }
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.key_redeemed',
    targetType: 'generator_plan',
    targetId: subscription.plan.id,
    metadata: { plan: subscription.plan.name, expiresAt: subscription.expiresAt }
  });
  const embed = await brandEmbed(interaction, {
    title: 'Key ativada',
    description: '**Seu plano foi ativado com sucesso.**',
    fields: [
      { name: 'Plano', value: subscription.plan.name, inline: true },
      { name: 'Gerações', value: planLimit(subscription.plan), inline: true },
      { name: 'Validade', value: subscription.expiresAt ? formatDate(subscription.expiresAt) : 'Vitalício', inline: true }
    ]
  });
  await logGeneratorEvent(interaction, 'keys', embed);
  return interaction.editReply({ embeds: [embed], components: [backRow([
    new ButtonBuilder().setCustomId('nexus:generate').setLabel('Gerar conta').setStyle(ButtonStyle.Primary)
  ])] });
}

async function showSupport(interaction) {
  const embed = await brandEmbed(interaction, {
    title: 'Suporte Nexus',
    description: 'Selecione a categoria correta. Um canal privado será criado para você e a equipe.',
    fields: Object.entries(SUPPORT_TYPES).map(([id, label]) => ({
      name: label,
      value: id === 'generation' ? 'Falhas ou dúvidas na geração.' : `Atendimento sobre ${label.toLowerCase()}.`,
      inline: true
    }))
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('nexus:support:create')
    .setPlaceholder('Escolher categoria do ticket')
    .addOptions(Object.entries(SUPPORT_TYPES).map(([value, label]) => ({
      label,
      value,
      emoji: value === 'purchase' ? '🛒' : value === 'payment' ? '💳' : '🎫'
    })));
  return show(interaction, {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu), backRow()]
  });
}

export async function showExistingSupport(interaction) {
  return showSupport(interaction);
}

function ticketSlug(user) {
  const base = cleanText(user.username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'usuario';
  return `ticket-${base}-${user.id.slice(-4)}`;
}

async function publishTicketPixCheckout(interaction, channel, plan, productType = 'generator_plan') {
  if (!plan?.active || plan.priceCents <= 0) {
    throw new Error('Este plano nao esta disponivel para pagamento automatico.');
  }
  const expiresAt = new Date(Date.now() + PURCHASE_TICKET_TTL_MS);
  const payment = await createLivePixPayment(plan.priceCents);
  await createLivePixPaymentIntent({
    reference: payment.reference,
    checkoutUrl: payment.checkoutUrl,
    amountCents: payment.amountCents,
    currency: payment.currency,
    guildId: interaction.guildId,
    channelId: channel.id,
    createdByDiscordId: interaction.user.id,
    buyerDiscordId: interaction.user.id,
    productType,
    productId: plan.id,
    metadata: {
      source: productType === 'license_plan'
        ? 'discord_license_purchase_ticket'
        : 'discord_purchase_ticket',
      ticketChannelId: channel.id,
      planName: plan.name,
      planPriceCents: plan.priceCents,
      expiresAt: expiresAt.toISOString()
    }
  });

  const qrCode = await createLivePixQrCode(payment.checkoutUrl);
  const qrCodeName = 'nexus-ticket-pix.png';
  const paymentEmbed = await brandEmbed(interaction, {
    title: `Comprar ${plan.name} com Pix`,
    description: [
      '**Seu pagamento ja esta pronto.**',
      'Escaneie o QR Code ou abra o checkout pelo botao.',
      'A confirmacao e automatica. Depois do pagamento, sua key sera enviada no privado.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n'),
    fields: [
      { name: 'Plano', value: safeText(plan.name, 80), inline: true },
      { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
      { name: 'Status', value: 'Aguardando pagamento', inline: true },
      { name: 'Comprador', value: `<@${interaction.user.id}>`, inline: true },
      { name: 'Expira', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:R>`, inline: true },
      { name: 'Referencia', value: `\`${safeText(payment.reference, 100)}\``, inline: false }
    ],
    image: false
  });
  paymentEmbed.setImage(`attachment://${qrCodeName}`);
  const paymentRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Pagar com Pix')
      .setEmoji('💠')
      .setStyle(ButtonStyle.Link)
      .setURL(payment.checkoutUrl),
    new ButtonBuilder()
      .setCustomId(`nexus:pix:status:${payment.reference}`)
      .setLabel('Verificar pagamento')
      .setStyle(ButtonStyle.Secondary)
  );
  const posted = await channel.send({
    embeds: [paymentEmbed],
    components: [paymentRow],
    files: [{ attachment: qrCode, name: qrCodeName }],
    allowedMentions: { parse: [] }
  });
  await attachLivePixDiscordMessage(payment.reference, {
    guildId: interaction.guildId,
    channelId: channel.id,
    messageId: posted.id
  });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.ticket_pix_created',
    targetType: 'livepix_payment',
    targetId: payment.reference,
    metadata: {
      guildId: interaction.guildId,
      channelId: channel.id,
      messageId: posted.id,
      buyerDiscordId: interaction.user.id,
      planId: plan.id,
      amountCents: payment.amountCents,
      currency: payment.currency
    }
  }).catch(() => {});
  return { payment, message: posted };
}

async function createTicket(interaction, type, planId = null, productType = 'generator_plan') {
  if (!interaction.guild) throw new Error('Abra o ticket dentro do servidor.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let guildConfig = await getGuildConfig(interaction.guildId);
  const existing = interaction.guild.channels.cache.find((channel) => channel.topic?.includes(`nexus-user:${interaction.user.id}`));
  if (existing) return interaction.editReply(`Você já possui um ticket aberto: ${existing}`);
  let category = guildConfig?.supportCategoryId
    ? await interaction.guild.channels.fetch(guildConfig.supportCategoryId).catch(() => null)
    : null;
  if (!category) {
    category = await interaction.guild.channels.create({
      name: 'NEXUS • SUPORTE',
      type: ChannelType.GuildCategory,
      reason: 'Estrutura de suporte Nexus'
    });
    guildConfig = await saveGuildConfig(interaction.guildId, { supportCategoryId: category.id });
  }
  const me = interaction.guild.members.me;
  const isPurchaseTicket = type === 'purchase' && Boolean(planId);
  const channel = await interaction.guild.channels.create({
    name: ticketSlug(interaction.user),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `nexus-user:${interaction.user.id};type:${type};product:${productType};plan:${planId || ''}`,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: isPurchaseTicket
          ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
          : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
        ...(isPurchaseTicket ? {
          deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles]
        } : {})
      },
      ...(me ? [{
        id: me.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels]
      }] : [])
    ],
    reason: `Ticket Nexus de ${interaction.user.tag}`
  });
  const plans = planId
    ? productType === 'license_plan'
      ? await listLicensePlans({ activeOnly: true })
      : await listGeneratorPlans({ activeOnly: true })
    : [];
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const ticketEmbed = await brandEmbed(interaction, {
    title: `Ticket • ${SUPPORT_TYPES[type] || 'Suporte'}`,
    description: isPurchaseTicket
      ? [
          `${interaction.user}, este canal é exclusivo para o pagamento.`,
          selectedPlan ? `\n**Plano selecionado:** ${selectedPlan.name} • ${formatPrice(selectedPlan.priceCents)}` : '',
          '',
          'O envio de mensagens fica bloqueado. Use o QR Code abaixo.',
          '**O pagamento é verificado automaticamente.** Se não for pago em 20 minutos, o ticket será fechado.'
        ].join('\n')
      : [
          `${interaction.user}, descreva sua solicitação com todos os detalhes.`,
          selectedPlan ? `\n**Plano selecionado:** ${selectedPlan.name} • ${formatPrice(selectedPlan.priceCents)}` : '',
          '',
          'A equipe responderá por este canal. Não envie senhas ou tokens.'
        ].join('\n'),
    fields: [{ name: 'Protocolo', value: `\`${channel.id}\`` }]
  });
  await channel.send({
    content: `${interaction.user}`,
    embeds: [ticketEmbed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nexus:ticket:close').setLabel('Fechar ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
    )],
    allowedMentions: { users: [interaction.user.id] }
  });
  if (type === 'purchase' && planId) {
    try {
      await publishTicketPixCheckout(interaction, channel, selectedPlan, productType);
    } catch (error) {
      await logAudit({
        actorDiscordId: interaction.user.id,
        action: 'generator_bot.ticket_pix_failed',
        targetType: 'discord_channel',
        targetId: channel.id,
        metadata: {
          planId,
          errorCode: cleanText(error?.code || 'LIVEPIX_UNKNOWN_ERROR')
        }
      }).catch(() => {});
      await channel.delete('Ticket Nexus removido: nao foi possivel gerar o Pix.').catch(() => {});
      return interaction.editReply(
        `Nao foi possivel gerar o QR Code agora: ${safeText(error?.message || 'erro inesperado', 400)}. Tente novamente em instantes.`
      );
    }
  }
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.ticket_created',
    targetType: 'discord_channel',
    targetId: channel.id,
    metadata: { type, planId, productType }
  });
  const logEmbed = await brandEmbed(interaction, {
    title: 'Ticket aberto',
    image: false,
    fields: [
      { name: 'Usuário', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)` },
      { name: 'Categoria', value: SUPPORT_TYPES[type] || 'Suporte', inline: true },
      { name: 'Canal', value: `${channel}`, inline: true }
    ]
  });
  await logGeneratorEvent(interaction, type === 'purchase' ? 'purchases' : 'tickets', logEmbed);
  return interaction.editReply(`Ticket criado: ${channel}`);
}

export async function createLicensePurchaseTicket(interaction, planId) {
  return createTicket(interaction, 'purchase', planId, 'license_plan');
}

async function closeTicket(interaction) {
  const isRequester = interaction.channel?.topic?.includes(`nexus-user:${interaction.user.id}`);
  const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
  if (!isRequester && !isStaff) {
    return interaction.reply({ content: 'Somente o autor do ticket ou a equipe pode fechá-lo.', flags: MessageFlags.Ephemeral });
  }
  await interaction.reply({ content: 'Ticket encerrado. Este canal será removido.', flags: MessageFlags.Ephemeral });
  const channelId = interaction.channelId;
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.ticket_closed',
    targetType: 'discord_channel',
    targetId: channelId
  });
  setTimeout(() => {
    void interaction.channel?.delete(`Ticket Nexus encerrado por ${interaction.user.tag}`).catch(() => {});
  }, 1500).unref?.();
}

async function showHow(interaction) {
  const embed = await brandEmbed(interaction, {
    title: 'Como funciona',
    description: [
      '**1.** Escolha um plano e conclua a compra pelo ticket.',
      '**2.** O ticket mostra o QR Code com o valor automaticamente.',
      '**3.** Após a confirmação, sua key chega no privado para ativação.',
      '**4.** Abra **Gerar conta**, confira limite, validade e cooldown.',
      '**5.** Confirme; os dados chegam somente no seu privado.',
      '',
      'Cada key é de uso único. Não compartilhe credenciais ou dados do seu plano.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n')
  });
  return show(interaction, { embeds: [embed], components: [backRow()] });
}

function assertManageGuild(interaction) {
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw Object.assign(new Error('Somente administradores com Gerenciar Servidor podem usar esta área.'), { status: 403 });
  }
}

async function showSettings(interaction) {
  const canManage = interaction.guild
    && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!canManage) {
    const embed = await brandEmbed(interaction, {
      title: 'Configurações pessoais',
      description: [
        'As credenciais geradas são sempre enviadas por mensagem privada.',
        'Mantenha suas DMs do servidor abertas para concluir uma geração.',
        '',
        'Para alterar plano, renovar ou resolver uma entrega, abra o suporte.',
        '',
        '━━━━━━━━━━━━━━━━━━━━'
      ].join('\n')
    });
    return show(interaction, {
      embeds: [embed],
      components: [backRow([
        new ButtonBuilder().setCustomId('nexus:support').setLabel('Abrir suporte').setEmoji('🎫').setStyle(ButtonStyle.Primary)
      ])]
    });
  }
  const guildConfig = await getGuildConfig(interaction.guildId);
  const embed = await brandEmbed(interaction, {
    title: 'Configurações do gerador',
    description: 'Configure a estrutura automática ou publique o painel principal no canal atual.',
    fields: [
      { name: 'Canais de logs', value: guildConfig?.logs && Object.keys(guildConfig.logs).length ? 'Configurados' : 'Não configurados', inline: true },
      { name: 'Categoria de suporte', value: guildConfig?.supportCategoryId ? `<#${guildConfig.supportCategoryId}>` : 'Não configurada', inline: true },
      { name: 'Painel', value: guildConfig?.panelChannelId ? `<#${guildConfig.panelChannelId}>` : 'Ainda não publicado', inline: true }
    ]
  });
  return show(interaction, {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nexus:setup:channels').setLabel('Criar estrutura').setEmoji('🧰').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('nexus:setup:panel').setLabel('Publicar painel aqui').setEmoji('📌').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nexus:settings:keys').setLabel('Gerar key').setEmoji('🔑').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('nexus:home').setLabel('Voltar').setStyle(ButtonStyle.Secondary)
      )
    ]
  });
}

async function showAdminKeyPlans(interaction) {
  assertManageGuild(interaction);
  const plans = await listGeneratorPlans({ activeOnly: true });
  if (!plans.length) throw new Error('Nenhum plano ativo foi encontrado.');
  const embed = await brandEmbed(interaction, {
    title: 'Gerar key administrativa',
    description: 'Escolha o plano. Uma key única será criada e exibida somente para você.'
  });
  const menu = new StringSelectMenuBuilder()
    .setCustomId('nexus:admin:key')
    .setPlaceholder('Selecionar plano da key')
    .addOptions(plans.slice(0, 25).map((plan) => ({
      label: plan.name,
      description: `${formatPrice(plan.priceCents)} • ${formatDuration(plan.durationDays)}`.slice(0, 100),
      value: plan.id,
      emoji: plan.vip ? '⭐' : '🔑'
    })));
  return show(interaction, {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(menu), backRow()]
  });
}

async function generateAdminKey(interaction) {
  assertManageGuild(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [generated] = await generateGeneratorKeys({
    planId: interaction.values[0],
    quantity: 1
  }, interaction.user.id);
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.key_generated',
    targetType: 'generator_key',
    targetId: generated.id,
    metadata: { planId: generated.plan.id, guildId: interaction.guildId }
  });
  const embed = await brandEmbed(interaction, {
    title: 'Key gerada',
    description: [
      'Entregue esta key somente ao comprador. Ela pode ser resgatada uma única vez.',
      '',
      `\`\`\`text\n${generated.key}\n\`\`\``
    ].join('\n'),
    fields: [
      { name: 'Plano', value: generated.plan.name, inline: true },
      { name: 'Validade', value: formatDuration(generated.plan.durationDays), inline: true },
      { name: 'Gerações', value: planLimit(generated.plan), inline: true }
    ]
  });
  const logEmbed = await brandEmbed(interaction, {
    title: 'Key administrativa gerada',
    image: false,
    fields: [
      { name: 'Administrador', value: `<@${interaction.user.id}> (\`${interaction.user.id}\`)` },
      { name: 'Plano', value: generated.plan.name, inline: true },
      { name: 'Key', value: generated.keyPreview, inline: true }
    ]
  });
  await logGeneratorEvent(interaction, 'admin', logEmbed);
  return interaction.editReply({ embeds: [embed], components: [backRow()] });
}

async function setupChannels(interaction) {
  assertManageGuild(interaction);
  await interaction.deferUpdate();
  await interaction.editReply({ content: '◌ Criando estrutura profissional de suporte e logs...', embeds: [], components: [] });
  const guild = interaction.guild;
  let guildConfig = await getGuildConfig(guild.id);
  let logsCategory = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === 'NEXUS • LOGS');
  if (!logsCategory) {
    logsCategory = await guild.channels.create({ name: 'NEXUS • LOGS', type: ChannelType.GuildCategory, reason: 'Logs do gerador Nexus' });
  }
  let supportCategory = guildConfig?.supportCategoryId
    ? await guild.channels.fetch(guildConfig.supportCategoryId).catch(() => null)
    : null;
  if (!supportCategory) {
    supportCategory = await guild.channels.create({ name: 'NEXUS • SUPORTE', type: ChannelType.GuildCategory, reason: 'Tickets do gerador Nexus' });
  }
  const definitions = {
    generations: 'nexus-geracoes',
    purchases: 'nexus-compras',
    keys: 'nexus-keys',
    tickets: 'nexus-tickets',
    errors: 'nexus-erros',
    admin: 'nexus-administracao'
  };
  const logs = { ...(guildConfig?.logs || {}) };
  for (const [type, name] of Object.entries(definitions)) {
    let channel = logs[type] ? await guild.channels.fetch(logs[type]).catch(() => null) : null;
    if (!channel) {
      channel = guild.channels.cache.find((candidate) => candidate.name === name && candidate.parentId === logsCategory.id);
    }
    if (!channel) {
      channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: logsCategory.id,
        permissionOverwrites: [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
        ],
        reason: 'Logs separados do gerador Nexus'
      });
    }
    logs[type] = channel.id;
  }
  guildConfig = await saveGuildConfig(guild.id, { logs, supportCategoryId: supportCategory.id });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.channels_configured',
    targetType: 'discord_guild',
    targetId: guild.id,
    metadata: { logs, supportCategoryId: supportCategory.id }
  });
  const embed = await brandEmbed(interaction, {
    title: 'Estrutura criada',
    description: 'Canais de gerações, compras, keys, tickets, erros e administração foram separados.',
    fields: [
      { name: 'Logs', value: Object.values(guildConfig.logs).map((id) => `<#${id}>`).join('\n').slice(0, 1024) },
      { name: 'Suporte', value: `<#${guildConfig.supportCategoryId}>` }
    ]
  });
  return interaction.editReply({ content: '', embeds: [embed], components: [backRow()] });
}

async function publishPanel(interaction) {
  assertManageGuild(interaction);
  if (!interaction.channel?.isTextBased?.()) throw new Error('Escolha um canal de texto para publicar o painel.');
  const guildConfig = await getGuildConfig(interaction.guildId);
  const configuredChannel = guildConfig?.panelChannelId
    ? await interaction.guild.channels.fetch(guildConfig.panelChannelId).catch(() => null)
    : null;
  const channel = configuredChannel?.isTextBased?.() ? configuredChannel : interaction.channel;
  const embed = await brandEmbed(interaction, {
    title: 'Nexus • Gerador de contas',
    description: [
      '**Gere contas, gerencie seu plano e receba suporte em um só lugar.**',
      'Clique em uma opção abaixo para começar.',
      '',
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n')
  });
  const payload = { embeds: [embed], components: navigationRows(), allowedMentions: { parse: [] } };
  const isNexusPanel = (message) => (
    message.author?.id === interaction.client.user.id
    && message.components?.some((row) => row.components?.some((component) => component.customId === 'nexus:generate'))
  );

  const pinned = await channel.messages.fetchPins().catch(() => null);
  let panelMessage = pinned?.items?.map((item) => item.message).find(isNexusPanel) || null;
  if (!panelMessage) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    panelMessage = recent?.find(isNexusPanel) || null;
  }

  const existingPanel = Boolean(panelMessage);
  if (panelMessage) await panelMessage.edit(payload);
  else panelMessage = await channel.send(payload);

  const pinSucceeded = panelMessage.pinned
    || await panelMessage.pin('Painel principal do gerador Nexus').then(() => true).catch(() => false);
  await saveGuildConfig(interaction.guildId, { panelChannelId: channel.id });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: existingPanel ? 'generator_bot.panel_updated' : 'generator_bot.panel_published',
    targetType: 'discord_message',
    targetId: panelMessage.id,
    metadata: { channelId: channel.id, pinned: pinSucceeded }
  });
  return interaction.reply({
    content: pinSucceeded
      ? `Painel público atualizado e fixado em ${channel}.`
      : `Painel público atualizado em ${channel}. Para fixar, dê ao bot a permissão **Gerenciar mensagens**.`,
    flags: MessageFlags.Ephemeral
  });
}

async function copyDelivery(interaction, deliveryId) {
  const delivery = await getGeneratorDeliveryForBuyer(deliveryId, interaction.user.id);
  if (!delivery) {
    return interaction.reply(privateReplyOptions(interaction, { content: 'Esta entrega não foi encontrada ou não pertence a você.' }));
  }
  const content = [
    'Copie os dados abaixo:',
    '```text',
    `Usuário: ${delivery.username}`,
    `Senha: ${delivery.password}`,
    '```'
  ].join('\n');
  return interaction.reply(privateReplyOptions(interaction, { content, allowedMentions: { parse: [] } }));
}

async function routeComponent(interaction) {
  const id = interaction.customId;
  if (id === 'nexus:home') return showHome(interaction);
  if (id === 'nexus:generate') return showGenerate(interaction);
  if (id === 'nexus:generate:confirm') return confirmGeneration(interaction);
  if (id === 'nexus:plans') return showPlans(interaction);
  if (id === 'nexus:vip') return showVip(interaction);
  if (id === 'nexus:profile') return showProfile(interaction);
  if (id === 'nexus:history') return showHistory(interaction);
  if (id === 'nexus:key') return showKeyModal(interaction);
  if (id === 'nexus:support') return showSupport(interaction);
  if (id === 'nexus:how') return showHow(interaction);
  if (id === 'nexus:settings') return showSettings(interaction);
  if (id === 'nexus:settings:keys') return showAdminKeyPlans(interaction);
  if (id === 'nexus:admin:key') return generateAdminKey(interaction);
  if (id === 'nexus:setup:channels') return setupChannels(interaction);
  if (id === 'nexus:setup:panel') return publishPanel(interaction);
  if (id === 'nexus:ticket:close') return closeTicket(interaction);
  if (id.startsWith('nexus:pix:status:')) {
    return checkPixPayment(interaction, id.slice('nexus:pix:status:'.length));
  }
  if (id.startsWith('nexus:copy:')) return copyDelivery(interaction, id.slice('nexus:copy:'.length));
  if (id.startsWith('nexus:purchase:')) return createTicket(interaction, 'purchase', id.slice('nexus:purchase:'.length));
  if (id === 'nexus:buy') return createTicket(interaction, 'purchase', interaction.values[0]);
  if (id === 'nexus:support:create') return createTicket(interaction, interaction.values[0]);
}

export function generatorCommandDefinitions() {
  return [
    {
      name: 'conta',
      description: 'Abrir a geração de contas Nexus',
      dmPermission: false
    },
    {
      name: 'pix',
      description: 'Gerar uma cobranca Pix com QR Code',
      dmPermission: false,
      options: [
        {
          type: 10,
          name: 'valor',
          description: 'Valor da cobranca em reais',
          required: true,
          min_value: 1,
          max_value: 100000
        }
      ]
    }
  ];
}

export function isGeneratorInteraction(interaction) {
  if (interaction.isChatInputCommand?.()) {
    if (interaction.commandName === 'nexus') {
      return interaction.options.getSubcommand(false) === 'contas';
    }
    return GENERATOR_COMMAND_NAMES.has(interaction.commandName);
  }
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()) {
    return cleanText(interaction.customId).startsWith(GENERATOR_PREFIX);
  }
  return false;
}

export async function handleGeneratorInteraction(entry, interaction) {
  if (!isGeneratorInteraction(interaction)) return;
  if (entry?.token !== config.discordBot.token) return;
  if (interaction.isChatInputCommand?.()) {
    if (interaction.commandName === 'nexus') return showGenerate(interaction);
    if (interaction.commandName === 'conta') return showGenerate(interaction);
    if (interaction.commandName === 'pix') return createPixCharge(interaction);
    return showGenerate(interaction);
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'nexus:key:submit') {
    return redeemKeyFromModal(interaction);
  }
  return routeComponent(interaction);
}

export const generatorCommandNames = GENERATOR_COMMAND_NAMES;
