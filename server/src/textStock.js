import crypto from 'node:crypto';
import { db, nowIso } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const MAX_PRODUCT_NAME_LENGTH = 160;
const MAX_PRODUCT_SLUG_LENGTH = 120;
const MAX_PAYMENT_REFERENCE_LENGTH = 200;
const MAX_PARAGRAPH_LENGTH = 32_000;
const DEFAULT_DM_PAGE_LENGTH = 1_850;
const MAX_DM_PAGE_LENGTH = 1_900;
const DEFAULT_DELIVERY_LEASE_TTL_MS = 5 * 60_000;
const MIN_DELIVERY_LEASE_TTL_MS = 10_000;
const MAX_DELIVERY_LEASE_TTL_MS = 30 * 60_000;

function makeError(message, status = 400, code = 'TEXT_STOCK_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanText(value, max = 1_000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw makeError(`${field} invalido.`, 400, 'TEXT_STOCK_INVALID_INPUT');
  }
  return number;
}

function normalizeOptionalInteger(value, field, options) {
  if (value == null || value === '') return null;
  return normalizeInteger(value, field, options);
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseIdArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function slugify(value) {
  return cleanText(value, MAX_PRODUCT_NAME_LENGTH)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PRODUCT_SLUG_LENGTH);
}

function normalizeSlug(value, fallbackName = '') {
  const slug = slugify(value || fallbackName);
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug)) {
    throw makeError('Slug do produto invalido.', 400, 'TEXT_STOCK_INVALID_SLUG');
  }
  return slug;
}

function normalizeProductId(value) {
  const id = cleanText(value, 160);
  if (!id) throw makeError('Produto de texto invalido.', 400, 'TEXT_STOCK_INVALID_PRODUCT');
  return id;
}

function normalizePaymentReference(value) {
  const reference = cleanText(value, MAX_PAYMENT_REFERENCE_LENGTH);
  if (!reference) throw makeError('Referencia de pagamento invalida.', 400, 'TEXT_STOCK_INVALID_PAYMENT_REFERENCE');
  return reference;
}

function normalizeBuyerDiscordId(value) {
  const buyerDiscordId = cleanText(value, 80);
  if (!buyerDiscordId) throw makeError('Comprador do Discord invalido.', 400, 'TEXT_STOCK_INVALID_BUYER');
  return buyerDiscordId;
}

function normalizeDeliveryLeaseToken(value, { required = true } = {}) {
  const token = cleanText(value, 200);
  if (token) return token;
  if (!required) return null;
  throw makeError('Token de lease da entrega invalido.', 400, 'TEXT_STOCK_INVALID_LEASE_TOKEN');
}

function normalizeDeliveryLeaseTtl(value) {
  return normalizeInteger(value ?? DEFAULT_DELIVERY_LEASE_TTL_MS, 'Duracao do lease', {
    min: MIN_DELIVERY_LEASE_TTL_MS,
    max: MAX_DELIVERY_LEASE_TTL_MS
  });
}

function leaseExpirationFromNow(ttlMs) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function activeLease(row, atMs = Date.now()) {
  const token = cleanText(row?.delivery_lease_token, 200);
  const expiresAt = Date.parse(row?.delivery_lease_expires_at || '');
  return Boolean(token && Number.isFinite(expiresAt) && expiresAt > atMs);
}

function assertDeliveryLeaseOwner(row, leaseToken, { allowExpired = false } = {}) {
  const token = normalizeDeliveryLeaseToken(leaseToken);
  if (!row?.delivery_lease_token || row.delivery_lease_token !== token) {
    throw makeError('Esta entrega esta sendo processada por outra tentativa.', 409, 'TEXT_STOCK_LEASE_NOT_OWNER');
  }
  if (!allowExpired && !activeLease(row)) {
    throw makeError('O lease desta entrega expirou.', 409, 'TEXT_STOCK_LEASE_EXPIRED');
  }
  return token;
}

function mapProduct(row) {
  if (!row) return null;
  const itemsPerPurchase = Number(row.items_per_purchase || 1);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description || null,
    priceCents: Number(row.price_cents || 0),
    itemsPerPurchase,
    // Alias kept intentionally: integrations that call the product quantity
    // "units" do not need to know the storage column name.
    unitsPerPurchase: itemsPerPurchase,
    active: Number(row.active) === 1,
    metadata: parseJson(row.metadata_json),
    createdByDiscordId: row.created_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableCount: Number(row.available_count || 0),
    reservedCount: Number(row.reserved_count || 0),
    deliveredCount: Number(row.delivered_count || 0),
    queuedPurchaseCount: Number(row.queued_purchase_count || 0)
  };
}

