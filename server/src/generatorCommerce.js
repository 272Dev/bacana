import crypto from 'node:crypto';
import { z } from 'zod';
import { db, nowIso } from './db.js';
import { config } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { getAuthorizedUser } from './db.js';
import { hasPermission, PERMISSIONS } from './permissions.js';

const planSchema = z.object({
  name: z.string().trim().min(2).max(64),
  durationDays: z.coerce.number().int().min(1).max(3650).nullable(),
  generationLimit: z.coerce.number().int().min(0).max(100000),
  cooldownSeconds: z.coerce.number().int().min(0).max(604800),
  priceCents: z.coerce.number().int().min(0).max(100000000),
  benefits: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  featured: z.boolean().default(false),
  vip: z.boolean().default(false),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(10000).default(0)
});

const planUpdateSchema = planSchema.partial();
const keyBatchSchema = z.object({
  planId: z.string().trim().min(1).max(80),
  quantity: z.coerce.number().int().min(1).max(100)
});

function cleanText(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizeKey(value) {
  return cleanText(value).toUpperCase().replace(/\s+/g, '');
}

function hashKey(value) {
  return crypto.createHash('sha256').update(normalizeKey(value)).digest('hex');
}

function generateKeyValue() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  const body = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `NEXUS-GEN-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`;
}

