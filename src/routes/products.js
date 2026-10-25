// src/routes/products.js
import { Router } from 'express';
import { listProducts, getProduct, createProduct, bulkCreateProducts, updateProduct, deleteProduct } from '../controllers/productController.js';
import { protect, adminOnly } from '../middleware/auth.js';

const router = Router();

router.get('/', listProducts);
router.get('/:id', getProduct);

// NOTE: keep /bulk above /:id-style routes so it is never treated as an :id
router.post('/bulk', protect, adminOnly, bulkCreateProducts);
router.post('/', protect, adminOnly, createProduct);
router.put('/:id', protect, adminOnly, updateProduct);
router.delete('/:id', protect, adminOnly, deleteProduct);

export default router;