function mapDeliveryItem(row, { includeContents = false } = {}) {
  return {
    id: row.stock_item_id || row.id,
    queuePosition: Number(row.queue_position),
    position: Number(row.item_position),
    status: row.delivery_item_status || row.status,
    content: includeContents ? decryptSecret(row.content_encrypted) : undefined,
    deliveredAt: row.item_delivered_at || row.delivered_at || null
  };
}

function mapDeliveryPage(row, { includeContents = false } = {}) {
  return {
    id: row.id,
    position: Number(row.page_position),
    itemIds: parseIdArray(row.item_ids_json),
    content: includeContents ? decryptSecret(row.content_encrypted) : undefined,
    discordMessageId: row.discord_message_id || null,
    sentAt: row.sent_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDelivery(row, { items = [], pages = [] } = {}) {
  if (!row) return null;
  const product = row.product_id ? {
    id: row.product_id,
    slug: row.product_slug || null,
    name: row.product_name || null,
    priceCents: row.product_price_cents == null ? null : Number(row.product_price_cents),
    itemsPerPurchase: row.product_items_per_purchase == null ? null : Number(row.product_items_per_purchase)
  } : null;
  return {
    id: row.id,
    paymentReference: row.payment_reference,
    paymentProvider: row.payment_provider || null,
    productId: row.product_id,
    productName: row.product_name || null,
    productSlug: row.product_slug || null,
    product,
    buyerDiscordId: row.buyer_discord_id,
    quantity: Number(row.quantity),
    queuePosition: Number(row.queue_position),
    status: row.status,
    reservedAt: row.reserved_at || null,
    deliveredAt: row.delivered_at || null,
    leaseExpiresAt: row.delivery_lease_expires_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    pages
  };
}

function isUniqueConstraint(error) {
  return error?.code === '23505'
    || /unique constraint|duplicate key/i.test(String(error?.message || ''));
}

async function withTextStockTransaction(handler) {
  return db.transaction(handler);
}

async function getProductRow(store, idOrSlug, { lock = false } = {}) {
  let sql = `
    SELECT product.*,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'available') AS available_count,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'reserved') AS reserved_count,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'delivered') AS delivered_count,
      (SELECT COUNT(*) FROM text_stock_deliveries delivery
        WHERE delivery.product_id = product.id AND delivery.status = 'queued') AS queued_purchase_count
    FROM text_stock_products product
    WHERE product.id = ? OR LOWER(product.slug) = LOWER(?)
  `;
  if (lock && db.type === 'postgres') sql += ' FOR UPDATE';
  return store.prepare(sql).get(idOrSlug, idOrSlug);
}

async function getProductByIdForUpdate(store, productId) {
  let sql = 'SELECT * FROM text_stock_products WHERE id = ?';
  if (db.type === 'postgres') sql += ' FOR UPDATE';
  return store.prepare(sql).get(productId);
}

async function getDeliveryRowByReference(store, paymentReference, { lock = false } = {}) {
  let sql = 'SELECT * FROM text_stock_deliveries WHERE payment_reference = ?';
  if (lock && db.type === 'postgres') sql += ' FOR UPDATE';
  return store.prepare(sql).get(paymentReference);
}

// Every operation that needs both rows takes the product lock first and the
// delivery lock second.  Reserve/append already use that order; keeping it
// here as well prevents PostgreSQL lock cycles during a slow DM retry.
async function lockDeliveryWithProduct(store, paymentReference) {
  const observed = await getDeliveryRowByReference(store, paymentReference);
  if (!observed) return null;

  const product = await getProductByIdForUpdate(store, observed.product_id);
  if (!product) {
    throw makeError('Produto vinculado a entrega nao encontrado.', 409, 'TEXT_STOCK_DELIVERY_PRODUCT_MISSING');
  }
  const delivery = await getDeliveryRowByReference(store, paymentReference, { lock: true });
  if (!delivery) return null;
  if (delivery.product_id !== product.id) {
    // product_id is immutable through this service.  Failing closed is safer
    // than continuing with locks from two different product queues.
    throw makeError('A entrega mudou de produto durante o processamento.', 409, 'TEXT_STOCK_DELIVERY_PRODUCT_CHANGED');
  }
  return { product, delivery };
}

async function loadDelivery(store, paymentReference, {
  includeContents = true,
  includePages = true
} = {}) {
  const row = await store.prepare(`
    SELECT delivery.*, product.slug AS product_slug, product.name AS product_name,
      product.price_cents AS product_price_cents,
      product.items_per_purchase AS product_items_per_purchase
    FROM text_stock_deliveries delivery
    JOIN text_stock_products product ON product.id = delivery.product_id
    WHERE delivery.payment_reference = ?
  `).get(paymentReference);
  if (!row) return null;

  const itemRows = await store.prepare(`
    SELECT delivery_item.stock_item_id, delivery_item.item_position,
      delivery_item.status AS delivery_item_status,
      delivery_item.delivered_at AS item_delivered_at,
      stock_item.queue_position, stock_item.content_encrypted
    FROM text_stock_delivery_items delivery_item
    JOIN text_stock_items stock_item ON stock_item.id = delivery_item.stock_item_id
    WHERE delivery_item.delivery_id = ?
    ORDER BY delivery_item.item_position ASC
  `).all(row.id);
  const pageRows = includePages ? await store.prepare(`
    SELECT * FROM text_stock_delivery_pages
    WHERE delivery_id = ?
    ORDER BY page_position ASC
  `).all(row.id) : [];

  return mapDelivery(row, {
    items: itemRows.map((item) => mapDeliveryItem(item, { includeContents })),
    pages: pageRows.map((page) => mapDeliveryPage(page, { includeContents }))
  });
}

async function reserveQueuedDeliveries(store, productId) {
  let deliveriesSql = `
    SELECT * FROM text_stock_deliveries
    WHERE product_id = ? AND status = 'queued'
    ORDER BY queue_position ASC
  `;
  if (db.type === 'postgres') deliveriesSql += ' FOR UPDATE';
  const queuedDeliveries = await store.prepare(deliveriesSql).all(productId);
  const reservedDeliveryIds = [];

  for (const delivery of queuedDeliveries) {
    let itemsSql = `
      SELECT id, queue_position
      FROM text_stock_items
      WHERE product_id = ? AND status = 'available'
      ORDER BY queue_position ASC
      LIMIT ?
    `;
    if (db.type === 'postgres') itemsSql += ' FOR UPDATE';
    const availableItems = await store.prepare(itemsSql).all(productId, Number(delivery.quantity));

    // Stop at the first paid purchase that cannot be fulfilled in full.  A
    // later one never gets to steal its smaller leftover.
    if (availableItems.length < Number(delivery.quantity)) break;

    const timestamp = nowIso();
    for (const [index, item] of availableItems.entries()) {
      const claimed = await store.prepare(`
        UPDATE text_stock_items
        SET status = 'reserved', reserved_delivery_id = ?, reserved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'available'
      `).run(delivery.id, timestamp, timestamp, item.id);
      if (!Number(claimed.changes || 0)) {
        throw makeError('O item de stock foi reservado em outra compra.', 409, 'TEXT_STOCK_RESERVATION_RACE');
      }
      await store.prepare(`
        INSERT INTO text_stock_delivery_items (
          delivery_id, stock_item_id, item_position, status, created_at
        ) VALUES (?, ?, ?, 'reserved', ?)
        ON CONFLICT (delivery_id, stock_item_id) DO NOTHING
      `).run(delivery.id, item.id, index + 1, timestamp);
    }

    await store.prepare(`
      UPDATE text_stock_deliveries
      SET status = 'reserved', reserved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(timestamp, timestamp, delivery.id);
    reservedDeliveryIds.push(delivery.id);
  }

  return reservedDeliveryIds;
}

function assertSameReservation(existing, {
  productId,
  buyerDiscordId,
  quantity
}) {
  if (
    existing.product_id !== productId
    || existing.buyer_discord_id !== buyerDiscordId
    || Number(existing.quantity) !== Number(quantity)
  ) {
    throw makeError(
      'A referencia de pagamento ja pertence a outra compra de stock.',
      409,
      'TEXT_STOCK_PAYMENT_REFERENCE_REUSED'
    );
  }
}

function reservationResult(delivery) {
  return {
    status: delivery.status,
    queuePosition: delivery.queuePosition,
    delivery
  };
}

function splitParagraphText(input) {
  if (Array.isArray(input)) {
    return input
      .map((item) => String(item ?? '').replace(/\r\n?/g, '\n').trim())
      .filter(Boolean);
  }

  const normalized = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized
    .split(/\n[\t ]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

export function parseTextStockParagraphs(input) {
  const paragraphs = splitParagraphText(input);
  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_PARAGRAPH_LENGTH) {
      throw makeError('Um item de texto excede o tamanho maximo permitido.', 400, 'TEXT_STOCK_ITEM_TOO_LARGE');
    }
  }
  return paragraphs;
}

export async function createTextProduct(input = {}) {
  const name = cleanText(input.name, MAX_PRODUCT_NAME_LENGTH);
  if (!name) throw makeError('Nome do produto e obrigatorio.', 400, 'TEXT_STOCK_INVALID_NAME');

  const id = cleanText(input.id, 160) || crypto.randomUUID();
  const slug = normalizeSlug(input.slug, name);
  const priceCents = normalizeInteger(input.priceCents ?? input.price_cents ?? 0, 'Preco', {
    min: 0,
    max: 1_000_000_000
  });
  const itemsPerPurchase = normalizeInteger(
    input.itemsPerPurchase ?? input.unitsPerPurchase ?? input.items_per_purchase ?? 1,
    'Quantidade por compra',
    { min: 1, max: 10_000 }
  );
  const active = input.active == null ? 1 : input.active ? 1 : 0;
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};
  const timestamp = nowIso();

  try {
    await db.prepare(`
      INSERT INTO text_stock_products (
        id, slug, name, description, price_cents, items_per_purchase, active,
        metadata_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      slug,
      name,
      cleanText(input.description, 2_000) || null,
      priceCents,
      itemsPerPurchase,
      active,
      JSON.stringify(metadata),
      cleanText(input.createdByDiscordId, 80) || null,
      timestamp,
      timestamp
    );
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw makeError('Ja existe um produto de texto com esse slug ou ID.', 409, 'TEXT_STOCK_PRODUCT_EXISTS');
    }
    throw error;
  }

  return findTextProduct(id);
}

export async function listTextProducts({ activeOnly = false, limit = 100 } = {}) {
  const normalizedLimit = normalizeInteger(limit, 'Limite', { min: 1, max: 500 });
  const activeClause = activeOnly ? 'WHERE product.active = 1' : '';
  const rows = await db.prepare(`
    SELECT product.*,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'available') AS available_count,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'reserved') AS reserved_count,
      (SELECT COUNT(*) FROM text_stock_items item
        WHERE item.product_id = product.id AND item.status = 'delivered') AS delivered_count,
      (SELECT COUNT(*) FROM text_stock_deliveries delivery
        WHERE delivery.product_id = product.id AND delivery.status = 'queued') AS queued_purchase_count
    FROM text_stock_products product
    ${activeClause}
    ORDER BY LOWER(product.name) ASC, product.created_at ASC
    LIMIT ?
  `).all(normalizedLimit);
  return rows.map(mapProduct);
}

export async function findTextProduct(idOrSlug) {
  const value = cleanText(idOrSlug, 160);
  if (!value) return null;
  return mapProduct(await getProductRow(db, value));
}

export async function appendTextStockParagraphs(productId, input, options = {}) {
  const normalizedProductId = normalizeProductId(productId);
  const paragraphs = parseTextStockParagraphs(input);
  if (!paragraphs.length) {
    throw makeError('Informe pelo menos um paragrafo para o stock.', 400, 'TEXT_STOCK_EMPTY_IMPORT');
  }
  const encryptedParagraphs = paragraphs.map((paragraph) => encryptSecret(paragraph));
  const importedBy = cleanText(options.actorDiscordId ?? options.importedByDiscordId, 80) || null;

  return withTextStockTransaction(async (tx) => {
    const product = await getProductByIdForUpdate(tx, normalizedProductId);
    if (!product) throw makeError('Produto de texto nao encontrado.', 404, 'TEXT_STOCK_PRODUCT_NOT_FOUND');

    const highest = await tx.prepare(`
      SELECT COALESCE(MAX(queue_position), 0) AS queue_position
      FROM text_stock_items
      WHERE product_id = ?
    `).get(product.id);
    const firstQueuePosition = Number(highest?.queue_position || 0) + 1;
    const timestamp = nowIso();

    for (const [index, contentEncrypted] of encryptedParagraphs.entries()) {
      await tx.prepare(`
        INSERT INTO text_stock_items (
          id, product_id, queue_position, content_encrypted, status,
          imported_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        product.id,
        firstQueuePosition + index,
        contentEncrypted,
        importedBy,
        timestamp,
        timestamp
      );
    }
    await tx.prepare(`
      UPDATE text_stock_products SET updated_at = ? WHERE id = ?
    `).run(timestamp, product.id);

    const newlyReservedDeliveryIds = await reserveQueuedDeliveries(tx, product.id);
    return {
      count: paragraphs.length,
      firstQueuePosition,
      lastQueuePosition: firstQueuePosition + paragraphs.length - 1,
      newlyReservedDeliveryIds
    };
  });
}

export async function reserveTextStock({
  paymentReference,
  productId,
  buyerDiscordId,
  quantity = null,
  paymentProvider = null
} = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const normalizedProductId = normalizeProductId(productId);
  const normalizedBuyerDiscordId = normalizeBuyerDiscordId(buyerDiscordId);
  const requestedQuantity = normalizeOptionalInteger(quantity, 'Quantidade', { min: 1, max: 10_000 });
  const normalizedPaymentProvider = cleanText(paymentProvider, 80) || null;

  const reserve = async (tx) => {
    // A retry first identifies its delivery without a row lock, then locks the
    // owning product before the delivery.  This matches every other flow that
    // touches both rows and keeps PostgreSQL out of a product/delivery cycle.
    let existingLock = await lockDeliveryWithProduct(tx, reference);
    if (existingLock) {
      const existing = existingLock.delivery;
      const existingQuantity = requestedQuantity ?? Number(existing.quantity);
      assertSameReservation(existing, {
        productId: normalizedProductId,
        buyerDiscordId: normalizedBuyerDiscordId,
        quantity: existingQuantity
      });
      if (existing.status === 'queued') await reserveQueuedDeliveries(tx, existingLock.product.id);
      return reservationResult(await loadDelivery(tx, reference));
    }

    const product = await getProductByIdForUpdate(tx, normalizedProductId);
    if (!product) throw makeError('Produto de texto nao encontrado.', 404, 'TEXT_STOCK_PRODUCT_NOT_FOUND');

    // Another transaction for the same product may have committed while this
    // one waited on PostgreSQL's row lock.
    const existing = await getDeliveryRowByReference(tx, reference, { lock: true });
    const normalizedQuantity = requestedQuantity ?? Number(product.items_per_purchase);
    if (existing) {
      assertSameReservation(existing, {
        productId: product.id,
        buyerDiscordId: normalizedBuyerDiscordId,
        quantity: requestedQuantity ?? Number(existing.quantity)
      });
      if (existing.status === 'queued') await reserveQueuedDeliveries(tx, product.id);
      return reservationResult(await loadDelivery(tx, reference));
    }

    const positionRow = await tx.prepare(`
      SELECT COALESCE(MAX(queue_position), 0) AS queue_position
      FROM text_stock_deliveries
      WHERE product_id = ?
    `).get(product.id);
    const timestamp = nowIso();
    await tx.prepare(`
      INSERT INTO text_stock_deliveries (
        id, payment_reference, payment_provider, product_id, buyer_discord_id,
        quantity, queue_position, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
    `).run(
      crypto.randomUUID(),
      reference,
      normalizedPaymentProvider,
      product.id,
      normalizedBuyerDiscordId,
      normalizedQuantity,
      Number(positionRow?.queue_position || 0) + 1,
      timestamp,
      timestamp
    );
    await reserveQueuedDeliveries(tx, product.id);
    return reservationResult(await loadDelivery(tx, reference));
  };

  try {
    return await withTextStockTransaction(reserve);
  } catch (error) {
    // A duplicate reference can race through different product locks on
    // PostgreSQL.  The unique payment_reference index decides the winner; the
    // losing retry then returns the same delivery instead of failing it.
    if (!isUniqueConstraint(error)) throw error;
    const existing = await getTextStockDeliveryByPaymentReference(reference);
    if (!existing) throw error;
    const fallbackQuantity = requestedQuantity ?? existing.quantity;
    assertSameReservation({
      product_id: existing.productId,
      buyer_discord_id: existing.buyerDiscordId,
      quantity: existing.quantity
    }, {
      productId: normalizedProductId,
      buyerDiscordId: normalizedBuyerDiscordId,
      quantity: fallbackQuantity
    });
    return reservationResult(existing);
  }
}

export async function getTextStockDeliveryByPaymentReference(paymentReference, options = {}) {
  const reference = normalizePaymentReference(paymentReference);
  return loadDelivery(db, reference, {
    includeContents: options.includeContents !== false,
    includePages: options.includePages !== false
  });
}

function leaseResponse({
  claimed = false,
  renewed = false,
  released = false,
  reason = null,
  leaseToken = null,
  leaseExpiresAt = null,
  delivery = null
} = {}) {
  return {
    claimed,
    renewed,
    released,
    reason,
    leaseToken,
    leaseExpiresAt,
    delivery
  };
}

export async function claimTextStockDeliveryLease({
  paymentReference,
  leaseToken = null,
  ttlMs = DEFAULT_DELIVERY_LEASE_TTL_MS
} = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const token = normalizeDeliveryLeaseToken(leaseToken, { required: false }) || crypto.randomUUID();
  const ttl = normalizeDeliveryLeaseTtl(ttlMs);

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    const { delivery } = locked;
    const mappedDelivery = await loadDelivery(tx, reference, { includeContents: false });
    if (delivery.status === 'delivered') {
      return leaseResponse({ reason: 'delivered', delivery: mappedDelivery });
    }
    if (delivery.status !== 'reserved') {
      return leaseResponse({ reason: 'queued', delivery: mappedDelivery });
    }
    if (activeLease(delivery) && delivery.delivery_lease_token !== token) {
      return leaseResponse({
        reason: 'active_lease',
        leaseExpiresAt: delivery.delivery_lease_expires_at,
        delivery: mappedDelivery
      });
    }

    const timestamp = nowIso();
    const leaseExpiresAt = leaseExpirationFromNow(ttl);
    await tx.prepare(`
      UPDATE text_stock_deliveries
      SET delivery_lease_token = ?,
          delivery_lease_acquired_at = ?,
          delivery_lease_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(token, timestamp, leaseExpiresAt, timestamp, delivery.id);
    return leaseResponse({
      claimed: true,
      leaseToken: token,
      leaseExpiresAt,
      delivery: await loadDelivery(tx, reference, { includeContents: false })
    });
  });
}

export async function renewTextStockDeliveryLease({
  paymentReference,
  leaseToken,
  ttlMs = DEFAULT_DELIVERY_LEASE_TTL_MS
} = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const token = normalizeDeliveryLeaseToken(leaseToken);
  const ttl = normalizeDeliveryLeaseTtl(ttlMs);

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    const { delivery } = locked;
    if (delivery.status === 'delivered') return leaseResponse({ renewed: false, reason: 'delivered' });
    if (delivery.delivery_lease_token !== token) return leaseResponse({ renewed: false, reason: 'not_owner' });
    if (!activeLease(delivery)) return leaseResponse({ renewed: false, reason: 'expired' });

    const timestamp = nowIso();
    const leaseExpiresAt = leaseExpirationFromNow(ttl);
    await tx.prepare(`
      UPDATE text_stock_deliveries
      SET delivery_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND delivery_lease_token = ?
    `).run(leaseExpiresAt, timestamp, delivery.id, token);
    return leaseResponse({ renewed: true, leaseToken: token, leaseExpiresAt });
  });
}

export async function releaseTextStockDeliveryLease({
  paymentReference,
  leaseToken
} = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const token = normalizeDeliveryLeaseToken(leaseToken);

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    const { delivery } = locked;
    if (delivery.delivery_lease_token !== token) return leaseResponse({ released: false, reason: 'not_owner' });

    const timestamp = nowIso();
    await tx.prepare(`
      UPDATE text_stock_deliveries
      SET delivery_lease_token = NULL,
          delivery_lease_acquired_at = NULL,
          delivery_lease_expires_at = NULL,
          updated_at = ?
      WHERE id = ? AND delivery_lease_token = ?
    `).run(timestamp, delivery.id, token);
    return leaseResponse({ released: true });
  });
}

function splitForDiscord(text, maximum) {
  const parts = [];
  let remaining = String(text || '');
  while (remaining.length > maximum) {
    let cutoff = remaining.lastIndexOf('\n', maximum);
    if (cutoff < Math.floor(maximum * 0.55)) cutoff = remaining.lastIndexOf(' ', maximum);
    if (cutoff < Math.floor(maximum * 0.55)) cutoff = maximum;
    parts.push(remaining.slice(0, cutoff).trimEnd());
    remaining = remaining.slice(cutoff).trimStart();
  }
  if (remaining || parts.length === 0) parts.push(remaining);
  return parts;
}

function makeDmPagePayloads(items, maximum) {
  const sections = [];
  const total = items.length;
  for (const item of items) {
    const basePrefix = `**Item ${item.position} de ${total}**\n`;
    const fullSection = `${basePrefix}${item.content}`;
    if (fullSection.length <= maximum) {
      sections.push({ itemId: item.id, content: fullSection });
      continue;
    }

    const fragmentLimit = Math.max(40, maximum - 80);
    const fragments = splitForDiscord(item.content, fragmentLimit);
    for (const [index, fragment] of fragments.entries()) {
      const prefix = `**Item ${item.position} de ${total} (parte ${index + 1}/${fragments.length})**\n`;
      sections.push({ itemId: item.id, content: `${prefix}${fragment}` });
    }
  }

  const pages = [];
  let current = null;
  for (const section of sections) {
    const separator = current ? '\n\n' : '';
    if (current && current.content.length + separator.length + section.content.length > maximum) {
      pages.push(current);
      current = null;
    }
    if (!current) current = { content: section.content, itemIds: [section.itemId] };
    else {
      current.content += `${separator}${section.content}`;
      if (!current.itemIds.includes(section.itemId)) current.itemIds.push(section.itemId);
    }
  }
  if (current) pages.push(current);
  return pages;
}

async function loadDeliveryPages(store, deliveryId) {
  return store.prepare(`
    SELECT * FROM text_stock_delivery_pages
    WHERE delivery_id = ?
    ORDER BY page_position ASC
  `).all(deliveryId);
}

async function ensureDeliveryPages(store, paymentReference, maximum) {
  const delivery = await loadDelivery(store, paymentReference, {
    includeContents: true,
    includePages: false
  });
  if (!delivery) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
  const existing = await loadDeliveryPages(store, delivery.id);
  if (existing.length || delivery.status === 'queued') return { delivery, pages: existing };
  if (!delivery.items.length) {
    throw makeError('A entrega reservada nao possui itens de stock.', 409, 'TEXT_STOCK_DELIVERY_ITEMS_MISSING');
  }

  const payloads = makeDmPagePayloads(delivery.items, maximum);
  const timestamp = nowIso();
  for (const [index, page] of payloads.entries()) {
    await store.prepare(`
      INSERT INTO text_stock_delivery_pages (
        id, delivery_id, page_position, item_ids_json, content_encrypted,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (delivery_id, page_position) DO NOTHING
    `).run(
      crypto.randomUUID(),
      delivery.id,
      index + 1,
      JSON.stringify(page.itemIds),
      encryptSecret(page.content),
      timestamp,
      timestamp
    );
  }
  return { delivery, pages: await loadDeliveryPages(store, delivery.id) };
}

export async function buildTextStockDmPages(deliveryOrReference, options = {}) {
  const reference = normalizePaymentReference(
    typeof deliveryOrReference === 'object'
      ? deliveryOrReference?.paymentReference
      : deliveryOrReference
  );
  const maximum = normalizeInteger(options.maxCharacters ?? DEFAULT_DM_PAGE_LENGTH, 'Tamanho da pagina', {
    min: 200,
    max: MAX_DM_PAGE_LENGTH
  });
  const includeSent = options.includeSent === true;
  const leaseToken = normalizeDeliveryLeaseToken(options.leaseToken);

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    assertDeliveryLeaseOwner(locked.delivery, leaseToken);
    const { pages } = await ensureDeliveryPages(tx, reference, maximum);
    return pages
      .map((page) => mapDeliveryPage(page, { includeContents: true }))
      .filter((page) => includeSent || !page.discordMessageId);
  });
}

