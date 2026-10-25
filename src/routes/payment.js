import { Router } from 'express';
import { protect } from '../middleware/auth.js';
import {
  initiatePaymentGatewayPayment,
  getPaymentStatus,
  PaymentGatewayWebhook,
  updateOrderPayment
} from '../controllers/paymentController.js';

const router = Router();

// Initiate payment (protected - user must be logged in)
router.post('/initiate', protect, initiatePaymentGatewayPayment);

// Check payment status
router.post('/status', protect, getPaymentStatus);

// PaymentGateway webhook (no auth required - comes from PaymentGateway servers)
router.post('/webhook', PaymentGatewayWebhook);
router.post('/webhook/looksmatter', PaymentGatewayWebhook); // Product-specific webhook endpoint

// Update order with payment details
router.put('/update-order/:orderId', protect, updateOrderPayment);

export default router;
