// src/controllers/productController.js
import Product from '../models/Product.js';
import User from '../models/User.js';
import { isObjectId } from '../utils/cart.js';

export async function listProducts(req, res) {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  // allow limit=0 => return all items (no paging)
  const rawLimit = parseInt(req.query.limit ?? '20', 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 20;

  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();

  const filter = {};
  if (q) {
    filter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { description: { $regex: q, $options: 'i' } },
      { tags: { $regex: q, $options: 'i' } },
    ];
  }
  if (category) filter.category = category;

  const total = await Product.countDocuments(filter);

  // If limit === 0, return ALL items (no pagination)
  if (limit === 0) {
    const items = await Product.find(filter)
      .sort({ createdAt: -1, _id: -1 });
    return res.json({ items, total: items.length, page: 1, pages: 1 });
  }

  const safeLimit = Math.max(1, Math.min(100, limit));
  const items = await Product.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .skip((page - 1) * safeLimit)
    .limit(safeLimit);

  const pages = Math.max(1, Math.ceil(total / safeLimit));
  res.json({ items, total, page, pages });
}

export async function getProduct(req,res){
  try {
    // A malformed id can't match anything; answer 404 instead of letting the cast error escape.
    if (!isObjectId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const prod = await Product.findById(req.params.id);
    if (!prod) return res.status(404).json({ message: 'Not found' });
    res.json(prod);
  } catch (err) {
    console.error('getProduct error:', err);
    res.status(500).json({ message: 'Failed to load product' });
  }
}

// ---- Helpers -------------------------------------------------------------

// Coerce loose values (true/false, "true"/"TRUE"/"yes"/"1", 1/0, "") to a boolean.
// Returns `fallback` when the value is undefined/null/'' (i.e. column absent or blank).
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'in stock', 'instock', 'available', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'out of stock', 'outofstock', 'sold out', 'soldout', 'off'].includes(v)) return false;
  return fallback;
}

