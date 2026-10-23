import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import userRoutes from './routes/users.js';
import orderRoutes from './routes/orders.js';
import uploadRoutes from './routes/upload.js';
import paymentRoutes from './routes/payment.js';
import reportRoutes from './routes/reports.js';

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// CORS (allow Vite dev server)
app.use(cors({
  origin: ['https://looksmatter.netlify.app', 'https://looksmatter.in', 'http://localhost:5173'],
  credentials: false,
  exposedHeaders: ['ETag'],
}));

app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Static
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// Health
app.get('/', (_, res) => res.send('API running successfully'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/reports', reportRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Errors
app.use((err, req, res, next) => {
  console.error(err);
  const code = err.status || 500;
  res.status(code).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;

let server;
(async () => {
  try {
    await connectDB();
    server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      // console.log(`🚀 Server running successfully`);
    });
  } catch (err) {
    console.error('❌ Failed to start server due to DB connection error:', err.message);
    process.exit(1);
  }
})();

const shutdown = (sig) => {
  console.log(`${sig} received. Shutting down…`);
  if (server) {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
