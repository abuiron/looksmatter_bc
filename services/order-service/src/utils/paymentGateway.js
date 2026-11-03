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
    console.error('Decryption failed:', error);
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

    console.log('=== PaymentGateway Payment Request ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('Encrypted Body:', encryptedBody.substring(0, 100) + '...');
    console.log('Checksum:', checksum);
    console.log('API URL:', PaymentGateway_API_URL);
    console.log('Client ID:', PaymentGateway_CLIENT_ID);
    console.log('================================');

    // Make API call to PaymentGateway
    const response = await fetch(PaymentGateway_API_URL, {
      method: 'POST',
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
    
    // Log the response for debugging
    console.log('PaymentGateway API Response:', JSON.stringify(responseData, null, 2));
    console.log('Response status:', response.status);

    if (!response.ok) {
      throw new Error(`PaymentGateway API error: ${response.status} - ${JSON.stringify(responseData)}`);
    }

    if (!responseData.data) {
      console.error('Invalid PaymentGateway response - missing data field:', responseData);
      throw new Error('Invalid response from PaymentGateway');
    }

    // Decrypt the response
    const decryptedResponse = decryptAES(responseData.data, PaymentGateway_ENCRYPTION_KEY);
    if (!decryptedResponse) {
      throw new Error('Failed to decrypt PaymentGateway response');
    }

    const paymentData = JSON.parse(decryptedResponse);

    return {
      success: true,
      PaymentGatewayOrderId: payload.orderId,
      txnRefId: paymentData.txnRefId,
      paymentUrl: paymentData.paymentUrl,
      orderId: paymentData.orderId,
      amount: payload.amount
    };
  } catch (error) {
    console.error('PaymentGateway payment initiation error:', error);
    return {
      success: false,
      error: error.message
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

    console.log('=== PaymentGateway Status Check Request ===');
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('Using Status API:', PaymentGateway_STATUS_API_URL);
    console.log('======================================');

    // Make API call to PaymentGateway status check endpoint
    const response = await fetch(PaymentGateway_STATUS_API_URL, {
      method: 'POST',
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
    
    console.log('PaymentGateway Status Response:', JSON.stringify(responseData, null, 2));

    if (!response.ok || !responseData.data) {
      console.error('Invalid status check response:', responseData);
      return {
        success: false,
        status: 'pending',
        error: responseData.message || 'Failed to check payment status'
      };
    }

    // Decrypt the response
    const decryptedResponse = decryptAES(responseData.data, PaymentGateway_ENCRYPTION_KEY);
    if (!decryptedResponse) {
      throw new Error('Failed to decrypt PaymentGateway status response');
    }

    const statusData = JSON.parse(decryptedResponse);
    console.log('Decrypted Status:', statusData);

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

    console.log('Status Mapping:', rawStatus, '->', mappedStatus);

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
    console.error('Payment status check error:', error);
    return {
      success: false,
      status: 'pending',
      error: error.message
    };
  }
}

export default {
  initiatePayment,
  checkPaymentStatus,
  decryptAES,
  getChecksum
};
