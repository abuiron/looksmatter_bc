// Gateway settings, read once at startup from gateway/.env (or the environment).
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const missing = ['CORE_SERVICE_URL', 'ORDER_SERVICE_URL'].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`❌ gateway: missing environment variables: ${missing.join(', ')} (see .env.example)`);
  process.exit(1);
}

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'https://looksmatter.in',
  'https://www.looksmatter.in',
  'https://looksmatter.netlify.app',
];

export const config = {
  port: Number(process.env.PORT) || 5000,
  services: {
    core: process.env.CORE_SERVICE_URL,
    orders: process.env.ORDER_SERVICE_URL,
  },
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ORIGINS,
  // How long to wait for a service to answer before giving the client a 504.
  proxyTimeoutMs: Number(process.env.PROXY_TIMEOUT_MS) || 30000,
};
