import crypto from 'node:crypto';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import {
  findLivePixReceivedPayment,
  getLivePixReceivedPayment
} from './livePix.js';

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function parseMetadata(value) {
  try {
    return JSON.parse(value || '{}') || {};
  } catch {
    return {};
  }
}

function mapIntent(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    providerPaymentId: row.provider_payment_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    createdByDiscordId: row.created_by_discord_id,
    buyerDiscordId: row.buyer_discord_id,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    productType: row.product_type,
    productId: row.product_id,
    checkoutUrl: row.checkout_url,
    proof: row.proof,
    metadata: parseMetadata(row.metadata_json),
    providerCreatedAt: row.provider_created_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    fulfillmentStatus: row.fulfillment_status,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeProductType(value) {
  const type = cleanText(value || 'manual', 80).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(type)) throw new Error('Tipo de produto invalido.');
  return type;
}

export async function createLivePixPaymentIntent({
  reference,
  checkoutUrl,
  amountCents,
  currency = 'BRL',
  guildId = null,
  channelId = null,
  createdByDiscordId = null,
  buyerDiscordId = null,
  productType = 'manual',
  productId = null,
  metadata = {}
}) {
  const normalizedReference = cleanText(reference, 200);
  const normalizedAmount = Number(amountCents);
  const normalizedCurrency = cleanText(currency, 10).toUpperCase();
  const normalizedProductType = normalizeProductType(productType);
  if (!normalizedReference || !Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error('Dados da cobranca LivePix invalidos.');
  }
  const timestamp = nowIso();
  const id = crypto.randomUUID();
  const fulfillmentStatus = normalizedProductType === 'manual' ? 'not_required' : 'pending';
  await db.prepare(`
    INSERT INTO livepix_payment_intents (
      id, reference, guild_id, channel_id, created_by_discord_id, buyer_discord_id,
      amount_cents, currency, status, product_type, product_id, checkout_url,
      metadata_json, fulfillment_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    normalizedReference,
    cleanText(guildId, 40) || null,
    cleanText(channelId, 40) || null,
    cleanText(createdByDiscordId, 40) || null,
    cleanText(buyerDiscordId, 40) || null,
    normalizedAmount,
    normalizedCurrency,
    normalizedProductType,
    cleanText(productId, 200) || null,
    String(checkoutUrl),
    JSON.stringify(safeMetadata(metadata)),
    fulfillmentStatus,
    timestamp,
    timestamp
  );
  return getLivePixPaymentIntent(normalizedReference);
}

export async function attachLivePixDiscordMessage(reference, { guildId, channelId, messageId }) {
  await db.prepare(`
    UPDATE livepix_payment_intents
    SET guild_id = ?, channel_id = ?, message_id = ?, updated_at = ?
    WHERE reference = ?
  `).run(
    cleanText(guildId, 40) || null,
    cleanText(channelId, 40) || null,
    cleanText(messageId, 40) || null,
    nowIso(),
    cleanText(reference, 200)
  );
  return getLivePixPaymentIntent(reference);
}

export async function getLivePixPaymentIntent(reference) {
  const row = await db.prepare(
    'SELECT * FROM livepix_payment_intents WHERE reference = ?'
  ).get(cleanText(reference, 200));
  return mapIntent(row);
}

export async function listUnnotifiedPaidLivePixPayments(limit = 50) {
  const normalizedLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await db.prepare(`
    SELECT * FROM livepix_payment_intents
    WHERE status = 'paid' AND notified_at IS NULL
    ORDER BY paid_at ASC
    LIMIT ${normalizedLimit}
  `).all();
  return rows.map(mapIntent);
}

export async function listPendingLivePixPayments(limit = 25) {
  const normalizedLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const rows = await db.prepare(`
    SELECT * FROM livepix_payment_intents
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT ${normalizedLimit}
  `).all();
  return rows.map(mapIntent);
}

export async function markLivePixPaymentNotified(reference) {
  await db.prepare(`
    UPDATE livepix_payment_intents
    SET notified_at = COALESCE(notified_at, ?), updated_at = ?
    WHERE reference = ? AND status = 'paid'
  `).run(nowIso(), nowIso(), cleanText(reference, 200));
  return getLivePixPaymentIntent(reference);
}

function verifyProviderPayment(intent, payment) {
  if (!payment) return { ok: false, reason: 'not_received' };
  if (payment.reference !== intent.reference) return { ok: false, reason: 'reference_mismatch' };
  if (!Number.isSafeInteger(payment.amountCents) || payment.amountCents !== intent.amountCents) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (payment.currency !== intent.currency) return { ok: false, reason: 'currency_mismatch' };
  if (!payment.id || !payment.proof) return { ok: false, reason: 'missing_provider_proof' };
  return { ok: true };
}

async function persistPaidIntent(intent, payment) {
  const paidAt = payment.createdAt || nowIso();
  await db.prepare(`
    UPDATE livepix_payment_intents
    SET provider_payment_id = ?, proof = ?, provider_created_at = ?,
        status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ?
    WHERE reference = ? AND status = 'pending'
  `).run(
    payment.id,
    payment.proof,
    payment.createdAt,
    paidAt,
    nowIso(),
    intent.reference
  );
  return getLivePixPaymentIntent(intent.reference);
}

export async function syncLivePixPaymentIntent(reference, { providerPaymentId = null } = {}) {
  const intent = await getLivePixPaymentIntent(reference);
  if (!intent) return { found: false, paid: false, reason: 'unknown_reference', intent: null };
  if (intent.status === 'paid') {
    return { found: true, paid: true, reason: 'already_paid', intent };
  }
  if (intent.status !== 'pending') {
    return { found: true, paid: false, reason: intent.status, intent };
  }

  const paymentId = cleanText(providerPaymentId, 200);
  const payment = paymentId
    ? await getLivePixReceivedPayment(paymentId)
    : await findLivePixReceivedPayment(intent.reference);
  const verification = verifyProviderPayment(intent, payment);
  if (!verification.ok) {
    return { found: true, paid: false, reason: verification.reason, intent, payment };
  }
  const updated = await persistPaidIntent(intent, payment);
  return { found: true, paid: true, reason: 'confirmed', intent: updated, payment };
}

function validateWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const resource = payload.resource;
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return null;
  const normalized = {
    clientId: cleanText(payload.clientId, 200),
    userId: cleanText(payload.userId, 200),
    event: cleanText(payload.event, 40).toLowerCase(),
    resource: {
      id: cleanText(resource.id, 200),
      reference: cleanText(resource.reference, 200),
      type: cleanText(resource.type, 40).toLowerCase()
    }
  };
  if (
    !normalized.clientId
    || normalized.event !== 'new'
    || normalized.resource.type !== 'payment'
    || !normalized.resource.id
    || !normalized.resource.reference
  ) {
    return null;
  }
  return normalized;
}

export async function processLivePixWebhook(payload) {
  const event = validateWebhookPayload(payload);
  if (!event) return { received: true, ignored: true, reason: 'invalid_event' };
  if (event.clientId !== config.livePix.clientId) {
    return { received: true, ignored: true, reason: 'client_mismatch' };
  }

  const result = await syncLivePixPaymentIntent(event.resource.reference, {
    providerPaymentId: event.resource.id
  });
  if (!result.found) {
    return { received: true, ignored: true, reason: 'unknown_reference' };
  }
  if (!result.paid) {
    return { received: true, ignored: true, reason: result.reason, intent: result.intent };
  }
  return {
    received: true,
    ignored: false,
    paid: true,
    reason: result.reason,
    intent: result.intent,
    payment: result.payment
  };
}
