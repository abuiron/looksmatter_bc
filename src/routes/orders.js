import { Router } from 'express';
import { protect, adminOnly } from '../middleware/auth.js';
import {
  createOrder,
  myOrders,
  getOrder,
  allOrders,
  updateStatus,
  updateDeliveryDate,
  deleteOrder,
  confirmDeletion,
  updatePaymentStatus,
  cancelOrder,
} from '../controllers/orderController.js';

const router = Router();

// Create order (from current user's cart)
router.post('/', protect, createOrder);

// Current user's orders (matches frontend: GET /api/orders/my)
router.get('/my', protect, myOrders);

// Admin routes must come BEFORE the :id param route
router.get('/admin/all', protect, adminOnly, allOrders);
router.put('/admin/:id/status', protect, adminOnly, updateStatus);
router.put('/admin/:id/delivery-date', protect, adminOnly, updateDeliveryDate);
router.put('/admin/:id/payment-status', protect, adminOnly, updatePaymentStatus);
router.delete('/admin/:id', protect, adminOnly, deleteOrder);

// Single order (owned by current user)
router.get('/:id', protect, getOrder);
router.put('/:id/cancel', protect, cancelOrder);
router.delete('/:id/confirm', protect, confirmDeletion);

export default router;