function sameIds(left, right) {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const actual = [...right].sort();
  return expected.every((value, index) => value === actual[index]);
}

export async function recordTextStockDeliveryMessage({
  paymentReference,
  pageId = null,
  pagePosition = null,
  itemId = null,
  itemIds = null,
  discordMessageId = null,
  messageId = null,
  leaseToken = null
} = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const normalizedLeaseToken = normalizeDeliveryLeaseToken(leaseToken);
  const normalizedMessageId = cleanText(discordMessageId ?? messageId, 100);
  if (!normalizedMessageId) {
    throw makeError('ID da mensagem privada invalido.', 400, 'TEXT_STOCK_INVALID_DISCORD_MESSAGE');
  }
  const normalizedPageId = cleanText(pageId, 100) || null;
  const normalizedPagePosition = normalizeOptionalInteger(pagePosition, 'Posicao da pagina', { min: 1, max: 10_000 });
  const requestedItemIds = Array.isArray(itemIds)
    ? itemIds.map((value) => cleanText(value, 100)).filter(Boolean)
    : cleanText(itemId, 100) ? [cleanText(itemId, 100)] : [];

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    // A send may complete a few milliseconds after a lease expiry.  If nobody
    // else claimed it meanwhile, recording that already-sent page is safe and
    // prevents the next owner from duplicating it.
    assertDeliveryLeaseOwner(locked.delivery, normalizedLeaseToken, { allowExpired: true });
    const { pages } = await ensureDeliveryPages(tx, reference, DEFAULT_DM_PAGE_LENGTH);
    let target = null;
    if (normalizedPageId) {
      target = pages.find((page) => page.id === normalizedPageId) || null;
    } else if (normalizedPagePosition != null) {
      target = pages.find((page) => Number(page.page_position) === normalizedPagePosition) || null;
    } else if (requestedItemIds.length) {
      const matches = pages.filter((page) => sameIds(parseIdArray(page.item_ids_json), requestedItemIds));
      if (matches.length === 1) target = matches[0];
      if (matches.length > 1) {
        throw makeError('Esse item ocupa mais de uma pagina; informe o pageId.', 400, 'TEXT_STOCK_PAGE_ID_REQUIRED');
      }
    }
    if (!target) {
      throw makeError('Pagina de entrega nao encontrada.', 404, 'TEXT_STOCK_PAGE_NOT_FOUND');
    }
    if (target.discord_message_id && target.discord_message_id !== normalizedMessageId) {
      throw makeError('Essa pagina ja foi registrada com outra mensagem do Discord.', 409, 'TEXT_STOCK_PAGE_ALREADY_SENT');
    }

    const timestamp = nowIso();
    if (!target.discord_message_id) {
      await tx.prepare(`
        UPDATE text_stock_delivery_pages
        SET discord_message_id = ?, sent_at = ?, updated_at = ?
        WHERE id = ? AND delivery_id = ? AND discord_message_id IS NULL
      `).run(normalizedMessageId, timestamp, timestamp, target.id, locked.delivery.id);
      await tx.prepare(`
        UPDATE text_stock_deliveries SET updated_at = ? WHERE id = ?
      `).run(timestamp, locked.delivery.id);
    }

    const updatedPages = await loadDeliveryPages(tx, locked.delivery.id);
    const updated = updatedPages.find((page) => page.id === target.id);
    return {
      delivery: await loadDelivery(tx, reference),
      page: mapDeliveryPage(updated, { includeContents: true })
    };
  });
}

