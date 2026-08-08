import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const databasePath = path.join(os.tmpdir(), `nexus-text-stock-${process.pid}.db`);
fs.rmSync(databasePath, { force: true });
process.env.DATABASE_URL = '';
process.env.DATABASE_PATH = databasePath;
process.env.APP_MASTER_KEY = Buffer.alloc(32, 17).toString('base64');
process.env.APP_MASTER_KEY_ID = 'text-stock-test';

const { db, initDatabase } = await import('../src/db.js');
const {
  appendTextStockParagraphs,
  buildTextStockDmPages,
  claimTextStockDeliveryLease,
  completeTextStockDelivery,
  createTextProduct,
  findTextProduct,
  getTextStockDeliveryByPaymentReference,
  recordTextStockDeliveryMessage,
  releaseTextStockDeliveryLease,
  renewTextStockDeliveryLease,
  reserveTextStock
} = await import('../src/textStock.js');

await initDatabase();

let productNumber = 0;

async function makeProduct({ itemsPerPurchase = 1 } = {}) {
  productNumber += 1;
  return createTextProduct({
    name: `Produto FIFO ${productNumber}`,
    slug: `produto-fifo-${productNumber}`,
    priceCents: 1290,
    itemsPerPurchase,
    createdByDiscordId: 'admin-test'
  });
}

