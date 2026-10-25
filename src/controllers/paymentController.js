import { initiatePayment, checkPaymentStatus, decryptAES, getChecksum } from '../utils/paymentGateway.js';
import Order from '../models/Order.js';

/**
 * POST /api/payment/initiate
 * Initiate PaymentGateway payment
 */
export async function initiatePaymentGatewayPayment(req, res) {
  try {
    const { orderId, amount, firstName, lastName, email, phone, userIP } = req.body;

    if (!orderId || !amount || !phone) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const paymentData = await initiatePayment({
      orderId,
      amount,
      firstName: firstName || req.user?.name?.split(' ')[0] || 'Customer',
      lastName: lastName || req.user?.name?.split(' ').slice(1).join(' ') || '',
      email: email || req.user?.email || 'customer@example.com',
      phone,
      userIP: userIP || req.ip || '10.0.0.0',
      userId: req.user?.id || 'guest'
    });

    if (!paymentData.success) {
      return res.status(500).json({ 
        message: 'Failed to initiate payment',
        error: paymentData.error 
      });
    }

    // Update the order with PaymentGateway order ID and QR code URL
    try {
      await Order.findByIdAndUpdate(orderId, {
        PaymentGatewayOrderId: paymentData.PaymentGatewayOrderId,
        paymentRefId: paymentData.txnRefId,
        qrCodeUrl: paymentData.paymentUrl // Save QR code URL for pending payments
      });
      console.log(`Updated order ${orderId} with PaymentGatewayOrderId: ${paymentData.PaymentGatewayOrderId}`);
    } catch (updateError) {
      console.error('Failed to update order with PaymentGatewayOrderId:', updateError);
      // Don't fail the payment initiation if order update fails
    }

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
 * Check payment status and update order
 */
export async function getPaymentStatus(req, res) {
  try {
    const { txnRefId, orderData } = req.body;

    if (!txnRefId) {
      return res.status(400).json({ message: 'Transaction reference ID is required' });
    }

    const statusData = await checkPaymentStatus(txnRefId, orderData);

    // If status check is successful, update the order in database
    if (statusData.success && orderData.orderId) {
      try {
        const order = await Order.findById(orderData.orderId);
        
        if (order) {
          const previousStatus = order.paymentStatus;
          
          // Update order based on payment status
          if (statusData.status === 'SUCCESS') {
            order.paymentStatus = 'paid';
            order.paymentRefId = statusData.txnRefId;
            order.PaymentGatewayOrderId = statusData.orderId;
            order.payerVpa = statusData.payerVpa;
            order.status = 'order confirmed';
            console.log(`✅ Order ${order._id} payment confirmed via status check`);
          } else if (statusData.status === 'FAILED') {
            order.paymentStatus = 'failed';
            order.paymentRefId = statusData.txnRefId;
            order.PaymentGatewayOrderId = statusData.orderId;
            console.log(`❌ Order ${order._id} payment failed via status check`);
          } else if (statusData.status === 'REFUNDED') {
            order.paymentStatus = 'refunded';
            order.paymentRefId = statusData.txnRefId;
            order.PaymentGatewayOrderId = statusData.orderId;
            order.payerVpa = statusData.payerVpa;
            console.log(`💰 Order ${order._id} payment refunded via status check`);
          } else if (statusData.status === 'TAMPERED') {
            order.paymentStatus = 'failed';
            order.paymentRefId = statusData.txnRefId;
            order.PaymentGatewayOrderId = statusData.orderId;
            order.status = 'cancelled';
            console.log(`⚠️ Order ${order._id} payment TAMPERED - amount mismatch detected`);
          }
          
          await order.save();
          console.log(`Order ${order._id} updated: ${previousStatus} -> ${order.paymentStatus}`);
        } else {
          console.error('Order not found for status update:', orderData.orderId);
        }
      } catch (updateError) {
        console.error('Failed to update order after status check:', updateError);
        // Don't fail the status check response if update fails
      }
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
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
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

    console.log('Order found:', order._id);

    // Update payment status based on webhook (PaymentGateway sends various status formats)
    const previousStatus = order.paymentStatus;
    const rawStatus = webhookData.status; // Original status from PaymentGateway
    const paymentStatus = rawStatus?.toUpperCase().replace(/_/g, ''); // Normalize: remove underscores and uppercase
    
    console.log('Raw PaymentGateway Status:', rawStatus);
    console.log('Normalized Status:', paymentStatus);
    
    // Map PaymentGateway statuses to our payment statuses
    if (paymentStatus === 'SUCCESS') {
      order.paymentStatus = 'paid';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      order.payerVpa = webhookData.payerVpa; // Save payer VPA
      order.status = 'order confirmed';
      console.log('✅ Payment successful - Order confirmed');
    } else if (paymentStatus === 'FAILED' || paymentStatus === 'FAILURE') {
      order.paymentStatus = 'failed';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      console.log('❌ Payment failed');
    } else if (paymentStatus === 'TAMPERED') {
      order.paymentStatus = 'failed';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      order.status = 'cancelled';
      console.log('⚠️ Payment TAMPERED - amount mismatch detected, order cancelled');
    } else if (paymentStatus === 'REFUNDED' || paymentStatus === 'CBREFUNDED') {
      order.paymentStatus = 'refunded';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      order.payerVpa = webhookData.payerVpa;
      console.log('💰 Payment refunded (Chargeback or Manual)');
    } else if (paymentStatus === 'INITIATED' || paymentStatus === 'PENDING' || paymentStatus === 'TRANSACTIONINPROGRESS') {
      order.paymentStatus = 'pending';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      console.log('⏳ Payment pending/in progress');
    } else if (paymentStatus === 'HOLD' || paymentStatus === 'ONHOLD') {
      order.paymentStatus = 'pending';
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
      console.log('⏸️ Payment on hold');
    } else {
      // Unknown status - keep as pending but log for investigation
      console.log('⚠️ Unknown payment status:', rawStatus);
      order.paymentRefId = txnRefId;
      order.PaymentGatewayOrderId = webhookData.orderId;
    }

    await order.save();
    console.log(`Order ${order._id} updated: ${previousStatus} -> ${order.paymentStatus}`);
    console.log('=================================');

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

/**
 * PUT /api/payment/update-order/:orderId
 * Update order with payment details after successful payment
 */
export async function updateOrderPayment(req, res) {
  try {
    const { orderId } = req.params;
    const { txnRefId, paymentIntentId, paymentStatus } = req.body;

    const order = await Order.findById(orderId);

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Verify the order belongs to the user
    if (order.user.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    // Update payment information
    order.paymentRefId = txnRefId;
    order.paymentIntentId = paymentIntentId;
    order.paymentStatus = paymentStatus || 'pending';

    if (paymentStatus === 'paid') {
      order.status = 'order confirmed';
    }

    await order.save();

    res.json(order);
  } catch (error) {
    console.error('Update order payment error:', error);
    res.status(500).json({ 
      message: 'Failed to update order payment',
      error: error.message 
    });
  }
}
