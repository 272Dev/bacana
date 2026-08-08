import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { config } from './config.js';
import { logAudit } from './audit.js';
import { createLivePixPayment, createLivePixQrCode } from './livePix.js';
import {
  createLivePixPaymentIntent,
  getLivePixPaymentIntent,
  syncLivePixPaymentIntent
} from './livePixPayments.js';
import {
  appendTextStockParagraphs,
  createTextProduct,
  findTextProduct,
  listTextProducts
} from './textStock.js';
import { fulfillLivePixPaymentIntent } from './generatorBot.js';

const TEXT_STOCK_COMMAND_NAMES = new Set(['stock']);
const TEXT_STOCK_PREFIX = 'textstock:';
const BRAND_COLOR = 0x0A0A0A;

function cleanText(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function safeText(value, max = 1000) {
  return cleanText(value, max).replace(/`/g, 'ˋ');
}

function formatPrice(cents) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Math.max(0, Number(cents || 0)) / 100);
}

function isStockManager(interaction) {
  if (config.discordBot.ownerIds.includes(String(interaction.user?.id || ''))) return true;
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild));
}

function assertStockManager(interaction) {
  if (isStockManager(interaction)) return;
  const error = new Error('Você precisa da permissão Gerenciar servidor para administrar o stock.');
  error.code = 'TEXT_STOCK_FORBIDDEN';
  throw error;
}

function assertStockGuild(interaction) {
  const configuredGuildId = cleanText(config.discordBot.defaultGuildId, 40);
  if (!configuredGuildId) {
    const error = new Error('Configure DISCORD_DEFAULT_GUILD_ID antes de usar o stock de texto.');
    error.code = 'TEXT_STOCK_GUILD_NOT_CONFIGURED';
    throw error;
  }
  if (cleanText(interaction.guildId, 40) !== configuredGuildId) {
    const error = new Error('O stock de texto esta disponivel apenas no servidor configurado.');
    error.code = 'TEXT_STOCK_WRONG_GUILD';
    throw error;
  }
}

function purchaseProductLabel(product) {
  return safeText(product?.slug || product?.name || product?.id, 80);
}

function stockStateLine(product) {
  const available = Math.max(0, Number(product?.availableCount ?? product?.available ?? 0));
  const reserved = Math.max(0, Number(product?.reservedCount ?? product?.reserved ?? 0));
  const delivered = Math.max(0, Number(product?.deliveredCount ?? product?.delivered ?? 0));
  return `Disponíveis: **${available}** · Reservados: **${reserved}** · Entregues: **${delivered}**`;
}

async function resolveProduct(value, { activeOnly = false } = {}) {
  const product = await findTextProduct(cleanText(value, 120));
  if (!product) throw new Error('Produto de texto não encontrado. Use o slug exibido em /stock catalogo.');
  if (activeOnly && !product.active) throw new Error('Esse produto está indisponível no momento.');
  return product;
}

async function replyEphemeral(interaction, content) {
  if (interaction.deferred || interaction.replied) return interaction.editReply(content);
  return interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function createProduct(interaction) {
  assertStockManager(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString('nome', true);
  const priceCents = Math.round(interaction.options.getNumber('preco', true) * 100);
  const itemsPerPurchase = interaction.options.getInteger('quantidade', true);
  const product = await createTextProduct({
    name,
    priceCents,
    itemsPerPurchase,
    createdByDiscordId: interaction.user.id
  });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'text_stock.product_created',
    targetType: 'text_stock_product',
    targetId: product.id,
    metadata: { slug: product.slug, priceCents: product.priceCents, itemsPerPurchase: product.itemsPerPurchase }
  }).catch(() => {});
  return interaction.editReply([
    `Produto **${safeText(product.name, 80)}** criado.`,
    `Slug de compra: \`${safeText(product.slug, 80)}\``,
    `Preço: **${formatPrice(product.priceCents)}** · Itens por compra: **${product.itemsPerPurchase}**`,
    'Agora envie os itens com `/stock adicionar`; cada parágrafo separado por uma linha vazia é um item da fila.'
  ].join('\n'));
}

async function addStock(interaction) {
  assertStockManager(interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const product = await resolveProduct(interaction.options.getString('produto', true));
  const rawItems = interaction.options.getString('itens', true);
  const result = await appendTextStockParagraphs(product.id, rawItems, {
    actorDiscordId: interaction.user.id
  });
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'text_stock.items_appended',
    targetType: 'text_stock_product',
    targetId: product.id,
    metadata: { slug: product.slug, count: result.count, firstQueuePosition: result.firstQueuePosition, lastQueuePosition: result.lastQueuePosition }
  }).catch(() => {});
  return interaction.editReply([
    `Adicionei **${result.count}** item(ns) ao stock de **${safeText(product.name, 80)}**.`,
    `Fila adicionada: **#${result.firstQueuePosition}** até **#${result.lastQueuePosition}**.`,
    'A próxima compra confirmada recebe sempre o menor número ainda disponível.'
  ].join('\n'));
}