test('db SQLite serializa transacoes globais e leituras externas durante uma transacao async', async () => {
  let openFirstTransaction;
  let firstTransactionStarted;
  const gate = new Promise((resolve) => { openFirstTransaction = resolve; });
  const started = new Promise((resolve) => { firstTransactionStarted = resolve; });
  let secondTransactionRan = false;
  let externalReadRan = false;

  const first = db.transaction(async (tx) => {
    firstTransactionStarted();
    await gate;
    const nested = await db.transaction(async (nestedTx) => nestedTx.prepare('SELECT 11 AS value').get());
    assert.equal(Number(nested.value), 11);
    return tx.prepare('SELECT 1 AS value').get();
  });
  await started;
  const second = db.transaction(async (tx) => {
    secondTransactionRan = true;
    return tx.prepare('SELECT 2 AS value').get();
  });
  const externalRead = db.prepare('SELECT 3 AS value').get().then((row) => {
    externalReadRan = true;
    return row;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondTransactionRan, false);
  assert.equal(externalReadRan, false);

  openFirstTransaction();
  const [firstRow, secondRow, readRow] = await Promise.all([first, second, externalRead]);
  assert.equal(Number(firstRow.value), 1);
  assert.equal(Number(secondRow.value), 2);
  assert.equal(Number(readRow.value), 3);
});

test('importa parágrafos cifrados e reserva sempre o menor queue_position', async () => {
  const product = await makeProduct();
  const imported = await appendTextStockParagraphs(product.id, 'primeiro\n\nsegundo\n\nterceiro');
  assert.deepEqual(
    { count: imported.count, first: imported.firstQueuePosition, last: imported.lastQueuePosition },
    { count: 3, first: 1, last: 3 }
  );

  const stored = await db.prepare(`
    SELECT content_encrypted FROM text_stock_items WHERE product_id = ? ORDER BY queue_position ASC
  `).all(product.id);
  assert.equal(stored.length, 3);
  assert.ok(stored.every((row) => row.content_encrypted.startsWith('v2:')));
  assert.ok(stored.every((row) => !row.content_encrypted.includes('primeiro')));

  const one = await reserveTextStock({
    paymentReference: `fifo-one-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-one'
  });
  const two = await reserveTextStock({
    paymentReference: `fifo-two-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-two'
  });
  const three = await reserveTextStock({
    paymentReference: `fifo-three-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-three'
  });

  assert.equal(one.status, 'reserved');
  assert.equal(two.status, 'reserved');
  assert.equal(three.status, 'reserved');
  assert.deepEqual(one.delivery.items.map((item) => item.content), ['primeiro']);
  assert.deepEqual(two.delivery.items.map((item) => item.content), ['segundo']);
  assert.deepEqual(three.delivery.items.map((item) => item.content), ['terceiro']);
});

test('uma compra paga que espera stock segura a fila para compras posteriores', async () => {
  const product = await makeProduct({ itemsPerPurchase: 2 });
  await appendTextStockParagraphs(product.id, 'um');

  const first = await reserveTextStock({
    paymentReference: `waiting-first-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-waiting-first'
  });
  const later = await reserveTextStock({
    paymentReference: `waiting-later-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-waiting-later',
    quantity: 1
  });
  assert.equal(first.status, 'queued');
  assert.equal(later.status, 'queued');

  await appendTextStockParagraphs(product.id, 'dois\n\ntres');
  const completedFirst = await getTextStockDeliveryByPaymentReference(`waiting-first-${product.id}`);
  const completedLater = await getTextStockDeliveryByPaymentReference(`waiting-later-${product.id}`);
  assert.equal(completedFirst.status, 'reserved');
  assert.equal(completedLater.status, 'reserved');
  assert.deepEqual(completedFirst.items.map((item) => item.content), ['um', 'dois']);
  assert.deepEqual(completedLater.items.map((item) => item.content), ['tres']);
});

test('retries iguais e reservas concorrentes em SQLite nao duplicam itens nem transacoes', async () => {
  const product = await makeProduct();
  await appendTextStockParagraphs(product.id, 'alpha\n\nbeta');
  const referenceOne = `concurrent-one-${product.id}`;
  const referenceTwo = `concurrent-two-${product.id}`;

  const [oneA, oneB, two] = await Promise.all([
    reserveTextStock({ paymentReference: referenceOne, productId: product.id, buyerDiscordId: 'buyer-concurrent-one', quantity: 1 }),
    reserveTextStock({ paymentReference: referenceOne, productId: product.id, buyerDiscordId: 'buyer-concurrent-one' }),
    reserveTextStock({ paymentReference: referenceTwo, productId: product.id, buyerDiscordId: 'buyer-concurrent-two' })
  ]);

  assert.equal(oneA.delivery.id, oneB.delivery.id);
  assert.equal(oneA.status, 'reserved');
  assert.equal(two.status, 'reserved');
  assert.deepEqual(oneA.delivery.items.map((item) => item.content), ['alpha']);
  assert.deepEqual(two.delivery.items.map((item) => item.content), ['beta']);

  const deliveries = await db.prepare(`
    SELECT payment_reference FROM text_stock_deliveries WHERE product_id = ? ORDER BY queue_position ASC
  `).all(product.id);
  assert.deepEqual(deliveries.map((row) => row.payment_reference), [referenceOne, referenceTwo]);
});

test('DM persiste paginas, retoma somente as pendentes e completa a entrega', async () => {
  const product = await makeProduct();
  const longContent = 'x'.repeat(620);
  await appendTextStockParagraphs(product.id, longContent);
  const reference = `dm-retry-${product.id}`;
  await reserveTextStock({ paymentReference: reference, productId: product.id, buyerDiscordId: 'buyer-dm' });
  const lease = await claimTextStockDeliveryLease({ paymentReference: reference, leaseToken: 'dm-worker' });
  assert.equal(lease.claimed, true);

  const pages = await buildTextStockDmPages(reference, { maxCharacters: 200, leaseToken: lease.leaseToken });
  assert.ok(pages.length > 1);
  assert.ok(pages.every((page) => page.content.length <= 200));
  await recordTextStockDeliveryMessage({
    paymentReference: reference,
    pageId: pages[0].id,
    discordMessageId: 'discord-message-1',
    leaseToken: lease.leaseToken
  });

  const retryPages = await buildTextStockDmPages(reference, { maxCharacters: 200, leaseToken: lease.leaseToken });
  assert.equal(retryPages.length, pages.length - 1);
  assert.ok(retryPages.every((page) => page.id !== pages[0].id));
  await assert.rejects(
    completeTextStockDelivery(reference, { leaseToken: lease.leaseToken }),
    (error) => error?.code === 'TEXT_STOCK_DELIVERY_PAGES_PENDING'
  );

  for (const page of retryPages) {
    await recordTextStockDeliveryMessage({
      paymentReference: reference,
      pageId: page.id,
      discordMessageId: `discord-message-${page.position}`,
      leaseToken: lease.leaseToken
    });
  }
  const delivery = await completeTextStockDelivery(reference, { leaseToken: lease.leaseToken });
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.items[0].status, 'delivered');

  const stock = await findTextProduct(product.id);
  assert.equal(stock.deliveredCount, 1);
  assert.equal(stock.reservedCount, 0);
  const persistedLease = await db.prepare(`
    SELECT delivery_lease_token, delivery_lease_expires_at
    FROM text_stock_deliveries WHERE payment_reference = ?
  `).get(reference);
  assert.equal(persistedLease.delivery_lease_token, null);
  assert.equal(persistedLease.delivery_lease_expires_at, null);
});

test('lease persistente permite somente um worker de DM por entrega e pode ser renovado', async () => {
  const product = await makeProduct();
  await appendTextStockParagraphs(product.id, 'conteudo do lease');
  const reference = `lease-${product.id}`;
  await reserveTextStock({ paymentReference: reference, productId: product.id, buyerDiscordId: 'buyer-lease' });

  const [first, second] = await Promise.all([
    claimTextStockDeliveryLease({ paymentReference: reference, leaseToken: 'worker-a', ttlMs: 60_000 }),
    claimTextStockDeliveryLease({ paymentReference: reference, leaseToken: 'worker-b', ttlMs: 60_000 })
  ]);
  const winner = first.claimed ? first : second;
  const loser = first.claimed ? second : first;
  const loserToken = first.claimed ? 'worker-b' : 'worker-a';
  assert.equal(winner.claimed, true);
  assert.equal(loser.claimed, false);
  assert.equal(loser.reason, 'active_lease');
  await assert.rejects(
    buildTextStockDmPages(reference, { leaseToken: loserToken }),
    (error) => error?.code === 'TEXT_STOCK_LEASE_NOT_OWNER'
  );

  const renewed = await renewTextStockDeliveryLease({
    paymentReference: reference,
    leaseToken: winner.leaseToken,
    ttlMs: 60_000
  });
  assert.equal(renewed.renewed, true);
  assert.ok(renewed.leaseExpiresAt);
  assert.equal((await releaseTextStockDeliveryLease({
    paymentReference: reference,
    leaseToken: loserToken
  })).released, false);
  assert.equal((await releaseTextStockDeliveryLease({
    paymentReference: reference,
    leaseToken: winner.leaseToken
  })).released, true);
  assert.equal((await claimTextStockDeliveryLease({
    paymentReference: reference,
    leaseToken: 'worker-b',
    ttlMs: 60_000
  })).claimed, true);

  await db.prepare(`
    UPDATE text_stock_deliveries SET delivery_lease_expires_at = ? WHERE payment_reference = ?
  `).run(new Date(Date.now() - 1_000).toISOString(), reference);
  assert.equal((await claimTextStockDeliveryLease({
    paymentReference: reference,
    leaseToken: 'worker-c',
    ttlMs: 60_000
  })).claimed, true);
});

test('Pix emitido antes de pausar o produto ainda pode reservar a entrega', async () => {
  const product = await makeProduct();
  await appendTextStockParagraphs(product.id, 'item confirmado apos pausa');
  await db.prepare('UPDATE text_stock_products SET active = 0 WHERE id = ?').run(product.id);
  const result = await reserveTextStock({
    paymentReference: `paused-product-${product.id}`,
    productId: product.id,
    buyerDiscordId: 'buyer-paused'
  });
  assert.equal(result.status, 'reserved');
  assert.deepEqual(result.delivery.items.map((item) => item.content), ['item confirmado apos pausa']);
});
