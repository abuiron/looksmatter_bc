// src/config/db.js
import mongoose from 'mongoose';

// The order service connects to its own database (MONGO_DB, e.g. looksmatter_orders).
// No other service reads or writes it; they ask this service over HTTP instead.
export async function connectDB(uri = process.env.MONGO_URI, dbName = process.env.MONGO_DB) {
  try {
    await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 10000,
      autoIndex: true,
    });
    console.log(`✅ MongoDB connected (db: ${dbName})`);
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    throw err;
  }

  mongoose.connection.on('error', (e) => console.error('Mongo connection error:', e));
  mongoose.connection.on('disconnected', () => console.warn('Mongo disconnected'));
}
