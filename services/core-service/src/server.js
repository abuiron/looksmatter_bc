import './config/env.js'; // first: loads .env and checks required settings
import express from 'express';
import mongoose from 'mongoose';
import morgan from 'morgan';

import { connectDB } from './config/db.js';
import { UPLOAD_DIR } from './config/paths.js';
import { requestId } from './middleware/requestId.js';
import { requireInternalKey } from './middleware/internalAuth.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import userRoutes from './routes/users.js';
import uploadRoutes from './routes/upload.js';
import reportRoutes from './routes/reports.js';
import internalRoutes from './routes/internal.js';

const app = express();

// Requests arrive through the API gateway, which adds X-Forwarded-For. Trust it when
// it is on a private network, so req.ip is the client's address.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

// CORS is handled once, at the API gateway: browsers only ever talk to the gateway.
app.use(requestId);
app.use(express.json({ limit: '2mb' }));
morgan.token('id', (req) => req.id);
app.use(morgan(':id :method :url :status :response-time ms'));

// Static
app.use('/uploads', express.static(UPLOAD_DIR));

// Health: used by the gateway's /health and by Docker/hosting health checks.
app.get('/health', (_, res) => {
  const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
  res.status(db === 'up' ? 200 : 503).json({ service: 'core-service', status: db === 'up' ? 'ok' : 'degraded', db });
});

// Public routes (reached through the gateway). Orders and payments moved to order-service.
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/reports', reportRoutes);

// Service-to-service routes (never routed by the gateway)
app.use('/internal', requireInternalKey, internalRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Errors
app.use((err, req, res, next) => {
  console.error(`[${req.id}]`, err);
  const code = err.status || 500;
  res.status(code).json({ message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5001;

let server;
(async () => {
  try {
    await connectDB();
    server = app.listen(PORT, () => {
      console.log(`🚀 core-service running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start core-service due to DB connection error:', err.message);
    process.exit(1);
  }
})();

const shutdown = (sig) => {
  console.log(`${sig} received. Shutting down…`);
  if (server) {
    server.close(async () => {
      await mongoose.connection.close();
      console.log('HTTP server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
