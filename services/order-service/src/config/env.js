// Loads this service's .env and stops at startup when a required setting is missing,
// instead of failing later on the first request that needs it. server.js imports this
// module first, so every other module sees the final process.env.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const REQUIRED = ['MONGO_URI', 'MONGO_DB', 'JWT_SECRET', 'INTERNAL_API_KEY', 'CORE_SERVICE_URL'];
const missing = REQUIRED.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`❌ order-service: missing environment variables: ${missing.join(', ')} (see .env.example)`);
  process.exit(1);
}

const PAYMENT_VARS = [
  'PaymentGateway_CLIENT_ID',
  'PaymentGateway_SECRET_KEY',
  'PaymentGateway_ENCRYPTION_KEY',
  'PaymentGateway_API_URL',
  'PaymentGateway_STATUS_API_URL',
];
const missingPayment = PAYMENT_VARS.filter((name) => !process.env[name]);
if (missingPayment.length) {
  console.warn(`⚠️  order-service: online payments are not configured (missing ${missingPayment.join(', ')}). Cash on delivery still works.`);
}
