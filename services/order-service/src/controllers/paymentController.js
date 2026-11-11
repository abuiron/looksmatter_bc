import { timingSafeEqual } from 'node:crypto';
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
      message: 'Failed to initiate payment'
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

    const statusData = await verifyAndRecord(order, req.id);
    res.json(statusData);
  } catch (error) {
    console.error('Payment status check error:', error);
    res.status(503).json({ message: 'Payment status could not be verified. Try again shortly.' });
  }
}

/**
 * POST /api/payment/webhook
 * Handle PaymentGateway webhook for payment status updates
 */
export async function PaymentGatewayWebhook(req, res) {
  const encrypted = req.body?.encryptedData || req.body?.encryptedBody;
  const key = process.env.PaymentGateway_ENCRYPTION_KEY;
  if (!key) return res.status(503).json({ message: 'Payments are unavailable' });
  if (typeof encrypted !== 'string' || !encrypted) return res.status(400).json({ message: 'Invalid webhook payload' });
  if (req.body.checksum !== undefined) {
    const sum = req.body.checksum;
    if (typeof sum !== 'string' || !/^[a-f0-9]{64}$/i.test(sum) ||
        !timingSafeEqual(Buffer.from(sum, 'hex'), Buffer.from(getChecksum(encrypted, key), 'hex'))) {
      return res.status(400).json({ message: 'Invalid checksum' });
    }
  }

  let event;
  try { event = JSON.parse(decryptAES(encrypted, key)); } catch { /* invalid callback */ }
  const merchant = event?.orderId;
  const txn = event?.transactionRefId ?? event?.txnRefId;
  const validId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
  if ((!merchant && !txn) || (merchant !== undefined && !validId(merchant)) ||
      (txn !== undefined && !validId(txn))) {
    return res.status(400).json({ message: 'Invalid payment references' });
  }
  try {
    const order = await Order.findOne({
      ...(merchant && { PaymentGatewayOrderId: merchant }), ...(txn && { paymentRefId: txn }),
    });
    if (!order) return res.status(200).json({ message: 'Unknown transaction' });
    await verifyAndRecord(order, req.id);
    return res.json({ message: 'Webhook processed successfully', orderId: order._id, status: order.paymentStatus });
  } catch {
    console.warn(`[${req.id}] Payment callback could not be verified or recorded`);
    return res.status(503).json({ message: 'Payment verification unavailable' });
  }
}

// Callbacks can be unsigned. Treat them only as a prompt to check the stored transaction.
async function verifyAndRecord(order, requestId) {
  if (!order.paymentRefId || !order.PaymentGatewayOrderId) throw new Error('Missing transaction');
  const result = await checkPaymentStatus(order.paymentRefId, {
    PaymentGatewayOrderId: order.PaymentGatewayOrderId, amount: Math.round(order.total * 100) / 100,
    userId: String(order.user), firstName: order.shippingAddress?.firstName,
    lastName: order.shippingAddress?.lastName, email: order.customer?.email, phone: order.shippingAddress?.phone,
  });
  const amount = result.amount;
  const validAmount = (typeof amount === 'number' || typeof amount === 'string') &&
    /^\d+(?:\.\d{1,2})?$/.test(String(amount)) && Number(amount) > 0;
  if (!result.success || result.txnRefId !== order.paymentRefId || result.orderId !== order.PaymentGatewayOrderId ||
      !validAmount || Math.round(Number(amount) * 100) !== Math.round(order.total * 100)) {
    throw new Error('Provider response did not match the order');
  }
  const previous = { status: order.status, paymentStatus: order.paymentStatus,
    paymentRefId: order.paymentRefId, PaymentGatewayOrderId: order.PaymentGatewayOrderId };
  applyProviderStatus(order, result.status, { payerVpa: result.payerVpa }, requestId);
  if (order.isModified()) {
    order.$where = previous; // A concurrent fulfilment/payment change must not be overwritten.
    await order.save();
  }
  return result;
}
