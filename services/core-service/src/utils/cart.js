// Helpers for cart/favorite references to products.
//
// User documents store product ids. When a product is deleted (or the catalogue
// is re-imported with new ids), those ids keep pointing at nothing and a
// `.populate()` turns them into `null`. These helpers resolve the ids against
// the live catalogue so callers can drop the dead ones instead of crashing.
import Product from '../models/Product.js';

/** True for a 24-hex-character MongoDB ObjectId string. */
export function isObjectId(value) {
  return typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
}

/** Positive whole quantity, or `null` when the value isn't one. */
export function toQuantity(value) {
  const qty = Math.floor(Number(value));
  return Number.isFinite(qty) && qty >= 1 ? qty : null;
}

/**
 * Load the live products for a list of ids.
 * Returns a Map of id -> product document plus the ids that no longer exist.
 */
export async function findLiveProducts(ids = []) {
  const unique = [...new Set(ids.map(String))];
  const products = unique.length ? await Product.find({ _id: { $in: unique } }) : [];
  const byId = new Map(products.map((p) => [String(p._id), p]));
  const missingIds = unique.filter((id) => !byId.has(id));
  return { byId, missingIds };
}

/**
 * Split stored cart lines into lines whose product still exists (with the full
 * product document attached) and the ids of products that are gone.
 */
export async function resolveCartLines(cart = []) {
  const { byId, missingIds } = await findLiveProducts(cart.map((line) => line.product));
  const lines = [];
  for (const line of cart) {
    const product = byId.get(String(line.product));
    if (product) lines.push({ product, qty: line.qty, size: line.size || '' });
  }
  return { lines, missingIds };
}
