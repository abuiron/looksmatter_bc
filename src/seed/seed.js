// src/seed/seed.js
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import mongoose from 'mongoose';

import Product from '../models/Product.js';
import User from '../models/User.js';
import { connectDB } from '../config/db.js';

// --- Always load the root .env (project root), not the current working dir ---
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Load products from frontend
function loadFrontendProducts() {
  try {
    const productsPath = path.resolve(__dirname, '../../../looksmatter_ui/src/data/products.json');
    const productsData = readFileSync(productsPath, 'utf-8');
    const products = JSON.parse(productsData);
    
    // Map frontend products to backend schema
    return products.map(p => ({
      name: p.name,
      slug: p.slug,
      description: p.description,
      image: p.image,
      images: p.images || [p.image],
      price: p.price,
      oldPrice: p.originalPrice,
      originalPrice: p.originalPrice,
      category: p.category,
      stock: p.inStock ? 100 : 0,
      inStock: p.inStock,
      isSale: p.isSale,
      sku: p.sku,
      tags: [p.category.toLowerCase(), p.sku]
    }));
  } catch (err) {
    console.error('Error loading frontend products:', err.message);
    return [];
  }
}

async function run() {
  // Let connectDB read MONGO_URI and MONGO_DB from the now-loaded .env
  await connectDB();

  try {
    console.log('🧹 Clearing collections...');
    await Product.deleteMany({});
    await User.deleteMany({});

    console.log('🌱 Inserting products from frontend...');
    const products = loadFrontendProducts();
    if (products.length > 0) {
      await Product.insertMany(products);
      console.log(`✅ Inserted ${products.length} products from frontend`);
    } else {
      console.log('⚠️ No products loaded from frontend');
    }

    console.log('👤 Creating admin & sample user...');
    const admin = new User({
      name: 'Admin',
      email: process.env.ADMIN_EMAIL ,
      password: process.env.ADMIN_PASSWORD ,
      role: 'admin',
    });
    await admin.save();
    console.log('✅ Admin created:', admin.email);

    const user = new User({
      name: 'Sample User',
      email: 'user@example.com',
      password: 'password',
      role: 'user',
    });
    await user.save();
    console.log('✅ Sample user created:', user.email);
  } finally {
    await mongoose.connection.close();
    console.log('🌱 Seeding completed & Mongo connection closed.');
  }
}

run().catch((e) => {
  console.error('❌ Seeding failed:', e);
  process.exit(1);
});
