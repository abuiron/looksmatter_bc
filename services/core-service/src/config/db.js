// src/config/db.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve the project root .env no matter where node is launched from
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export async function connectDB(passedUri) {
  const uri    = passedUri || process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB ;

  if (!uri) {
    throw new Error('MONGO_URI is not set. Put it in your .env file.');
  }

  try {
    await mongoose.connect(uri, {
      dbName,
      // Mongoose 7 uses modern defaults; add timeouts for clearer failures:
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
