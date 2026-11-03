// One-time data migration for the split: copy orders out of the monolith's database
// into this service's own database.
//
//   npm run migrate                  dry run: print what would change, write nothing
//   npm run migrate -- --apply       copy and backfill
//
// Safe to run more than once, e.g. once to rehearse and again at cutover:
//   - an order is inserted only if the target doesn't have it yet, so an order this
//     service has updated since (say, by a payment webhook) is never overwritten
//   - nothing is ever deleted from the source database
// It also fills in the two snapshots the split relies on:
//   - orders.customer        { name, email }                  from the source `users`
//   - reports.orderSnapshot  { orderNumber, total, createdAt } on the source `reports`
//
// This is the only code in order-service that touches another service's database, and
// only because moving data between databases is what a migration is.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const APPLY = process.argv.includes('--apply');
const target = { uri: process.env.MONGO_URI, db: process.env.MONGO_DB };
const source = { uri: process.env.SOURCE_MONGO_URI || process.env.MONGO_URI, db: process.env.SOURCE_MONGO_DB };

if (!target.uri || !target.db || !source.db) {
  console.error('Set MONGO_URI and MONGO_DB (this service) and SOURCE_MONGO_DB (the monolith database). See .env.example.');
  process.exit(1);
}

const sameDatabase = source.uri === target.uri && source.db === target.db;

const connect = ({ uri, db }) =>
  mongoose.createConnection(uri, { dbName: db, serverSelectionTimeoutMS: 10000 }).asPromise();

const row = (label, value) => console.log(`  ${label.padEnd(48)} ${value}`);

async function main() {
  const sourceConn = await connect(source);
  const targetConn = sameDatabase ? sourceConn : await connect(target);

  try {
    const sourceOrders = sourceConn.db.collection('orders');
    const sourceUsers = sourceConn.db.collection('users');
    const sourceReports = sourceConn.db.collection('reports');
    const targetOrders = targetConn.db.collection('orders');

    console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}  ${source.db} → ${target.db}${sameDatabase ? '  (same database: backfill only)' : ''}\n`);

    // 1. Orders the target database doesn't have yet.
    const orders = await sourceOrders.find({}).toArray();
    const inTarget = new Set(
      (await targetOrders.find({}, { projection: { _id: 1 } }).toArray()).map((o) => String(o._id))
    );
    const toCopy = sameDatabase ? [] : orders.filter((o) => !inTarget.has(String(o._id)));

    // 2. Customer snapshots, read from the users who placed the orders.
    const userIds = new Map(orders.filter((o) => o.user).map((o) => [String(o.user), o.user]));
    const users = await sourceUsers
      .find({ _id: { $in: [...userIds.values()] } }, { projection: { name: 1, email: 1 } })
      .toArray();
    const customerOf = new Map(users.map((u) => [String(u._id), { name: u.name, email: u.email }]));
    const withCustomer = (o) =>
      o.customer || !customerOf.has(String(o.user)) ? o : { ...o, customer: customerOf.get(String(o.user)) };

    const copies = toCopy.map(withCustomer);
    const targetWithoutCustomer = await targetOrders
      .find({ customer: { $exists: false } }, { projection: { user: 1 } })
      .toArray();
    const customerBackfill = targetWithoutCustomer.filter((o) => customerOf.has(String(o.user)));
    const orphaned = orders.filter((o) => !o.customer && !customerOf.has(String(o.user))).length;

    // 3. Report snapshots, read from the orders the reports point at.
    const orderById = new Map(orders.map((o) => [String(o._id), o]));
    const reportsWithoutSnapshot = await sourceReports
      .find({ orderSnapshot: { $exists: false } }, { projection: { order: 1 } })
      .toArray();
    const reportBackfill = reportsWithoutSnapshot.filter((r) => orderById.has(String(r.order)));

    console.log('Plan');
    row('Orders in source database', orders.length);
    row('Already in target database', sameDatabase ? orders.length : orders.length - toCopy.length);
    row('Orders to copy', toCopy.length);
    row('Customer snapshots added while copying', copies.filter((o, i) => o !== toCopy[i]).length);
    row('Customer snapshots to backfill in target', customerBackfill.length);
    row('Orders whose customer account no longer exists', orphaned);
    row('Reports needing an order snapshot', reportBackfill.length);

    if (!APPLY) {
      console.log('\nDry run only: nothing was written. Re-run with --apply to make these changes.');
      return;
    }

    console.log('\nApplying');
    if (copies.length) {
      const result = await targetOrders.bulkWrite(
        copies.map(({ _id, ...doc }) => ({
          updateOne: { filter: { _id }, update: { $setOnInsert: doc }, upsert: true },
        })),
        { ordered: false }
      );
      row('Orders copied', result.upsertedCount);
    }
    if (customerBackfill.length) {
      const result = await targetOrders.bulkWrite(
        customerBackfill.map((o) => ({
          updateOne: {
            filter: { _id: o._id, customer: { $exists: false } },
            update: { $set: { customer: customerOf.get(String(o.user)) } },
          },
        })),
        { ordered: false }
      );
      row('Customer snapshots backfilled', result.modifiedCount);
    }
    if (reportBackfill.length) {
      const result = await sourceReports.bulkWrite(
        reportBackfill.map((r) => {
          const { orderNumber, total, createdAt } = orderById.get(String(r.order));
          return {
            updateOne: {
              filter: { _id: r._id, orderSnapshot: { $exists: false } },
              update: { $set: { orderSnapshot: { orderNumber, total, createdAt } } },
            },
          };
        }),
        { ordered: false }
      );
      row('Report snapshots backfilled', result.modifiedCount);
    }

    // Verify: every source order must now exist in the target.
    const nowInTarget = new Set(
      (await targetOrders.find({}, { projection: { _id: 1 } }).toArray()).map((o) => String(o._id))
    );
    const stillMissing = orders.filter((o) => !nowInTarget.has(String(o._id))).length;
    console.log(
      stillMissing === 0
        ? `\n✅ All ${orders.length} source orders are in ${target.db}.`
        : `\n⚠️  ${stillMissing} source orders are still missing in ${target.db}.`
    );
    if (stillMissing) process.exitCode = 1;
  } finally {
    await sourceConn.close();
    if (!sameDatabase) await targetConn.close();
  }
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
