// End-to-end tests for the microservice split.
//
// Boots core-service, order-service and the gateway against a local MongoDB, with a mock
// UPI provider, then walks real shopper and admin journeys through the gateway:
// checkout, payments (webhooks and status checks), support reports, what happens when a
// service is down, and the one-time data migration.
//
//   docker compose up -d mongo     # or any MongoDB on 127.0.0.1:27017
//   npm run test:e2e
//
// Only databases named looksmatter_e2e_* are touched (and dropped afterwards). The
// tests refuse to run against a non-local MongoDB unless E2E_ALLOW_REMOTE_DB=1.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { encrypt } from './support/providerCrypto.mjs';
import { startMockPaymentProvider } from './support/mockPaymentProvider.mjs';
import { LOG_DIR, runScript, startService, stopAll, stopService } from './support/stack.mjs';

// Direct database setup and checks use core-service's copy of mongoose.
const require = createRequire(new URL('../services/core-service/package.json', import.meta.url));
const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;

const MONGO_URI = process.env.E2E_MONGO_URI || 'mongodb://127.0.0.1:27017';
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(MONGO_URI) && process.env.E2E_ALLOW_REMOTE_DB !== '1') {
  throw new Error(`Refusing to run e2e tests against ${MONGO_URI}. Use a local MongoDB or set E2E_ALLOW_REMOTE_DB=1.`);
}

const DB = {
  core: 'looksmatter_e2e_core',
  orders: 'looksmatter_e2e_orders',
  monolith: 'looksmatter_e2e_monolith',
  migrated: 'looksmatter_e2e_migrated',
};
const PORT = { gateway: 5100, core: 5101, orders: 5102, provider: 5199 };
const GATEWAY = `http://127.0.0.1:${PORT.gateway}`;
const CORE = `http://127.0.0.1:${PORT.core}`;
const ORDERS = `http://127.0.0.1:${PORT.orders}`;
const JWT_SECRET = randomBytes(24).toString('hex');
const INTERNAL_API_KEY = randomBytes(24).toString('hex');
const PROVIDER = { clientId: 'test-client', secretKey: 'test-secret', encryptionKey: 'test-encryption-key' };

const coreEnv = {
  PORT: String(PORT.core),
  MONGO_URI,
  MONGO_DB: DB.core,
  JWT_SECRET,
  INTERNAL_API_KEY,
  ORDER_SERVICE_URL: ORDERS,
  ADMIN_EMAIL: '',
  ADMIN_PASSWORD: '',
  SEED_PRODUCTS_FILE: '',
};
const orderEnv = (providerUrl) => ({
  PORT: String(PORT.orders),
  MONGO_URI,
  MONGO_DB: DB.orders,
  JWT_SECRET,
  INTERNAL_API_KEY,
  CORE_SERVICE_URL: CORE,
  PaymentGateway_CLIENT_ID: PROVIDER.clientId,
  PaymentGateway_SECRET_KEY: PROVIDER.secretKey,
  PaymentGateway_ENCRYPTION_KEY: PROVIDER.encryptionKey,
  PaymentGateway_API_URL: `${providerUrl}/initiate`,
  PaymentGateway_STATUS_API_URL: `${providerUrl}/status`,
  PaymentGateway_CALLBACK_URL: `${GATEWAY}/api/payment/webhook`,
  SOURCE_MONGO_URI: '',
  SOURCE_MONGO_DB: DB.core,
});
const gatewayEnv = {
  PORT: String(PORT.gateway),
  CORE_SERVICE_URL: CORE,
  ORDER_SERVICE_URL: ORDERS,
  CORS_ORIGINS: '',
  PROXY_TIMEOUT_MS: '10000',
};

const address = {
  country: 'India', firstName: 'Asha', lastName: 'K', address1: '12, 2nd Cross', address2: 'MG Road',
  city: 'Bengaluru', state: 'Karnataka', pin: '560001', phone: '9876543210',
};

