import { config } from './config.js'; // first: loads .env and checks required settings
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { randomUUID } from 'crypto';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { buildRoutes } from './routes.js';

// The API gateway is the only public entry point. Browsers, the storefront and the
// payment provider's webhooks all call it; it forwards each request to the service
// that owns that part of the API. It holds no business logic and no database.
const app = express();
app.disable('x-powered-by');

// 1. Request id: created here (or kept from the client when well-formed) and passed to
//    every service, which logs it and forwards it on its own service-to-service calls.
app.use((req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);
  next();
});

// 2. CORS for the whole API, in one place.
app.use(cors({
  origin: config.corsOrigins,
  credentials: false,
  exposedHeaders: ['ETag', 'X-Request-Id'],
}));

// 3. One access-log line per request, with the service that answered it.
morgan.token('id', (req) => req.id);
morgan.token('service', (req) => req.service || 'gateway');
app.use(morgan(':id :method :url -> :service :status :response-time ms'));

// Liveness: the same answer the monolith gave on "/", so existing uptime checks keep working.
app.get('/', (_, res) => res.send('API running successfully'));

// Health of the whole system: the gateway asks every service.
const SERVICES = [
  { name: 'core-service', url: config.services.core },
  { name: 'order-service', url: config.services.orders },
];
app.get('/health', async (req, res) => {
  const results = await Promise.all(
    SERVICES.map(async ({ name, url }) => {
      try {
        const response = await fetch(`${url}/health`, {
          headers: { 'X-Request-Id': req.id },
          signal: AbortSignal.timeout(3000),
        });
        return [name, response.ok ? 'up' : 'down'];
      } catch {
        return [name, 'down'];
      }
    })
  );
  const services = Object.fromEntries(results);
  const healthy = Object.values(services).every((status) => status === 'up');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', gateway: 'up', services });
});

// 4. Proxies. The gateway never parses request bodies: they are streamed to the
//    service untouched, which is what keeps JSON and multipart uploads working.
for (const route of buildRoutes(config.services)) {
  app.use(createProxyMiddleware({
    target: route.target,
    changeOrigin: true, // set Host to the service's host (needed by most hosting platforms)
    xfwd: true, // add X-Forwarded-For/-Proto/-Host so services see the real client
    proxyTimeout: config.proxyTimeoutMs,
    pathFilter: (pathname) => route.match(pathname),
    ...(route.rewrite && { pathRewrite: (url) => route.rewrite(url) }),
    on: {
      proxyReq: (proxyReq, req) => {
        req.service = route.service;
        proxyReq.setHeader('X-Request-Id', req.id);
        // Only services hold the internal key; never pass one along from outside.
        proxyReq.removeHeader('X-Internal-Api-Key');
      },
      error: (err, req, res) => {
        req.service = route.service;
        console.error(`[${req.id}] ${route.service} did not answer ${req.method} ${req.url}: ${err.code || err.message}`);
        if (!res || typeof res.writeHead !== 'function') return res?.destroy?.(); // a raw socket
        if (res.headersSent) return res.end();
        const timedOut = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(err.code);
        res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          message: timedOut
            ? `${route.service} did not respond in time. Please try again.`
            : `${route.service} is unavailable. Please try again shortly.`,
          service: route.service,
          requestId: req.id,
        }));
      },
    },
  }));
}

// Everything else, including /internal/*, stops here.
app.use((req, res) => {
  res.status(404).json({ message: 'Not found' });
});

const server = app.listen(config.port, () => {
  console.log(`🚪 gateway running on http://localhost:${config.port}`);
  console.log(`   core-service  → ${config.services.core}`);
  console.log(`   order-service → ${config.services.orders}`);
});

const shutdown = (sig) => {
  console.log(`${sig} received. Shutting down…`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
