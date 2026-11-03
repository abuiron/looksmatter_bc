import mongoose from 'mongoose';
import { initiatePayment, checkPaymentStatus, decryptAES, getChecksum } from '../utils/paymentGateway.js';
import { applyProviderStatus } from '../utils/paymentStatus.js';
import Order from '../models/Order.js';

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// A payment can be started for an order that is unpaid (including a failed earlier
// attempt) and hasn't been cancelled.
const canStartPayment = (order) =>
  ['pending', 'failed'].includes(order.paymentStatus) && order.status !== 'cancelled';

/**
 * POST /api/payment/initiate
 * Start a PaymentGateway payment for one of the shopper's own orders.
 *
 * The amount is always the order's server-calculated total. An `amount` in the request
 * body is ignored, so a modified browser can't pay less than the order costs.
 */
export async function initiatePaymentGatewayPayment(req, res) {
  try {
    const { orderId, firstName, lastName, email, phone, userIP } = req.body;

    if (!orderId || !phone) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    if (!isValidObjectId(orderId)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const order = await Order.findOne({ _id: orderId, user: req.user.id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (!canStartPayment(order)) {
      return res.status(409).json({
        message: `This order can't be paid for now (payment ${order.paymentStatus}, order ${order.status}).`,
      });
    }

    const [customerFirst, ...customerRest] = (order.customer?.name || '').split(' ');
    const paymentData = await initiatePayment({
      orderId: String(order._id),
      amount: order.total,
      firstName: firstName || customerFirst || 'Customer',
      lastName: lastName || customerRest.join(' ') || '',
      email: email || order.customer?.email || req.user.email || 'customer@example.com',
      phone,
      userIP: userIP || req.ip || '10.0.0.0',
      userId: req.user.id,
    });

    if (!paymentData.success) {
      return res.status(500).json({
        message: 'Failed to initiate payment',
        error: paymentData.error
      });
    }

    // Remember which provider transaction belongs to this order: webhooks and status
    // checks find the order through these ids. If this can't be saved, fail the request
    // instead of showing a QR code whose payment we couldn't match to the order.
    order.PaymentGatewayOrderId = paymentData.PaymentGatewayOrderId;
    order.paymentRefId = paymentData.txnRefId;
    order.qrCodeUrl = paymentData.paymentUrl; // shown again on the order page while payment is pending
    await order.save();
    console.log(`Updated order ${order._id} with PaymentGatewayOrderId: ${paymentData.PaymentGatewayOrderId}`);

    res.json(paymentData);
  } catch (error) {
    console.error('Payment initiation error:', error);
    res.status(500).json({
      message: 'Failed to initiate payment',
      error: error.message
    });
  }
}

/**
 * POST /api/payment/status
 * Ask the provider for the status of an order's payment, and record the answer.
 *
 * Only the shopper's own order is checked, and the provider is queried with the
 * transaction ids this service stored when the payment started, not ids from the
 * request body, so one payment can't be used to mark a different order as paid.
 */
export async function getPaymentStatus(req, res) {
  try {
    const { orderData = {} } = req.body;
    const { orderId } = orderData;

    if (!orderId || !isValidObjectId(orderId)) {
      return res.status(400).json({ message: 'Order id is required' });
    }

    const order = await Order.findOne({ _id: orderId, user: req.user.id });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (!order.paymentRefId) {
      return res.status(409).json({ message: 'No payment has been started for this order' });
    }

    const statusData = await checkPaymentStatus(order.paymentRefId, {
      ...orderData, // name, email, phone and IP as the shopper's browser sent them
      PaymentGatewayOrderId: order.PaymentGatewayOrderId,
      orderId: String(order._id),
      amount: order.total,
      userId: req.user.id,
    });

    if (statusData.success) {
      applyProviderStatus(
        order,
        statusData.status,
        { txnRefId: statusData.txnRefId, gatewayOrderId: statusData.orderId, payerVpa: statusData.payerVpa },
        `status check ${req.id}`
      );
      await order.save();
    }

    res.json(statusData);
  } catch (error) {
    console.error('Payment status check error:', error);
    res.status(500).json({
      message: 'Failed to check payment status',
      error: error.message
    });
  }
}

/**
 * POST /api/payment/webhook
 * Handle PaymentGateway webhook for payment status updates
 */
export async function PaymentGatewayWebhook(req, res) {
  try {
    console.log('=== PaymentGateway Webhook Received ===');

    // PaymentGateway sends 'encryptedData' (without checksum in webhook)
    const encryptedBody = req.body.encryptedData || req.body.encryptedBody;

    if (!encryptedBody) {
      console.error('Missing encryptedData/encryptedBody in webhook');
      return res.status(400).json({ message: 'Invalid webhook payload' });
    }

    // PaymentGateway webhook doesn't include checksum, only encryptedData
    // Verify checksum only if provided (for payment initiation responses)
    if (req.body.checksum) {
      const calculatedChecksum = getChecksum(encryptedBody, process.env.PaymentGateway_ENCRYPTION_KEY);
      if (req.body.checksum !== calculatedChecksum) {
        console.error('Checksum mismatch:', { received: req.body.checksum, calculated: calculatedChecksum });
        return res.status(400).json({ message: 'Invalid checksum' });
      }
      console.log('Checksum verified ✓');
    } else {
      console.log('No checksum in webhook (expected for PaymentGateway callbacks)');
    }

    // Decrypt the webhook data
    const decryptedData = decryptAES(encryptedBody, process.env.PaymentGateway_ENCRYPTION_KEY);
    if (!decryptedData) {
      console.error('Failed to decrypt webhook data');
      return res.status(400).json({ message: 'Failed to decrypt webhook data' });
    }

    const webhookData = JSON.parse(decryptedData);
    console.log('Decrypted Webhook Data:', JSON.stringify(webhookData, null, 2));

    // PaymentGateway uses different field names: transactionRefId instead of txnRefId
    const txnRefId = webhookData.transactionRefId || webhookData.txnRefId;

    // Find order by PaymentGateway order ID (merchant transaction ID with 'ssai' prefix)
    let order = await Order.findOne({ PaymentGatewayOrderId: webhookData.orderId });

    // Fallback: try finding by txnRefId if not found by PaymentGatewayOrderId
    if (!order && txnRefId) {
      order = await Order.findOne({ paymentRefId: txnRefId });
    }

    if (!order) {
      console.error('Order not found for PaymentGateway orderId:', webhookData.orderId, 'txnRefId:', txnRefId);
      // Still return 200 to prevent PaymentGateway retries
      return res.json({ message: 'Order not found', orderId: webhookData.orderId });
    }

    // Repeated and out-of-order webhooks are expected; applyProviderStatus only makes
    // changes that are valid from the order's current payment status.
    applyProviderStatus(
      order,
      webhookData.status,
      { txnRefId, gatewayOrderId: webhookData.orderId, payerVpa: webhookData.payerVpa },
      `webhook ${req.id}`
    );
    await order.save();

    res.json({
      message: 'Webhook processed successfully',
      orderId: order._id,
      status: order.paymentStatus
    });
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Still return 200 to prevent PaymentGateway retries
    res.json({ message: 'Webhook received but failed to process', error: error.message });
  }
}