async function api(method, path, { token, body, base = GATEWAY, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

const db = (name) => mongoose.connection.useDb(name, { useCache: true });

async function register(name, email) {
  const { status, data } = await api('POST', '/api/auth/register', { body: { name, email, password: 'password123' } });
  assert.equal(status, 201, JSON.stringify(data));
  return { token: data.token, id: data.user.id, name, email };
}

async function addToCart(user, productId, qty, size = '') {
  const { status, data } = await api('POST', '/api/users/cart', { token: user.token, body: { productId, qty, size } });
  assert.equal(status, 201, JSON.stringify(data));
}

const placeOrder = (user, paymentMethod = 'cod') =>
  api('POST', '/api/orders', { token: user.token, body: { shippingAddress: address, paymentMethod } });

const createProduct = async (admin, body) => {
  const { status, data } = await api('POST', '/api/products', { token: admin.token, body });
  assert.equal(status, 201, JSON.stringify(data));
  return data._id;
};

const sendWebhook = (payload) =>
  api('POST', '/api/payment/webhook', { body: { encryptedData: encrypt(payload, PROVIDER.encryptionKey) } });

async function dropTestDatabases() {
  for (const name of Object.values(DB)) await db(name).dropDatabase();
}

describe('LOOKSMATTER microservices, end to end through the gateway', () => {
  const state = {};
  let provider;

  before(async () => {
    rmSync(LOG_DIR, { recursive: true, force: true });
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    } catch (err) {
      throw new Error(`MongoDB is not reachable at ${MONGO_URI} (${err.message}). Start one with: docker compose up -d mongo`);
    }
    await dropTestDatabases();
    provider = await startMockPaymentProvider({ port: PORT.provider, ...PROVIDER });
    await startService('core-service', coreEnv, { port: PORT.core });
    await startService('order-service', orderEnv(provider.url), { port: PORT.orders });
    await startService('gateway', gatewayEnv, { port: PORT.gateway, healthPath: '/' });
  });

  after(async () => {
    await stopAll();
    await provider?.close();
    await dropTestDatabases().catch(() => {});
    await mongoose.disconnect();
    console.log(`Service logs: ${LOG_DIR}`);
  });

  it('gateway answers liveness, tags requests, and reports every service healthy', async () => {
    const live = await api('GET', '/');
    assert.equal(live.status, 200);
    assert.equal(live.data, 'API running successfully');
    assert.ok(live.headers.get('x-request-id'));

    const health = await api('GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.data.services, { 'core-service': 'up', 'order-service': 'up' });
  });

  it('internal APIs are not routed by the gateway and need the key when called directly', async () => {
    const someone = '000000000000000000000000';
    assert.equal((await api('GET', `/internal/orders/${someone}`)).status, 404);
    assert.equal((await api('POST', `/internal/users/${someone}/checkout-cart`)).status, 404);
    assert.equal((await api('POST', `/internal/users/${someone}/checkout-cart`, { base: CORE })).status, 401);
    const wrongKey = await api('GET', `/internal/orders/${someone}`, { base: ORDERS, headers: { 'X-Internal-Api-Key': 'wrong' } });
    assert.equal(wrongKey.status, 401);
  });

  it('shoppers and an admin sign up through core-service', async () => {
    state.asha = await register('Asha K', 'asha@example.com');
    state.ravi = await register('Ravi M', 'ravi@example.com');
    await register('Admin', 'admin@example.com');
    await db(DB.core).collection('users').updateOne({ email: 'admin@example.com' }, { $set: { role: 'admin' } });
    const login = await api('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'password123' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'admin');
    state.admin = { token: login.data.token };
  });

  it('an admin builds the catalogue', async () => {
    state.shirt = await createProduct(state.admin, {
      name: 'Oxford Shirt', category: 'Shirts', price: 1000, image: 'https://example.com/shirt.jpg', sizes: 'S, M, L',
    });
    state.cap = await createProduct(state.admin, {
      name: 'Canvas Cap', category: 'Accessories', price: 500, image: 'https://example.com/cap.jpg',
    });
  });

  it('image uploads stream through the gateway untouched (multipart in, static file out)', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'E2E Upload.png');
    const upload = await fetch(`${GATEWAY}/api/uploads`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.admin.token}` },
      body: form,
    });
    assert.equal(upload.status, 201);
    const { url } = await upload.json();
    assert.match(url, /^\/uploads\/e2e-upload-\d+\.png$/);

    const served = await fetch(`${GATEWAY}${url}`);
    assert.equal(served.status, 200);
    assert.ok(Buffer.from(await served.arrayBuffer()).equals(png), 'the stored file must be byte-identical');
    rmSync(new URL(`../services/core-service${url}`, import.meta.url), { force: true });
  });

  it('checkout prices the bag on the server, snapshots the customer and empties the bag', async () => {
    await addToCart(state.asha, state.shirt, 2, 'M');
    await addToCart(state.asha, state.cap, 1);

    const { status, data: order } = await placeOrder(state.asha, 'cod');
    assert.equal(status, 201, JSON.stringify(order));
    assert.equal(order.subtotal, 2500);
    assert.equal(order.tax, 12.5);
    assert.equal(order.shippingCost, 45);
    assert.equal(order.total, 2557.5);
    assert.deepEqual(order.customer, { name: 'Asha K', email: 'asha@example.com' });
    assert.deepEqual(
      order.items.map((i) => [i.name, i.size, i.qty, i.price]),
      [['Oxford Shirt', 'M', 2, 1000], ['Canvas Cap', '', 1, 500]]
    );
    assert.match(order.orderNumber, /^ORD\d+$/);

    const cart = await api('GET', '/api/users/cart', { token: state.asha.token });
    assert.deepEqual(cart.data, []);
    state.codOrder = order;
  });

  it('removing ordered lines leaves lines that were not part of the order', async () => {
    await addToCart(state.asha, state.shirt, 1, 'M');
    await addToCart(state.asha, state.shirt, 1, 'L');
    await addToCart(state.asha, state.cap, 1);

    const removed = await api('POST', `/internal/users/${state.asha.id}/cart/remove-lines`, {
      base: CORE,
      headers: { 'X-Internal-Api-Key': INTERNAL_API_KEY },
      body: { lines: [{ productId: state.shirt, size: 'M' }, { productId: state.cap, size: '' }] },
    });
    assert.equal(removed.status, 200);

    const cart = await api('GET', '/api/users/cart', { token: state.asha.token });
    assert.deepEqual(cart.data.map((line) => [line.product.name, line.size]), [['Oxford Shirt', 'L']]);
    await api('DELETE', '/api/users/cart', { token: state.asha.token });
  });

  it('a product that vanished from the catalogue blocks checkout with 409 and leaves the bag', async () => {
    await addToCart(state.asha, state.cap, 1);
    // Delete it behind the API's back, the way a catalogue re-import would.
    await db(DB.core).collection('products').deleteOne({ _id: new ObjectId(state.cap) });

    const { status, data } = await placeOrder(state.asha);
    assert.equal(status, 409);
    assert.equal(data.code, 'CART_ITEMS_UNAVAILABLE');
    assert.equal(data.removedCount, 1);
    assert.deepEqual((await api('GET', '/api/users/cart', { token: state.asha.token })).data, []);

    state.cap = await createProduct(state.admin, {
      name: 'Canvas Cap', category: 'Accessories', price: 500, image: 'https://example.com/cap.jpg',
    });
  });

  it('an empty bag cannot be ordered', async () => {
    const { status } = await placeOrder(state.asha);
    assert.equal(status, 400);
  });

  it('admins see who placed each order, and customer stats keep their old public URL', async () => {
    const all = await api('GET', '/api/orders/admin/all', { token: state.admin.token });
    assert.equal(all.status, 200);
    const listed = all.data.find((o) => o._id === state.codOrder._id);
    assert.deepEqual(listed.user, { _id: state.asha.id, name: 'Asha K', email: 'asha@example.com' });

    // Served by order-service; the gateway rewrites the path the storefront has always used.
    const stats = await api('GET', `/api/users/${state.asha.id}/orders`, { token: state.admin.token });
    assert.equal(stats.status, 200);
    assert.equal(stats.data.totalOrders, 1);
    assert.equal(stats.data.orders[0].orderNumber, state.codOrder.orderNumber);

    assert.equal((await api('GET', `/api/users/${state.asha.id}/orders`, { token: state.asha.token })).status, 403);
  });

  it('a payment is always started for the order total, whatever amount the browser sends', async () => {
    await addToCart(state.asha, state.shirt, 1, 'S');
    const { data: order } = await placeOrder(state.asha, 'online');
    assert.equal(order.total, 1050);

    const pay = await api('POST', '/api/payment/initiate', {
      token: state.asha.token,
      body: { orderId: order._id, amount: 1, phone: '9876543210' },
    });
    assert.equal(pay.status, 200, JSON.stringify(pay.data));
    assert.equal(pay.data.success, true);
    assert.equal(provider.initiations.at(-1).amount, 1050);

    const stored = (await api('GET', `/api/orders/${order._id}`, { token: state.asha.token })).data;
    assert.equal(stored.paymentRefId, pay.data.txnRefId);
    assert.equal(stored.PaymentGatewayOrderId, pay.data.PaymentGatewayOrderId);
    state.onlineOrder = stored;
  });

  it("a shopper can't start or check a payment for someone else's order", async () => {
    const start = await api('POST', '/api/payment/initiate', {
      token: state.ravi.token,
      body: { orderId: state.onlineOrder._id, phone: '9000000000' },
    });
    assert.equal(start.status, 404);

    const check = await api('POST', '/api/payment/status', {
      token: state.ravi.token,
      body: { txnRefId: state.onlineOrder.paymentRefId, orderData: { orderId: state.onlineOrder._id } },
    });
    assert.equal(check.status, 404);
  });

  it('a webhook confirms payment; repeated and late webhooks do not undo it', async () => {
    const event = (status) => ({
      orderId: state.onlineOrder.PaymentGatewayOrderId,
      transactionRefId: state.onlineOrder.paymentRefId,
      status,
      payerVpa: 'asha@upi',
    });
    const current = async () => (await api('GET', `/api/orders/${state.onlineOrder._id}`, { token: state.asha.token })).data;

    assert.equal((await sendWebhook(event('SUCCESS'))).status, 200);
    let order = await current();
    assert.equal(order.paymentStatus, 'paid');
    assert.equal(order.status, 'order confirmed');
    assert.equal(order.payerVpa, 'asha@upi');

    await api('PUT', `/api/orders/admin/${order._id}/status`, { token: state.admin.token, body: { status: 'in transit' } });
    await sendWebhook(event('SUCCESS')); // the provider retries
    await sendWebhook(event('TRANSACTION_IN_PROGRESS')); // an older event arrives late
    order = await current();
    assert.equal(order.paymentStatus, 'paid');
    assert.equal(order.status, 'in transit');

    await sendWebhook(event('Cb_Refunded')); // chargeback
    assert.equal((await current()).paymentStatus, 'refunded');
  });

  it('a status check asks the provider about the stored transaction, not one from the request', async () => {
    await addToCart(state.asha, state.cap, 1);
    const { data: order } = await placeOrder(state.asha, 'online');
    const pay = await api('POST', '/api/payment/initiate', {
      token: state.asha.token,
      body: { orderId: order._id, phone: '9876543210' },
    });
    provider.setStatus(pay.data.txnRefId, 'SUCCESS');

    const check = await api('POST', '/api/payment/status', {
      token: state.asha.token,
      body: { txnRefId: 'FORGED-TXN', orderData: { orderId: order._id, amount: 1, PaymentGatewayOrderId: 'forged' } },
    });
    assert.equal(check.status, 200, JSON.stringify(check.data));
    assert.equal(check.data.status, 'SUCCESS');

    const query = provider.statusQueries.at(-1);
    assert.equal(query.txnRefId, pay.data.txnRefId);
    assert.equal(query.orderId, pay.data.PaymentGatewayOrderId);
    assert.equal(query.amount, order.total);

    const updated = (await api('GET', `/api/orders/${order._id}`, { token: state.asha.token })).data;
    assert.equal(updated.paymentStatus, 'paid');
    assert.equal(updated.status, 'order confirmed');
  });

  it('the endpoint that let shoppers mark their own order paid is gone', async () => {
    const { status } = await api('PUT', `/api/payment/update-order/${state.codOrder._id}`, {
      token: state.asha.token,
      body: { paymentStatus: 'paid' },
    });
    assert.equal(status, 404);
  });

  it('shoppers can cancel an order only while its payment is pending', async () => {
    const cancel = await api('PUT', `/api/orders/${state.codOrder._id}/cancel`, { token: state.asha.token });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.order.status, 'cancelled');

    const tooLate = await api('PUT', `/api/orders/${state.onlineOrder._id}/cancel`, { token: state.asha.token });
    assert.equal(tooLate.status, 400);
  });

  it('support reports check ownership with order-service and show the live order status', async () => {
    const filed = await api('POST', '/api/reports', {
      token: state.asha.token,
      body: { orderId: state.codOrder._id, type: 'order_issue', subject: 'Wrong size', notes: 'Ordered M, need L' },
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.data));
    assert.equal(filed.data.order.orderNumber, state.codOrder.orderNumber);
    assert.equal(filed.data.order.total, 2557.5);
    assert.equal(filed.data.order.status, 'cancelled');
    assert.equal(filed.data.orderSnapshot, undefined);
    state.report = filed.data;

    const notTheirs = await api('POST', '/api/reports', {
      token: state.ravi.token,
      body: { orderId: state.codOrder._id, type: 'order_issue', subject: 'Not mine', notes: '...' },
    });
    assert.equal(notTheirs.status, 404);

    const all = await api('GET', '/api/reports/admin/all', { token: state.admin.token });
    assert.equal(all.status, 200);
    assert.equal(all.data[0].order.status, 'cancelled');
    assert.equal(all.data[0].user.name, 'Asha K');

    const mine = await api('GET', '/api/reports/my', { token: state.asha.token });
    assert.deepEqual(mine.data.map((r) => r.order.orderNumber), [state.codOrder.orderNumber]);

    const one = await api('GET', `/api/reports/${state.report._id}`, { token: state.admin.token });
    assert.equal(one.status, 200);
    assert.equal(one.data.order.items.length, 2);
  });

  it('when order-service is down, the rest of the store keeps working', async () => {
    await stopService('order-service');
    try {
      const orders = await api('GET', '/api/orders/my', { token: state.asha.token });
      assert.equal(orders.status, 502);
      assert.equal(orders.data.service, 'order-service');

      assert.equal((await api('GET', '/api/products')).status, 200);
      assert.equal((await api('GET', '/api/users/cart', { token: state.asha.token })).status, 200);

      const reports = await api('GET', '/api/reports/admin/all', { token: state.admin.token });
      assert.equal(reports.status, 200);
      assert.equal(reports.data[0].order.orderNumber, state.codOrder.orderNumber); // from the snapshot
      assert.equal(reports.data[0].order.status, undefined); // the live-only field

      const filing = await api('POST', '/api/reports', {
        token: state.asha.token,
        body: { orderId: state.codOrder._id, type: 'order_issue', subject: 'Another', notes: '...' },
      });
      assert.equal(filing.status, 503);

      const health = await api('GET', '/health');
      assert.equal(health.status, 503);
      assert.equal(health.data.services['order-service'], 'down');
    } finally {
      await startService('order-service', orderEnv(provider.url), { port: PORT.orders });
    }
    assert.equal((await api('GET', '/health')).status, 200);
  });

  it('when core-service is down, checkout fails cleanly and places no order', async () => {
    await addToCart(state.asha, state.cap, 1);
    await stopService('core-service');
    try {
      const { status, data } = await placeOrder(state.asha);
      assert.equal(status, 503);
      assert.match(data.message, /temporarily unavailable/);
    } finally {
      await startService('core-service', coreEnv, { port: PORT.core });
    }
    // The COD order and the two online orders; nothing was created during the outage.
    const placed = await db(DB.orders).collection('orders').countDocuments({ user: new ObjectId(state.asha.id) });
    assert.equal(placed, 3);
    await api('DELETE', '/api/users/cart', { token: state.asha.token });
  });

  it('the one-time migration copies monolith orders, backfills snapshots and is safe to re-run', async () => {
    const monolith = db(DB.monolith);
    const migrated = db(DB.migrated);
    const meera = new ObjectId();
    const arjun = new ObjectId();
    const deletedUser = new ObjectId();
    const [o1, o2, o3] = [new ObjectId(), new ObjectId(), new ObjectId()];

    await monolith.collection('users').insertMany([
      { _id: meera, name: 'Meera', email: 'meera@example.com' },
      { _id: arjun, name: 'Arjun', email: 'arjun@example.com' },
    ]);
    await monolith.collection('orders').insertMany([
      { _id: o1, user: meera, orderNumber: 'ORD1000001', total: 1045, status: 'delivered', paymentStatus: 'paid', items: [], createdAt: new Date('2026-01-05') },
      { _id: o2, user: arjun, orderNumber: 'ORD1000002', total: 545, status: 'pending', paymentStatus: 'pending', items: [], createdAt: new Date('2026-02-01') },
      { _id: o3, user: deletedUser, orderNumber: 'ORD1000003', total: 99, status: 'cancelled', paymentStatus: 'failed', items: [], createdAt: new Date('2026-03-01') },
    ]);
    await monolith.collection('reports').insertOne({ user: meera, order: o1, type: 'order_issue', subject: 'Late', notes: '...', status: 'pending' });
    // The new service already holds o2 and has updated it since (a webhook marked it paid).
    await migrated.collection('orders').insertOne({ _id: o2, user: arjun, orderNumber: 'ORD1000002', total: 545, status: 'order confirmed', paymentStatus: 'paid', items: [] });

    const env = { ...orderEnv(provider.url), MONGO_DB: DB.migrated, SOURCE_MONGO_DB: DB.monolith };

    const dryRun = await runScript('order-service', 'scripts/migrate-orders.js', [], env);
    assert.equal(dryRun.code, 0, dryRun.output);
    assert.match(dryRun.output, /DRY RUN/);
    assert.match(dryRun.output, /Orders to copy\s+2/);
    assert.equal(await migrated.collection('orders').countDocuments(), 1, 'a dry run must not write');

    const applied = await runScript('order-service', 'scripts/migrate-orders.js', ['--apply'], env);
    assert.equal(applied.code, 0, applied.output);
    assert.match(applied.output, /All 3 source orders are in/);

    const orders = await migrated.collection('orders').find().sort({ orderNumber: 1 }).toArray();
    assert.deepEqual(
      orders.map((o) => [o.orderNumber, o.customer?.name ?? null, o.paymentStatus]),
      [
        ['ORD1000001', 'Meera', 'paid'],
        ['ORD1000002', 'Arjun', 'paid'], // kept its newer state, gained a customer snapshot
        ['ORD1000003', null, 'failed'], // the customer's account no longer exists
      ]
    );
    const report = await monolith.collection('reports').findOne({ order: o1 });
    assert.equal(report.orderSnapshot.orderNumber, 'ORD1000001');
    assert.equal(report.orderSnapshot.total, 1045);

    const rerun = await runScript('order-service', 'scripts/migrate-orders.js', ['--apply'], env);
    assert.equal(rerun.code, 0, rerun.output);
    assert.match(rerun.output, /Orders to copy\s+0/);
    assert.match(rerun.output, /Reports needing an order snapshot\s+0/);
  });
});
