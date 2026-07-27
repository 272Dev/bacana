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
import { config, missingEnv } from './config.js';
import { db, nowIso } from './db.js';
import { logAudit } from './audit.js';
import {
  getGeneratorAccess,
  getGeneratorDeliveryForBuyer,
  getGeneratorHistory,
  getGeneratorProfile,
  generateGeneratorKeys,
  listGeneratorPlans,
  recordGeneratorUse,
  redeemGeneratorKey
} from './generatorCommerce.js';
import {
  completeRobloxSalesDelivery,
  getRobloxGeneratorSettings,
  releaseRobloxSalesDelivery,
  reserveRandomRobloxSalesAccount
} from './robloxGenerator.js';

const GENERATOR_COMMAND_NAMES = new Set(['conta', 'nexus', 'pix']);
const GENERATOR_PREFIX = 'nexus:';
const requestsInFlight = new Set();
const pixRequestsInFlight = new Set();
const LIVEPIX_REQUEST_TIMEOUT_MS = 12_000;
const LIVEPIX_TOKEN_REFRESH_MARGIN_MS = 60_000;
let livePixCachedToken = null;
let livePixTokenRequest = null;
const BRAND_COLOR = 0x0A0A0A;
const DEFAULT_FOOTER = 'Nexus • Gerador premium';
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

function makeLivePixError(message, code, status = 502) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function livePixConfigurationError() {
  const missing = [];
  if (missingEnv(config.livePix.clientId)) missing.push('LIVEPIX_CLIENT_ID');
  if (missingEnv(config.livePix.clientSecret)) missing.push('LIVEPIX_CLIENT_SECRET');
  if (missing.length === 0) return null;
  return makeLivePixError(
    `LivePix ainda nao configurada: ${missing.join(' e ')}.`,
    'LIVEPIX_NOT_CONFIGURED',
    503
  );
}

async function parseLivePixJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw makeLivePixError('A LivePix retornou uma resposta invalida.', 'LIVEPIX_INVALID_RESPONSE');
  }
}

function livePixProviderError(response, payload) {
  const providerMessage = cleanText(payload?.message || payload?.error_description || payload?.error);
  if (response.status === 400 && /scope/i.test(providerMessage)) {
    return makeLivePixError(
      'A aplicacao LivePix precisa da permissao payments:write.',
      'LIVEPIX_INVALID_SCOPE',
      503
    );
  }
  if (response.status === 401) {
    return makeLivePixError(
      'As credenciais da LivePix sao invalidas ou foram revogadas.',
      'LIVEPIX_INVALID_CREDENTIALS',
      503
    );
  }
  if (response.status === 403) {
    return makeLivePixError(
      'A aplicacao LivePix nao possui permissao para criar pagamentos.',
      'LIVEPIX_FORBIDDEN',
      503
    );
  }
  if (response.status === 429) {
    return makeLivePixError(
      'O limite de cobrancas da LivePix foi atingido. Aguarde um minuto.',
      'LIVEPIX_RATE_LIMITED',
      429
    );
  }
  if (response.status === 422) {
    return makeLivePixError(
      providerMessage || 'A LivePix recusou os dados desta cobranca.',
      'LIVEPIX_VALIDATION_ERROR',
      422
    );
  }
  return makeLivePixError(
    providerMessage || 'Nao foi possivel gerar a cobranca na LivePix.',
    'LIVEPIX_PROVIDER_ERROR',
    response.status >= 400 && response.status < 600 ? response.status : 502
  );
}