export async function completeTextStockDelivery(paymentReference, { leaseToken = null } = {}) {
  const reference = normalizePaymentReference(paymentReference);
  const normalizedLeaseToken = normalizeDeliveryLeaseToken(leaseToken);

  return withTextStockTransaction(async (tx) => {
    const locked = await lockDeliveryWithProduct(tx, reference);
    if (!locked) throw makeError('Entrega de stock nao encontrada.', 404, 'TEXT_STOCK_DELIVERY_NOT_FOUND');
    if (locked.delivery.status === 'delivered') return loadDelivery(tx, reference);
    assertDeliveryLeaseOwner(locked.delivery, normalizedLeaseToken, { allowExpired: true });
    if (locked.delivery.status !== 'reserved') {
      throw makeError('A entrega ainda esta aguardando stock.', 409, 'TEXT_STOCK_DELIVERY_NOT_RESERVED');
    }

    const { pages } = await ensureDeliveryPages(tx, reference, DEFAULT_DM_PAGE_LENGTH);
    if (!pages.length || pages.some((page) => !page.discord_message_id)) {
      throw makeError('Ainda existem paginas de DM sem confirmacao.', 409, 'TEXT_STOCK_DELIVERY_PAGES_PENDING');
    }

    const timestamp = nowIso();
    await tx.prepare(`
      UPDATE text_stock_delivery_items
      SET status = 'delivered', delivered_at = ?
      WHERE delivery_id = ? AND status = 'reserved'
    `).run(timestamp, locked.delivery.id);
    await tx.prepare(`
      UPDATE text_stock_items
      SET status = 'delivered', delivered_at = ?, updated_at = ?
      WHERE reserved_delivery_id = ? AND status = 'reserved'
    `).run(timestamp, timestamp, locked.delivery.id);
    await tx.prepare(`
      UPDATE text_stock_deliveries
      SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, ?),
          delivery_lease_token = NULL,
          delivery_lease_acquired_at = NULL,
          delivery_lease_expires_at = NULL,
          updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(timestamp, timestamp, locked.delivery.id);
    return loadDelivery(tx, reference);
  });
}

export async function listTextStockDeliveries({
  productId = null,
  buyerDiscordId = null,
  statuses = null,
  limit = 100,
  includeContents = false
} = {}) {
  const normalizedLimit = normalizeInteger(limit, 'Limite', { min: 1, max: 500 });
  const product = cleanText(productId, 160) || null;
  const buyer = cleanText(buyerDiscordId, 80) || null;
  const allowedStatuses = new Set(['queued', 'reserved', 'delivered']);
  const requestedStatuses = Array.isArray(statuses)
    ? statuses.map((status) => cleanText(status, 20)).filter(Boolean)
    : cleanText(statuses, 20) ? [cleanText(statuses, 20)] : [];
  if (requestedStatuses.some((status) => !allowedStatuses.has(status))) {
    throw makeError('Status de entrega invalido.', 400, 'TEXT_STOCK_INVALID_DELIVERY_STATUS');
  }

  const conditions = ['1 = 1'];
  const params = [];
  if (product) {
    conditions.push('product_id = ?');
    params.push(product);
  }
  if (buyer) {
    conditions.push('buyer_discord_id = ?');
    params.push(buyer);
  }
  if (requestedStatuses.length) {
    conditions.push(`status IN (${requestedStatuses.map(() => '?').join(', ')})`);
    params.push(...requestedStatuses);
  }
  let sql = `
    SELECT payment_reference FROM text_stock_deliveries
    WHERE ${conditions.join(' AND ')}
  `;
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(normalizedLimit);
  const rows = await db.prepare(sql).all(...params);
  return Promise.all(rows.map((row) => loadDelivery(db, row.payment_reference, {
    includeContents,
    includePages: true
  })));
}
