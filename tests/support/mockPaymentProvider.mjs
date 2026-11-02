// A stand-in for the UPI payment provider, so payments can be tested end to end without
// real money or real credentials. It checks the client headers and checksum, decrypts
// requests, and answers in the same encrypted format as the real provider.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { checksum, decrypt, encrypt } from './providerCrypto.mjs';

export function startMockPaymentProvider({ port, clientId, secretKey, encryptionKey }) {
  const transactions = new Map(); // txnRefId -> { merchantOrderId, amount, status }
  const initiations = []; // decrypted /initiate payloads, newest last
  const statusQueries = []; // decrypted /status payloads, newest last

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.headers['client-id'] !== clientId || req.headers['secret-key'] !== secretKey) {
          return reply(401, { message: 'bad client credentials' });
        }
        const { encryptedBody, checksum: sum } = JSON.parse(raw || '{}');
        if (!encryptedBody || sum !== checksum(encryptedBody, encryptionKey)) {
          return reply(400, { message: 'bad checksum' });
        }
        const payload = decrypt(encryptedBody, encryptionKey);

        if (req.url === '/initiate') {
          initiations.push(payload);
          const txnRefId = `TXN${randomBytes(6).toString('hex')}`;
          transactions.set(txnRefId, { merchantOrderId: payload.orderId, amount: payload.amount, status: 'PENDING' });
          return reply(200, {
            data: encrypt(
              { txnRefId, orderId: payload.orderId, paymentUrl: `upi://pay?pa=looksmatter@upi&am=${payload.amount}&tr=${txnRefId}` },
              encryptionKey
            ),
          });
        }

        if (req.url === '/status') {
          statusQueries.push(payload);
          const txn = transactions.get(payload.txnRefId);
          if (!txn) return reply(404, { message: 'unknown transaction' });
          return reply(200, {
            data: encrypt(
              { status: txn.status, orderId: txn.merchantOrderId, txnRefId: payload.txnRefId, amount: txn.amount, payerVpa: 'shopper@upi', utr: '123456789012' },
              encryptionKey
            ),
          });
        }

        reply(404, { message: 'not found' });
      } catch (err) {
        reply(500, { message: err.message });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${port}`,
        transactions,
        initiations,
        statusQueries,
        setStatus: (txnRefId, status) => {
          transactions.get(txnRefId).status = status;
        },
        close: () => new Promise((done) => server.close(done)),
      })
    );
  });
}