// Coerce to a number; returns `fallback` when not a finite number.
function toNum(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Normalize the `sizes` field into a clean array of unique, trimmed strings.
// Accepts a real array (from JSON) or a delimited string (from CSV/Excel imports),
// e.g. "S, M, L" or "6|7|8". Returns [] when nothing usable is provided.
function toSizes(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[,|/]/);
  const seen = new Set();
  const out = [];
  raw.forEach((s) => {
    const trimmed = String(s).trim();
    const key = trimmed.toUpperCase();
    if (trimmed && !seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  });
  return out;
}

// Normalize product images into a clean array of unique URLs.
// Accepts a real array (JSON) or a string with several URLs separated by
// commas, pipes or newlines (CSV/Excel bulk import), e.g.
// "https://a.jpg, https://b.jpg". Commas inside a URL's query string survive.
function toImages(value) {
  if (value === undefined || value === null || value === '') return [];
  const rawParts = (Array.isArray(value) ? value.flat(Infinity) : [value])
    .flatMap((v) => (v === undefined || v === null ? [] : String(v).split(/[,|\n]/)));
  const urls = [];
  rawParts.forEach((part) => {
    const t = part.trim();
    if (!t) return;
    // A fragment that doesn't start a new URL is a leftover from a comma
    // inside the previous URL (e.g. "?w=500,h=500") — glue it back on.
    if (urls.length && !/^(https?:\/\/|\/|data:)/i.test(t)) {
      urls[urls.length - 1] += ',' + t;
    } else {
      urls.push(t);
    }
  });
  return [...new Set(urls)];
}

function slugify(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function genSku(category) {
  return (
    String(category || 'PROD')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .substring(0, 6) +
    '-' +
    Math.random().toString(36).substring(2, 6).toUpperCase()
  );
}

// Build a clean Product document from a loose request/import payload.
// Throws an Error with a clear message when required fields are missing.
function buildProductDoc(body = {}) {
  const name = (body.name ?? '').toString().trim();
  const category = (body.category ?? '').toString().trim();
  // `image` may hold several comma-separated URLs (bulk CSV import) and/or an
  // `images` array (JSON). First URL = main image, full list = gallery.
  const imageList = toImages([body.image, body.images]);
  const image = imageList[0] || '';
  const price = toNum(body.price);

  const missing = [];
  if (!name) missing.push('name');
  if (!category) missing.push('category');
  if (price === undefined) missing.push('price');
  if (!image) missing.push('image');
  if (missing.length) {
    throw new Error(`Missing/invalid required field(s): ${missing.join(', ')}`);
  }

  // oldPrice and originalPrice are kept in sync so the storefront (which reads
  // originalPrice) always shows the strike-through compare-at price.
  const oldPrice = toNum(body.oldPrice ?? body.originalPrice);

  return {
    name,
    slug: (body.slug && String(body.slug).trim()) || slugify(name),
    sku: (body.sku && String(body.sku).trim()) || genSku(category),
    description: (body.description ?? '').toString(),
    image,
    images: imageList,
    price,
    oldPrice,
    originalPrice: oldPrice,
    category,
    stock: toNum(body.stock, 100),
    inStock: toBool(body.inStock, true),
    isSale: toBool(body.isSale, false),
    sizes: toSizes(body.sizes),
    tags: Array.isArray(body.tags) ? body.tags : (body.tags ? [body.tags] : []),
  };
}

// ---- Controllers ---------------------------------------------------------

export async function createProduct(req,res){
  try {
    const doc = buildProductDoc(req.body || {});
    const created = await Product.create(doc);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateProduct(req,res){
  const body = req.body || {};
  const prod = await Product.findById(req.params.id);
  if(!prod) return res.status(404).json({message:'Not found'});

  // Only overwrite fields that were actually provided in the request so a
  // partial update never wipes existing data, but booleans (false) DO apply.
  if ('name' in body && body.name != null) prod.name = String(body.name);
  if ('slug' in body && body.slug) prod.slug = String(body.slug);
  if ('sku' in body && body.sku) prod.sku = String(body.sku);
  if ('description' in body) prod.description = String(body.description ?? '');
  // Images may arrive as an array (admin form / JSON) or a comma-separated
  // string. The full list replaces the gallery; its first URL is the main image.
  if ('image' in body || 'images' in body) {
    const imgs = toImages([body.image, body.images]);
    if (imgs.length) {
      prod.image = imgs[0];
      prod.images = imgs;
    }
  }
  if ('category' in body && body.category) prod.category = String(body.category);

  const price = toNum(body.price);
  if (price !== undefined) prod.price = price;

  if ('oldPrice' in body || 'originalPrice' in body) {
    const oldPrice = toNum(body.oldPrice ?? body.originalPrice, 0) || 0;
    prod.oldPrice = oldPrice;
    prod.originalPrice = oldPrice; // keep storefront strike-through in sync
  }

  const stock = toNum(body.stock);
  if (stock !== undefined) prod.stock = stock;

  if ('inStock' in body) prod.inStock = toBool(body.inStock, prod.inStock);
  if ('isSale' in body) prod.isSale = toBool(body.isSale, prod.isSale);
  if ('sizes' in body) prod.sizes = toSizes(body.sizes);
  if ('tags' in body && Array.isArray(body.tags)) prod.tags = body.tags;

  await prod.save();
  res.json(prod);
}

// Bulk import — accepts an array of products (or { products: [...] }).
// Valid rows are inserted; invalid rows are reported back without aborting the batch.
export async function bulkCreateProducts(req, res) {
  const payload = Array.isArray(req.body) ? req.body : (req.body?.products || []);
  if (!Array.isArray(payload) || payload.length === 0) {
    return res.status(400).json({ message: 'Provide a non-empty array of products' });
  }

  const docs = [];
  const errors = [];
  payload.forEach((raw, index) => {
    try {
      docs.push(buildProductDoc(raw));
    } catch (err) {
      // row is 1-based for human-friendly messages
      errors.push({ row: index + 1, name: raw?.name || '', message: err.message });
    }
  });

  let inserted = [];
  if (docs.length) {
    // ordered:false keeps inserting the rest even if one row fails at the DB level
    inserted = await Product.insertMany(docs, { ordered: false }).catch((err) => {
      if (err?.insertedDocs) return err.insertedDocs; // partial success
      throw err;
    });
  }

  res.status(errors.length && !inserted.length ? 400 : 201).json({
    importedCount: inserted.length,
    failedCount: errors.length,
    errors,
    items: inserted,
  });
}

export async function deleteProduct(req,res){
  try {
    const { id } = req.params;
    if (!isObjectId(id)) return res.status(400).json({ message: 'Invalid product id' });
    await Product.findByIdAndDelete(id);
    // Take the product out of every bag, wishlist and history too. A leftover id
    // in a bag made checkout fail ("Cannot read properties of null (reading '_id')").
    await User.updateMany(
      { $or: [{ 'cart.product': id }, { favorites: id }, { recentlyViewed: id }] },
      { $pull: { cart: { product: id }, favorites: id, recentlyViewed: id } }
    );
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('deleteProduct error:', err);
    res.status(500).json({ message: 'Failed to delete product' });
  }
}
