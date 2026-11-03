import { Router } from 'express';
import { orderForService, orderSummaries } from '../controllers/internalController.js';

// Service-to-service API, used by core-service (support reports). The gateway never
// routes /internal, and server.js puts requireInternalKey in front of this router.
const router = Router();

router.get('/orders/:id', orderForService);
router.post('/orders/summaries', orderSummaries);

export default router;
