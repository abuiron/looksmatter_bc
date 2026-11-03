import './config/env.js'; // first: loads .env and checks required settings
import express from 'express';
import mongoose from 'mongoose';
import morgan from 'morgan';

import { connectDB } from './config/db.js';
import { requestId } from './middleware/requestId.js';
import { requireInternalKey } from './middleware/internalAuth.js';
import orderRoutes from './routes/orders.js';
import paymentRoutes from './routes/payment.js';
import internalRoutes from './routes/internal.js';

const app = express();

// Requests arrive through the API gateway, which adds X-Forwarded-For. Trust it when
// it is on a private network, so req.ip is the shopper's address (sent to the payment provider).
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

app.use(requestId);
app.use(express.json({ limit: '2mb' }));
morgan.token('id', (req) => req.id);
app.use(morgan(':id :method :url :status :response-time ms'));

// Health: used by the gateway's /health and by Docker/hosting health checks.
app.get('/health', (_, res) => {
  const db = mongoose.connection.readyState === 1 ? 'up' : 'down';
  res.status(db === 'up' ? 200 : 503).json({ service: 'order-service', status: db === 'up' ? 'ok' : 'degraded', db });
});

// Public routes (reached through the gateway)
app.use('/api/orders', orderRoutes);
app.use('/api/payment', paymentRoutes);

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

const PORT = process.env.PORT || 5002;

let server;
(async () => {
  try {
    await connectDB();
    server = app.listen(PORT, () => {
      console.log(`🚀 order-service running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Failed to start order-service due to DB connection error:', err.message);
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