async function livePixFetch(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVEPIX_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeLivePixError('A LivePix demorou demais para responder.', 'LIVEPIX_TIMEOUT', 504);
    }
    throw makeLivePixError('Nao foi possivel conectar com a LivePix.', 'LIVEPIX_UNAVAILABLE', 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestLivePixAccessToken() {
  const missing = livePixConfigurationError();
  if (missing) throw missing;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.livePix.clientId,
    client_secret: config.livePix.clientSecret,
    scope: config.livePix.scope
  });
  const response = await livePixFetch(config.livePix.oauthUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  const payload = await parseLivePixJson(response);
  if (!response.ok) throw livePixProviderError(response, payload);

  const accessToken = cleanText(payload.access_token);
  const expiresIn = Number(payload.expires_in || 3600);
  if (!accessToken) {
    throw makeLivePixError('A LivePix nao retornou um token de acesso.', 'LIVEPIX_INVALID_TOKEN_RESPONSE');
  }

  livePixCachedToken = {
    value: accessToken,
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1000
  };
  return livePixCachedToken.value;
}

async function getLivePixAccessToken({ force = false } = {}) {
  if (
    !force
    && livePixCachedToken
    && Date.now() < livePixCachedToken.expiresAt - LIVEPIX_TOKEN_REFRESH_MARGIN_MS
  ) {
    return livePixCachedToken.value;
  }
  if (livePixTokenRequest) return livePixTokenRequest;

  livePixTokenRequest = requestLivePixAccessToken().finally(() => {
    livePixTokenRequest = null;
  });
  return livePixTokenRequest;
}

function normalizeLivePixRedirectUrl() {
  let parsed;
  try {
    parsed = new URL(config.livePix.redirectUrl);
  } catch {
    throw makeLivePixError('LIVEPIX_REDIRECT_URL nao e uma URL valida.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw makeLivePixError('LIVEPIX_REDIRECT_URL precisa usar HTTP ou HTTPS.', 'LIVEPIX_INVALID_REDIRECT', 503);
  }
  return parsed.href;
}

function normalizeLivePixCheckoutUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw makeLivePixError('A LivePix nao retornou um checkout valido.', 'LIVEPIX_INVALID_CHECKOUT');
  }
  const trustedHost = parsed.hostname === 'livepix.gg' || parsed.hostname.endsWith('.livepix.gg');
  if (parsed.protocol !== 'https:' || !trustedHost) {
    throw makeLivePixError('A LivePix retornou um checkout nao confiavel.', 'LIVEPIX_UNTRUSTED_CHECKOUT');
  }
  return parsed.href;
}

async function createLivePixPaymentRequest(amountCents, accessToken) {
  const response = await livePixFetch(`${config.livePix.apiUrl}/v2/payments`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amountCents,
      currency: 'BRL',
      redirectUrl: normalizeLivePixRedirectUrl()
    })
  });
  const payload = await parseLivePixJson(response);
  return { response, payload };
}