async function showCatalog(interaction) {
  const products = await listTextProducts({ activeOnly: true });
  if (!products.length) return replyEphemeral(interaction, 'Ainda não há produtos de texto disponíveis.');
  const fields = products.slice(0, 20).map((product) => ({
    name: `${safeText(product.name, 80)} · ${formatPrice(product.priceCents)}`,
    value: [
      `Produto: \`${purchaseProductLabel(product)}\``,
      `${Math.max(0, Number(product.availableCount ?? product.available ?? 0))} item(ns) disponíveis`,
      `${product.itemsPerPurchase} item(ns) por compra`
    ].join('\n'),
    inline: false
  }));
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('Stock de texto')
    .setDescription('Escolha um produto e use `/stock comprar produto:<slug>`. A entrega chega no seu privado depois da confirmação do Pix.')
    .addFields(fields)
    .setFooter({ text: 'A fila é consumida em ordem: 1, depois 2, depois 3.' });
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function showStockStatus(interaction) {
  assertStockManager(interaction);
  const products = await listTextProducts({ activeOnly: false });
  if (!products.length) return replyEphemeral(interaction, 'Nenhum produto de texto foi criado ainda.');
  const text = products.slice(0, 25).map((product) => [
    `**${safeText(product.name, 80)}** ${product.active ? '' : '(pausado)'}`.trim(),
    `\`${purchaseProductLabel(product)}\` · ${formatPrice(product.priceCents)} · ${product.itemsPerPurchase} por compra`,
    stockStateLine(product)
  ].join('\n')).join('\n\n');
  return replyEphemeral(interaction, text.slice(0, 1900));
}

async function createPurchase(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const product = await resolveProduct(interaction.options.getString('produto', true), { activeOnly: true });
  const available = Math.max(0, Number(product.availableCount ?? product.available ?? 0));
  if (available < product.itemsPerPurchase) {
    return interaction.editReply('Esse produto está sem stock suficiente agora. Nenhuma cobrança foi criada.');
  }

  const payment = await createLivePixPayment(product.priceCents);
  await createLivePixPaymentIntent({
    reference: payment.reference,
    checkoutUrl: payment.checkoutUrl,
    amountCents: payment.amountCents,
    currency: payment.currency,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    createdByDiscordId: interaction.user.id,
    buyerDiscordId: interaction.user.id,
    productType: 'text_stock',
    productId: product.id,
    metadata: {
      source: 'discord_text_stock_purchase',
      productName: product.name,
      productSlug: product.slug,
      productPriceCents: product.priceCents,
      itemsPerPurchase: product.itemsPerPurchase
    }
  });

  const qrCode = await createLivePixQrCode(payment.checkoutUrl);
  const qrCodeName = 'nexus-text-stock-pix.png';
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle(`Comprar ${safeText(product.name, 80)} com Pix`)
    .setDescription([
      'Pague pelo QR Code ou pelo botão abaixo.',
      'Depois da confirmação da LivePix, o bot separa seus itens na ordem do stock e envia tudo no seu privado.',
      `Para consultar o estado manualmente, use /stock verificar referencia:${payment.reference}.`,
      '',
      'Se o privado estiver fechado, sua posição e os mesmos itens ficam guardados até a próxima tentativa.'
    ].join('\n'))
    .addFields(
      { name: 'Produto', value: safeText(product.name, 80), inline: true },
      { name: 'Valor', value: formatPrice(payment.amountCents), inline: true },
      { name: 'Itens', value: String(product.itemsPerPurchase), inline: true },
      { name: 'Referência', value: `\`${safeText(payment.reference, 100)}\``, inline: false }
    )
    .setImage(`attachment://${qrCodeName}`)
    .setFooter({ text: 'A entrega é feita somente por mensagem privada.' });
  const verifyCustomId = `textstock:pix:status:${payment.reference}`;
  const actions = [
    new ButtonBuilder()
      .setLabel('Pagar com Pix')
      .setStyle(ButtonStyle.Link)
      .setURL(payment.checkoutUrl)
  ];
  // Discord limita custom_id a 100 caracteres. Referências longas continuam
  // funcionando pelo comando /stock verificar, sem truncar o identificador.
  if (verifyCustomId.length <= 100) {
    actions.push(
      new ButtonBuilder()
        .setCustomId(verifyCustomId)
        .setLabel('Verificar pagamento')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  const row = new ActionRowBuilder().addComponents(...actions);
  await logAudit({
    actorDiscordId: interaction.user.id,
    action: 'text_stock.payment_created',
    targetType: 'livepix_payment',
    targetId: payment.reference,
    metadata: { productId: product.id, productSlug: product.slug, amountCents: payment.amountCents, itemsPerPurchase: product.itemsPerPurchase }
  }).catch(() => {});
  return interaction.editReply({
    embeds: [embed],
    components: [row],
    files: [{ attachment: qrCode, name: qrCodeName }],
    allowedMentions: { parse: [] }
  });
}

function paymentResponse(intent) {
  if (intent?.fulfillmentStatus === 'completed') {
    return 'Pagamento confirmado. Seus itens foram enviados no privado do Discord.';
  }
  return 'Pagamento confirmado. Sua posição no stock está guardada; o bot vai entregar no privado assim que o stock e a DM permitirem.';
}

async function verifyPurchase(interaction, reference) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const initial = await getLivePixPaymentIntent(reference);
  if (!initial || initial.productType !== 'text_stock') {
    return interaction.editReply('Essa cobrança de stock de texto não foi encontrada.');
  }
  if (initial.buyerDiscordId !== interaction.user.id && !isStockManager(interaction)) {
    return interaction.editReply('Essa cobrança pertence a outro comprador.');
  }
  const result = await syncLivePixPaymentIntent(reference);
  if (!result.found) return interaction.editReply('Essa cobrança não foi encontrada.');
  if (!result.paid) {
    return interaction.editReply(
      result.reason === 'not_received'
        ? 'A LivePix ainda não confirmou o pagamento. Aguarde alguns segundos e tente de novo.'
        : `O pagamento ainda está pendente (${safeText(result.reason, 100)}).`
    );
  }
  const fulfilled = await fulfillLivePixPaymentIntent(interaction.client, result.intent);
  return interaction.editReply(paymentResponse(fulfilled));
}

export function textStockCommandDefinitions() {
  return [{
    name: 'stock',
    description: 'Comprar e administrar itens de texto em fila',
    dmPermission: false,
    options: [
      {
        type: 1,
        name: 'catalogo',
        description: 'Ver os produtos de texto disponíveis'
      },
      {
        type: 1,
        name: 'comprar',
        description: 'Criar um Pix para comprar itens de texto',
        options: [
          { type: 3, name: 'produto', description: 'Slug do produto', required: true, max_length: 120 }
        ]
      },
      {
        type: 1,
        name: 'verificar',
        description: 'Verificar e entregar uma compra Pix',
        options: [
          { type: 3, name: 'referencia', description: 'Referência da cobrança', required: true, max_length: 200 }
        ]
      },
      {
        type: 1,
        name: 'criar',
        description: 'Criar um produto de texto',
        options: [
          { type: 3, name: 'nome', description: 'Nome do produto', required: true, max_length: 80 },
          { type: 10, name: 'preco', description: 'Preço em reais', required: true, min_value: 1, max_value: 100000 },
          { type: 4, name: 'quantidade', description: 'Itens entregues por compra', required: true, min_value: 1, max_value: 50 }
        ]
      },
      {
        type: 1,
        name: 'adicionar',
        description: 'Adicionar itens separados por parágrafos',
        options: [
          { type: 3, name: 'produto', description: 'Slug do produto', required: true, max_length: 120 },
          { type: 3, name: 'itens', description: 'Um item por parágrafo vazio', required: true, max_length: 6000 }
        ]
      },
      {
        type: 1,
        name: 'status',
        description: 'Ver o estado administrativo do stock'
      }
    ]
  }];
}

export function isTextStockInteraction(interaction) {
  if (interaction.isChatInputCommand?.()) return TEXT_STOCK_COMMAND_NAMES.has(interaction.commandName);
  return Boolean(interaction.isButton?.() && cleanText(interaction.customId).startsWith(TEXT_STOCK_PREFIX));
}

export async function handleTextStockInteraction(entry, interaction) {
  if (!isTextStockInteraction(interaction)) return;
  if (entry?.token !== config.discordBot.token) return;
  assertStockGuild(interaction);
  if (interaction.isButton?.()) {
    const prefix = 'textstock:pix:status:';
    if (cleanText(interaction.customId).startsWith(prefix)) {
      return verifyPurchase(interaction, interaction.customId.slice(prefix.length));
    }
    return;
  }
  const subcommand = interaction.options.getSubcommand(true);
  if (subcommand === 'catalogo') return showCatalog(interaction);
  if (subcommand === 'comprar') return createPurchase(interaction);
  if (subcommand === 'verificar') return verifyPurchase(interaction, interaction.options.getString('referencia', true));
  if (subcommand === 'criar') return createProduct(interaction);
  if (subcommand === 'adicionar') return addStock(interaction);
  if (subcommand === 'status') return showStockStatus(interaction);
}

export const textStockCommandNames = TEXT_STOCK_COMMAND_NAMES;