function generatePaymentKeyValue(paymentReference) {
  const digest = crypto
    .createHmac('sha256', String(config.security.masterKey || ''))
    .update(`generator-payment:${cleanText(paymentReference)}`)
    .digest();
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const body = [...digest.subarray(0, 20)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');
  return `NEXUS-GEN-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10, 15)}-${body.slice(15, 20)}`;
}

function keyPreview(value) {
  const key = normalizeKey(value);
  return `${key.slice(0, 14)}••••${key.slice(-4)}`;
}

function mapPlan(row) {
  if (!row) return null;
  return {
    id: row.joined_plan_id || row.plan_id || row.id,
    name: row.name,
    durationDays: row.duration_days == null ? null : Number(row.duration_days),
    generationLimit: Math.max(0, Number(row.generation_limit || 0)),
    cooldownSeconds: Math.max(0, Number(row.cooldown_seconds || 0)),
    priceCents: Math.max(0, Number(row.price_cents || 0)),
    benefits: parseJson(row.benefits_json, []),
    featured: Number(row.featured || 0) === 1,
    vip: Number(row.vip || 0) === 1,
    active: Number(row.active || 0) === 1,
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSubscription(row) {
  if (!row) return null;
  const limit = Math.max(0, Number(row.generation_limit || 0));
  const used = Math.max(0, Number(row.generations_used || 0));
  return {
    discordId: row.discord_id,
    status: row.status,
    plan: mapPlan(row),
    generationsUsed: used,
    generationsRemaining: limit === 0 ? null : Math.max(0, limit - used),
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    customerSince: row.customer_since || row.created_at,
    updatedAt: row.updated_at
  };
}

function expirationFromPlan(plan, baseDate = new Date()) {
  if (plan.duration_days == null) return null;
  return new Date(baseDate.getTime() + Number(plan.duration_days) * 86400000).toISOString();
}

async function getPlanRow(planId, { activeOnly = false } = {}) {
  const suffix = activeOnly ? ' AND active = 1' : '';
  return db.prepare(`SELECT * FROM generator_plans WHERE id = ?${suffix}`).get(planId);
}

async function getSubscriptionRow(discordId) {
  return db.prepare(`
    SELECT subscription.*, plan.id AS joined_plan_id, plan.name, plan.duration_days, plan.generation_limit,
      plan.cooldown_seconds, plan.price_cents, plan.benefits_json, plan.featured,
      plan.vip, plan.active, plan.sort_order
    FROM generator_subscriptions subscription
    JOIN generator_plans plan ON plan.id = subscription.plan_id
    WHERE subscription.discord_id = ?
  `).get(discordId);
}

async function expireSubscription(row) {
  if (!row || row.status !== 'active' || !row.expires_at) return row;
  if (Date.parse(row.expires_at) > Date.now()) return row;
  await db.prepare(`
    UPDATE generator_subscriptions
    SET status = 'expired', updated_at = ?
    WHERE discord_id = ? AND status = 'active'
  `).run(nowIso(), row.discord_id);
  return getSubscriptionRow(row.discord_id);
}

export async function seedGeneratorPlans() {
  const timestamp = nowIso();
  const plans = [
    {
      id: 'test',
      name: 'Teste',
      durationDays: 1,
      generationLimit: 1,
      cooldownSeconds: 300,
      priceCents: 0,
      benefits: ['1 geracao', 'Acesso por 24 horas', 'Validacao do servico'],
      featured: false,
      vip: false,
      sortOrder: 10
    },
    {
      id: 'weekly',
      name: 'Semanal',
      durationDays: 7,
      generationLimit: 5,
      cooldownSeconds: 120,
      priceCents: 2490,
      benefits: ['5 geracoes', 'Acesso por 7 dias', 'Suporte padrao'],
      featured: false,
      vip: false,
      sortOrder: 20
    },
    {
      id: 'monthly',
      name: 'Mensal',
      durationDays: 30,
      generationLimit: 20,
      cooldownSeconds: 60,
      priceCents: 5990,
      benefits: ['20 geracoes', 'Acesso por 30 dias', 'Renovacao por key'],
      featured: true,
      vip: false,
      sortOrder: 30
    },
    {
      id: 'vip',
      name: 'VIP',
      durationDays: 30,
      generationLimit: 50,
      cooldownSeconds: 15,
      priceCents: 11990,
      benefits: ['50 geracoes', 'Cooldown reduzido', 'Prioridade e suporte VIP', 'Cargo exclusivo quando configurado'],
      featured: false,
      vip: true,
      sortOrder: 40
    },
    {
      id: 'lifetime',
      name: 'Lifetime',
      durationDays: null,
      generationLimit: 100,
      cooldownSeconds: 30,
      priceCents: 24990,
      benefits: ['100 geracoes', 'Validade vitalicia', 'Suporte prioritario'],
      featured: false,
      vip: true,
      sortOrder: 50
    }
  ];

  for (const plan of plans) {
    await db.prepare(`
      INSERT INTO generator_plans (
        id, name, duration_days, generation_limit, cooldown_seconds, price_cents,
        benefits_json, featured, vip, active, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `).run(
      plan.id,
      plan.name,
      plan.durationDays,
      plan.generationLimit,
      plan.cooldownSeconds,
      plan.priceCents,
      JSON.stringify(plan.benefits),
      plan.featured ? 1 : 0,
      plan.vip ? 1 : 0,
      plan.sortOrder,
      timestamp,
      timestamp
    );
  }
}

export async function listGeneratorPlans({ activeOnly = false } = {}) {
  const rows = await db.prepare(`
    SELECT * FROM generator_plans
    ${activeOnly ? 'WHERE active = 1' : ''}
    ORDER BY sort_order ASC, price_cents ASC, name ASC
  `).all();
  return rows.map(mapPlan);
}

export async function createGeneratorPlan(input) {
  const payload = planSchema.parse(input);
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  await db.prepare(`
    INSERT INTO generator_plans (
      id, name, duration_days, generation_limit, cooldown_seconds, price_cents,
      benefits_json, featured, vip, active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    payload.name,
    payload.durationDays,
    payload.generationLimit,
    payload.cooldownSeconds,
    payload.priceCents,
    JSON.stringify(payload.benefits),
    payload.featured ? 1 : 0,
    payload.vip ? 1 : 0,
    payload.active ? 1 : 0,
    payload.sortOrder,
    timestamp,
    timestamp
  );
  return mapPlan(await getPlanRow(id));
}

export async function updateGeneratorPlan(planId, input) {
  const payload = planUpdateSchema.parse(input);
  const current = await getPlanRow(planId);
  if (!current) throw Object.assign(new Error('Plano do gerador nao encontrado.'), { status: 404 });
  const benefits = Object.hasOwn(payload, 'benefits') ? payload.benefits : parseJson(current.benefits_json, []);
  await db.prepare(`
    UPDATE generator_plans SET
      name = ?, duration_days = ?, generation_limit = ?, cooldown_seconds = ?,
      price_cents = ?, benefits_json = ?, featured = ?, vip = ?, active = ?,
      sort_order = ?, updated_at = ?
    WHERE id = ?
  `).run(
    payload.name ?? current.name,
    Object.hasOwn(payload, 'durationDays') ? payload.durationDays : current.duration_days,
    payload.generationLimit ?? current.generation_limit,
    payload.cooldownSeconds ?? current.cooldown_seconds,
    payload.priceCents ?? current.price_cents,
    JSON.stringify(benefits),
    payload.featured == null ? current.featured : payload.featured ? 1 : 0,
    payload.vip == null ? current.vip : payload.vip ? 1 : 0,
    payload.active == null ? current.active : payload.active ? 1 : 0,
    payload.sortOrder ?? current.sort_order,
    nowIso(),
    planId
  );
  return mapPlan(await getPlanRow(planId));
}

export async function deleteGeneratorPlan(planId) {
  const usage = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM generator_keys WHERE plan_id = ?) AS keys,
      (SELECT COUNT(*) FROM generator_subscriptions WHERE plan_id = ?) AS subscriptions
  `).get(planId, planId);
  if (Number(usage?.keys || 0) + Number(usage?.subscriptions || 0) > 0) {
    throw Object.assign(new Error('Este plano possui keys ou assinaturas. Desative-o em vez de excluir.'), { status: 409 });
  }
  const result = await db.prepare('DELETE FROM generator_plans WHERE id = ?').run(planId);
  if (!Number(result.changes || 0)) throw Object.assign(new Error('Plano do gerador nao encontrado.'), { status: 404 });
}

export async function generateGeneratorKeys(input, actorDiscordId) {
  const payload = keyBatchSchema.parse(input);
  const plan = await getPlanRow(payload.planId, { activeOnly: true });
  if (!plan) throw Object.assign(new Error('Plano invalido ou desativado.'), { status: 400 });
  const timestamp = nowIso();
  const keys = [];

  for (let index = 0; index < payload.quantity; index += 1) {
    const value = generateKeyValue();
    const id = crypto.randomUUID();
    await db.prepare(`
      INSERT INTO generator_keys (
        id, key_hash, key_encrypted, key_preview, plan_id, status,
        redeemed_by, redeemed_at, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)
    `).run(id, hashKey(value), encryptSecret(value), keyPreview(value), plan.id, actorDiscordId || null, timestamp, timestamp);
    keys.push({ id, key: value, keyPreview: keyPreview(value), plan: mapPlan(plan), status: 'active', createdAt: timestamp });
  }

  return keys;
}

export async function generateGeneratorPaymentKey({
  planId,
  paymentReference,
  createdByDiscordId = null
}) {
  const normalizedReference = cleanText(paymentReference);
  if (!normalizedReference) throw new Error('Referencia do pagamento invalida.');
  const plan = await getPlanRow(cleanText(planId));
  if (!plan) throw Object.assign(new Error('Plano vinculado ao pagamento nao encontrado.'), { status: 400 });

  const value = generatePaymentKeyValue(normalizedReference);
  const hashed = hashKey(value);
  const timestamp = nowIso();
  await db.prepare(`
    INSERT INTO generator_keys (
      id, key_hash, key_encrypted, key_preview, plan_id, status,
      redeemed_by, redeemed_at, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)
    ON CONFLICT (key_hash) DO NOTHING
  `).run(
    crypto.randomUUID(),
    hashed,
    encryptSecret(value),
    keyPreview(value),
    plan.id,
    createdByDiscordId || null,
    timestamp,
    timestamp
  );

  const keyRow = await db.prepare(`
    SELECT * FROM generator_keys WHERE key_hash = ?
  `).get(hashed);
  if (!keyRow || keyRow.plan_id !== plan.id) {
    throw new Error('Nao foi possivel vincular a key ao pagamento.');
  }
  return {
    id: keyRow.id,
    key: decryptSecret(keyRow.key_encrypted),
    keyPreview: keyRow.key_preview,
    plan: mapPlan(plan),
    status: keyRow.status,
    createdAt: keyRow.created_at
  };
}

export async function listGeneratorKeys({ limit = 100 } = {}) {
  const normalizedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const rows = await db.prepare(`
    SELECT generator_key.*, plan.name AS plan_name
    FROM generator_keys generator_key
    JOIN generator_plans plan ON plan.id = generator_key.plan_id
    ORDER BY generator_key.created_at DESC
    LIMIT ?
  `).all(normalizedLimit);
  return rows.map((row) => ({
    id: row.id,
    key: decryptSecret(row.key_encrypted),
    keyPreview: row.key_preview,
    planId: row.plan_id,
    planName: row.plan_name,
    status: row.status,
    redeemedBy: row.redeemed_by,
    redeemedAt: row.redeemed_at,
    createdAt: row.created_at
  }));
}

export async function revokeGeneratorKey(keyId) {
  const result = await db.prepare(`
    UPDATE generator_keys
    SET status = 'revoked', updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(nowIso(), keyId);
  if (!Number(result.changes || 0)) {
    throw Object.assign(new Error('Key ativa nao encontrada.'), { status: 404 });
  }
}

export async function redeemGeneratorKey({ discordId, key }) {
  const normalizedDiscordId = cleanText(discordId);
  const normalizedKey = normalizeKey(key);
  if (!/^\d{5,32}$/.test(normalizedDiscordId)) throw new Error('Discord ID invalido.');
  if (normalizedKey.length < 16) throw Object.assign(new Error('Informe uma key valida.'), { status: 400 });

  const keyRow = await db.prepare(`
    SELECT generator_key.*, plan.name, plan.duration_days, plan.generation_limit,
      plan.cooldown_seconds, plan.price_cents, plan.benefits_json, plan.featured,
      plan.vip, plan.active, plan.sort_order
    FROM generator_keys generator_key
    JOIN generator_plans plan ON plan.id = generator_key.plan_id
    WHERE generator_key.key_hash = ?
  `).get(hashKey(normalizedKey));
  if (!keyRow || keyRow.status !== 'active' || Number(keyRow.active || 0) !== 1) {
    throw Object.assign(new Error('Key invalida, ja utilizada ou desativada.'), { status: 400 });
  }

  const timestamp = nowIso();
  const expiresAt = expirationFromPlan(keyRow);
  const claimed = await db.prepare(`
    UPDATE generator_keys
    SET status = 'redeemed', redeemed_by = ?, redeemed_at = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `).run(normalizedDiscordId, timestamp, timestamp, keyRow.id);
  if (!Number(claimed.changes || 0)) {
    throw Object.assign(new Error('Esta key acabou de ser utilizada em outra solicitação.'), { status: 409 });
  }

  try {
    await db.prepare(`
      INSERT INTO generator_subscriptions (
        discord_id, plan_id, status, generations_used, started_at, expires_at,
        key_id, customer_since, created_at, updated_at
      ) VALUES (?, ?, 'active', 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (discord_id) DO UPDATE SET
        plan_id = excluded.plan_id,
        status = 'active',
        generations_used = 0,
        started_at = excluded.started_at,
        expires_at = excluded.expires_at,
        key_id = excluded.key_id,
        updated_at = excluded.updated_at
    `).run(normalizedDiscordId, keyRow.plan_id, timestamp, expiresAt, keyRow.id, timestamp, timestamp, timestamp);
  } catch (error) {
    await db.prepare(`
      UPDATE generator_keys
      SET status = 'active', redeemed_by = NULL, redeemed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'redeemed' AND redeemed_by = ?
    `).run(nowIso(), keyRow.id, normalizedDiscordId).catch(() => {});
    throw error;
  }

  return mapSubscription(await getSubscriptionRow(normalizedDiscordId));
}

export async function getGeneratorAccess(discordId) {
  const authorized = await getAuthorizedUser(discordId);
  if (authorized && hasPermission(authorized, PERMISSIONS.SALES_USE)) {
    const subscription = await expireSubscription(await getSubscriptionRow(discordId));
    return {
      allowed: true,
      source: 'permission',
      subscription: subscription?.status === 'active' ? mapSubscription(subscription) : null,
      policy: null
    };
  }

  const row = await expireSubscription(await getSubscriptionRow(discordId));
  if (!row || row.status !== 'active') {
    return { allowed: false, source: 'none', subscription: row ? mapSubscription(row) : null, policy: null };
  }
  const limit = Math.max(0, Number(row.generation_limit || 0));
  const used = Math.max(0, Number(row.generations_used || 0));
  if (limit > 0 && used >= limit) {
    return { allowed: false, source: 'plan_limit', subscription: mapSubscription(row), policy: null };
  }
  return {
    allowed: true,
    source: 'plan',
    subscription: mapSubscription(row),
    policy: {
      cooldownSeconds: Math.max(0, Number(row.cooldown_seconds || 0)),
      maxDeliveriesPerUser: 0
    }
  };
}

export async function recordGeneratorUse(discordId) {
  await db.prepare(`
    UPDATE generator_subscriptions
    SET generations_used = generations_used + 1, updated_at = ?
    WHERE discord_id = ? AND status = 'active'
  `).run(nowIso(), discordId);
}

export async function getGeneratorProfile(discordId) {
  const [access, stats, lastDelivery] = await Promise.all([
    getGeneratorAccess(discordId),
    db.prepare(`
      SELECT COUNT(*) AS total
      FROM sales_deliveries
      WHERE buyer_discord_id = ? AND status = 'delivered'
    `).get(discordId),
    db.prepare(`
      SELECT id, delivered_at, created_at
      FROM sales_deliveries
      WHERE buyer_discord_id = ? AND status = 'delivered'
      ORDER BY COALESCE(delivered_at, created_at) DESC
      LIMIT 1
    `).get(discordId)
  ]);
  return {
    ...access,
    totalGenerated: Number(stats?.total || 0),
    lastGenerationAt: lastDelivery?.delivered_at || lastDelivery?.created_at || null
  };
}

export async function getGeneratorHistory(discordId, limit = 10) {
  const rows = await db.prepare(`
    SELECT delivery.id, delivery.status, delivery.created_at, delivery.delivered_at,
      account.username
    FROM sales_deliveries delivery
    JOIN roblox_generator_accounts account ON account.id = delivery.account_id
    WHERE delivery.buyer_discord_id = ?
    ORDER BY COALESCE(delivery.delivered_at, delivery.created_at) DESC
    LIMIT ?
  `).all(discordId, Math.min(25, Math.max(1, Number(limit) || 10)));
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  }));
}

export async function getGeneratorDeliveryForBuyer(deliveryId, buyerDiscordId) {
  const row = await db.prepare(`
    SELECT delivery.*, account.username, account.password_encrypted
    FROM sales_deliveries delivery
    JOIN roblox_generator_accounts account ON account.id = delivery.account_id
    WHERE delivery.id = ? AND delivery.buyer_discord_id = ? AND delivery.status = 'delivered'
  `).get(deliveryId, buyerDiscordId);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    password: decryptSecret(row.password_encrypted),
    deliveredAt: row.delivered_at || row.created_at
  };
}

export async function getGeneratorCommerceManagement() {
  const [plans, keys, subscriptions] = await Promise.all([
    listGeneratorPlans(),
    listGeneratorKeys({ limit: 120 }),
    db.prepare(`
      SELECT subscription.*, plan.name AS plan_name
      FROM generator_subscriptions subscription
      JOIN generator_plans plan ON plan.id = subscription.plan_id
      ORDER BY subscription.updated_at DESC
      LIMIT 200
    `).all()
  ]);
  return {
    plans,
    keys,
    subscriptions: subscriptions.map((row) => ({
      discordId: row.discord_id,
      planId: row.plan_id,
      planName: row.plan_name,
      status: row.status,
      generationsUsed: Number(row.generations_used || 0),
      expiresAt: row.expires_at,
      updatedAt: row.updated_at
    }))
  };
}

export const generatorCommerceSchemas = {
  plan: planSchema,
  planUpdate: planUpdateSchema,
  keyBatch: keyBatchSchema
};
