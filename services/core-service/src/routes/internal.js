import { Router } from 'express';
import { checkoutCart, removeCartLines } from '../controllers/internalController.js';

// Service-to-service API, used by order-service at checkout. The gateway never routes
// /internal, and server.js puts requireInternalKey in front of this router.
const router = Router();

router.post('/users/:userId/checkout-cart', checkoutCart);
router.post('/users/:userId/cart/remove-lines', removeCartLines);

export default router;
