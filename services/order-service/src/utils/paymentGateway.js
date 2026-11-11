import CryptoJS from 'crypto-js';

// PaymentGateway credentials from environment
const PaymentGateway_CLIENT_ID = process.env.PaymentGateway_CLIENT_ID ;
const PaymentGateway_SECRET_KEY = process.env.PaymentGateway_SECRET_KEY ;
const PaymentGateway_ENCRYPTION_KEY = process.env.PaymentGateway_ENCRYPTION_KEY;
const PaymentGateway_API_URL = process.env.PaymentGateway_API_URL ;
const PaymentGateway_STATUS_API_URL = process.env.PaymentGateway_STATUS_API_URL ;

const IV = '1234567890123456';

/**
 * Derive AES key from secret key
 */
function deriveKey(key) {
  return CryptoJS.SHA256(key).toString(CryptoJS.enc.Hex).slice(0, 32);
}

/**
 * Encrypt payload using AES-256-CBC
 */
function systemEncryption(data, key) {
  const aesKey = CryptoJS.enc.Utf8.parse(deriveKey(key));
  const ivHex = CryptoJS.enc.Utf8.parse(IV);
  const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), aesKey, {
    iv: ivHex,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7
  });
  return encrypted.toString();
}

/**
 * Generate checksum for encrypted body
 */
export function getChecksum(encryptedBody, key) {
  return CryptoJS.HmacSHA256(encryptedBody, key).toString(CryptoJS.enc.Hex);
}

/**
 * Decrypt AES encrypted data
 */
export function decryptAES(encryptedData, key) {
  try {
    const aesKey = deriveKey(key);
    const decrypted = CryptoJS.AES.decrypt(
      encryptedData,
      CryptoJS.enc.Utf8.parse(aesKey),
      {
        iv: CryptoJS.enc.Utf8.parse(IV),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    return null;
  }
}

/**
 * Generate alphanumeric order ID with 'ssai' prefix
 */
function generateOrderId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let orderId = 'ssai';
  for (let i = 0; i < 9; i++) {
    const randomIndex = Math.floor(Math.random() * chars.length);
    orderId += chars[randomIndex];
  }
  return orderId;
}

/**
 * Initiate PaymentGateway payment intent
 */
export async function initiatePayment(orderData) {
  try {
    // Ensure amount is at least 1 rupee and round to 2 decimal places
    let amount = parseFloat(orderData.amount);
    if (amount < 1) {
      amount = 1;
    }
    // Round to 2 decimal places to avoid precision issues
    amount = Math.round(amount * 100) / 100;
    
    const payload = {
      orderId: generateOrderId(),
      amount: amount,
      firstName: orderData.firstName || 'Customer',
      lastName: orderData.lastName || 'User', // Default to 'User' if empty
      email: orderData.email || 'customer@example.com',
      phone: orderData.phone,
      userIP: orderData.userIP || '10.0.0.0',
      userId: orderData.userId,
      callbackUrl: process.env.PaymentGateway_CALLBACK_URL 
    };

    // Encrypt the payload
    const encryptedBody = systemEncryption(payload, PaymentGateway_ENCRYPTION_KEY);
    const checksum = getChecksum(encryptedBody, PaymentGateway_ENCRYPTION_KEY);


    // Make API call to PaymentGateway
    const response = await fetch(PaymentGateway_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: {
        'client-id': PaymentGateway_CLIENT_ID,
        'secret-key': PaymentGateway_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        checksum,
        encryptedBody
      })
    });

    const responseData = await response.json();
    

    if (!response.ok) {
      throw new Error(`PaymentGateway API error: ${response.status}`);
    }

    if (!responseData.data) {
      throw new Error('Invalid response from PaymentGateway');
    }

    // Decrypt the response
    const decryptedResponse = decryptAES(responseData.data, PaymentGateway_ENCRYPTION_KEY);
    if (!decryptedResponse) {
      throw new Error('Failed to decrypt PaymentGateway response');
    }

    const paymentData = JSON.parse(decryptedResponse);
    if (!paymentData || typeof paymentData.txnRefId !== 'string' || !paymentData.txnRefId ||
        typeof paymentData.paymentUrl !== 'string' || !paymentData.paymentUrl ||
        (paymentData.orderId != null && paymentData.orderId !== payload.orderId)) {
      throw new Error('Invalid payment intent');
    }

    return {
      success: true,
      PaymentGatewayOrderId: payload.orderId,
      txnRefId: paymentData.txnRefId,
      paymentUrl: paymentData.paymentUrl,
      orderId: paymentData.orderId,
      amount: payload.amount
    };
  } catch (error) {
    return {
      success: false,
      error: 'Payment provider request failed'
    };
  }
}

