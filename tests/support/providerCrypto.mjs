// The payment provider's wire format, implemented with Node's built-in crypto. It must
// stay byte-compatible with services/order-service/src/utils/paymentGateway.js
// (CryptoJS): AES-256-CBC with a SHA-256-derived key, fixed IV, PKCS7 padding, base64
// output, and an HMAC-SHA256 hex checksum over the encrypted body.
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

const IV = Buffer.from('1234567890123456', 'utf8');
const aesKey = (key) => Buffer.from(createHash('sha256').update(key).digest('hex').slice(0, 32), 'utf8');

export function encrypt(payload, key) {
  const cipher = createCipheriv('aes-256-cbc', aesKey(key), IV);
  return Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]).toString('base64');
}

export function decrypt(encrypted, key) {
  const decipher = createDecipheriv('aes-256-cbc', aesKey(key), IV);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8'));
}

export const checksum = (encryptedBody, key) => createHmac('sha256', key).update(encryptedBody).digest('hex');