async function createLivePixPayment(amountCents) {
  const normalizedAmount = Number(amountCents);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 100 || normalizedAmount > 10_000_000) {
    throw makeLivePixError(
      'O valor deve estar entre R$ 1,00 e R$ 100.000,00.',
      'LIVEPIX_INVALID_AMOUNT',
      400
    );
  }

  let accessToken = await getLivePixAccessToken();
  let result = await createLivePixPaymentRequest(normalizedAmount, accessToken);
  if (result.response.status === 401) {
    livePixCachedToken = null;
    accessToken = await getLivePixAccessToken({ force: true });
    result = await createLivePixPaymentRequest(normalizedAmount, accessToken);
  }
  if (!result.response.ok) throw livePixProviderError(result.response, result.payload);

  const reference = cleanText(result.payload?.data?.reference);
  const checkoutUrl = normalizeLivePixCheckoutUrl(result.payload?.data?.redirectUrl);
  if (!reference) {
    throw makeLivePixError('A LivePix nao retornou a referencia da cobranca.', 'LIVEPIX_INVALID_PAYMENT');
  }

  return {
    reference,
    checkoutUrl,
    amountCents: normalizedAmount,
    currency: 'BRL'
  };
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
  const amountCents = Math.round(value * 100);
  pixRequestsInFlight.add(interaction.user.id);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const payment = await createLivePixPayment(amountCents);
    const paymentEmbed = await brandEmbed(interaction, {
      title: 'Pagamento Pix',
      description: [
        '**Cobranca gerada com seguranca pela LivePix.**',
        'Clique no botao abaixo para abrir o checkout e concluir o pagamento.',
        '',
        '━━━━━━━━━━━━━━━━━━━━'
      ].join('\n'),
      fields: [
        { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
        { name: 'Status', value: 'Aguardando pagamento', inline: true },
        { name: 'Referencia', value: `\`${safeText(payment.reference, 100)}\``, inline: false }
      ],
      image: false
    });
    const paymentRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Pagar com Pix')
        .setEmoji('💠')
        .setStyle(ButtonStyle.Link)
        .setURL(payment.checkoutUrl)
    );
    const payload = {
      embeds: [paymentEmbed],
      components: [paymentRow],
      allowedMentions: { parse: [] }
    };

    const posted = interaction.channel?.isTextBased?.()
      ? await interaction.channel.send(payload).catch(() => null)
      : null;

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
        currency: payment.currency
      }
    }).catch(() => {});

    const logEmbed = await brandEmbed(interaction, {
      title: 'Nova cobranca Pix',
      description: `Cobranca criada por <@${interaction.user.id}>.`,
      fields: [
        { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
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
  if (plans.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('nexus:buy')
        .setPlaceholder('Selecionar plano para comprar')
        .addOptions(plans.slice(0, 25).map((plan) => ({
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

function ticketSlug(user) {
  const base = cleanText(user.username).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'usuario';
  return `ticket-${base}-${user.id.slice(-4)}`;
}

async function createTicket(interaction, type, planId = null) {
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
  const channel = await interaction.guild.channels.create({
    name: ticketSlug(interaction.user),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `nexus-user:${interaction.user.id};type:${type};plan:${planId || ''}`,
    permissionOverwrites: [
      { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles]
      },
      ...(me ? [{
        id: me.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels]
      }] : [])
    ],
    reason: `Ticket Nexus de ${interaction.user.tag}`
  });
  const plans = planId ? await listGeneratorPlans() : [];
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const ticketEmbed = await brandEmbed(interaction, {
    title: `Ticket • ${SUPPORT_TYPES[type] || 'Suporte'}`,
    description: [
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
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'generator_bot.ticket_created',
    targetType: 'discord_channel',
    targetId: channel.id,
    metadata: { type, planId }
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
      '**2.** A equipe entrega uma key única.',
      '**3.** Use **Resgatar key** para ativar seu plano.',
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
      name: 'nexus',
      description: 'Abrir o painel premium do gerador Nexus',
      dmPermission: false,
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild.toString()
    },
    {
      name: 'pix',
      description: 'Gerar uma cobranca Pix pela LivePix',
      dmPermission: false,
      defaultMemberPermissions: PermissionFlagsBits.ManageGuild.toString(),
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
  if (interaction.isChatInputCommand?.()) return GENERATOR_COMMAND_NAMES.has(interaction.commandName);
  if (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()) {
    return cleanText(interaction.customId).startsWith(GENERATOR_PREFIX);
  }
  return false;
}

export async function handleGeneratorInteraction(entry, interaction) {
  if (!isGeneratorInteraction(interaction)) return;
  if (entry?.token !== config.discordBot.token) return;
  if (interaction.isChatInputCommand?.()) {
    if (interaction.commandName === 'conta') return showGenerate(interaction);
    if (interaction.commandName === 'pix') return createPixCharge(interaction);
    return publishPanel(interaction);
  }
  if (interaction.isModalSubmit?.() && interaction.customId === 'nexus:key:submit') {
    return redeemKeyFromModal(interaction);
  }
  return routeComponent(interaction);
}

export const generatorCommandNames = GENERATOR_COMMAND_NAMES;
