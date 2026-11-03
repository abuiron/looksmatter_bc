import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import {
  initiatePaymentGatewayPayment,
  getPaymentStatus,
  PaymentGatewayWebhook,
} from '../controllers/paymentController.js';

const router = Router();

// Initiate payment (protected - user must be logged in)
router.post('/initiate', protect, initiatePaymentGatewayPayment);

// Check payment status
router.post('/status', protect, getPaymentStatus);

// PaymentGateway webhook (no auth required - comes from PaymentGateway servers)
router.post('/webhook', PaymentGatewayWebhook);
router.post('/webhook/looksmatter', PaymentGatewayWebhook); // Product-specific webhook endpoint

// PUT /update-order/:orderId was removed during the split: it let a shopper set their
// own order's payment status (including "paid"). Payment state now changes only from
// the provider's answers (webhook or status check) or an admin.

export default router;