/**
 * Check payment status
 */
export async function checkPaymentStatus(txnRefId, orderData = {}) {
  try {
    // PaymentGateway requires the PaymentGatewayOrderId (merchant order ID with 'ssai' prefix)
    const payload = {
      orderId: orderData.PaymentGatewayOrderId || orderData.orderId || 'status-check',
      amount: parseFloat(orderData.amount) || 100,
      firstName: orderData.firstName || 'Customer',
      lastName: orderData.lastName || 'User',
      email: orderData.email || 'customer@example.com',
      phone: orderData.phone || '9999999999',
      userIP: orderData.userIP || '10.0.0.0',
      userId: orderData.userId || 'guest',
      txnRefId: txnRefId
    };

    // Encrypt the payload
    const encryptedBody = systemEncryption(payload, PaymentGateway_ENCRYPTION_KEY);
    const checksum = getChecksum(encryptedBody, PaymentGateway_ENCRYPTION_KEY);


    // Make API call to PaymentGateway status check endpoint
    const response = await fetch(PaymentGateway_STATUS_API_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      redirect: 'error',
      headers: {
        'client-id': PaymentGateway_CLIENT_ID,
        'secret-key': PaymentGateway_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        checksum,
        encryptedBody
      })
    });

    const responseData = await response.json();
    

    if (!response.ok || !responseData.data) {
      return {
        success: false,
        status: 'pending',
        error: 'Failed to check payment status'
      };
    }

    // Decrypt the response
    const decryptedResponse = decryptAES(responseData.data, PaymentGateway_ENCRYPTION_KEY);
    if (!decryptedResponse) {
      throw new Error('Failed to decrypt PaymentGateway status response');
    }

    const statusData = JSON.parse(decryptedResponse);

    // Normalize status (handle cases like Cb_Refunded, Success, etc.)
    const rawStatus = statusData.status;
    const normalizedStatus = rawStatus?.toUpperCase().replace(/_/g, ''); // Remove underscores
    
    // Map to our standard status values
    let mappedStatus = rawStatus; // Keep original by default
    
    if (normalizedStatus === 'SUCCESS') {
      mappedStatus = 'SUCCESS';
    } else if (normalizedStatus === 'FAILED' || normalizedStatus === 'FAILURE') {
      mappedStatus = 'FAILED';
    } else if (normalizedStatus === 'TAMPERED') {
      mappedStatus = 'TAMPERED';
    } else if (normalizedStatus === 'REFUNDED' || normalizedStatus === 'CBREFUNDED') {
      mappedStatus = 'REFUNDED';
    } else if (normalizedStatus === 'INITIATED' || normalizedStatus === 'PENDING' || normalizedStatus === 'TRANSACTIONINPROGRESS') {
      mappedStatus = 'PENDING';
    } else if (normalizedStatus === 'HOLD' || normalizedStatus === 'ONHOLD') {
      mappedStatus = 'HOLD';
    }


    return {
      success: true,
      status: mappedStatus, // Use mapped status
      rawStatus: rawStatus, // Include original for debugging
      orderId: statusData.orderId,
      txnRefId: statusData.txnRefId,
      utr: statusData.utr,
      amount: statusData.amount,
      payerVpa: statusData.payerVpa
    };
  } catch (error) {
    return {
      success: false,
      status: 'pending',
      error: 'Payment provider request failed'
    };
  }
}

export default {
  initiatePayment,
  checkPaymentStatus,
  decryptAES,
  getChecksum
};
