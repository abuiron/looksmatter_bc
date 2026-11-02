// src/routes/users.js
import { Router } from 'express';
import {
  getProfile, updateProfile,
  getFavorites, addFavorite, removeFavorite,
  getCart, addToCart, updateCartItem, removeCartItem, clearCart,
  pushRecently, getRecently,
  adminListUsers, adminGetUserById
} from '../controllers/userController.js';
import { protect, adminOnly } from '../middleware/auth.js';

const router=Router();

router.get('/me', protect, getProfile);
router.put('/me', protect, updateProfile);

router.get('/favorites', protect, getFavorites);
router.post('/favorites/:productId', protect, addFavorite);
router.delete('/favorites/:productId', protect, removeFavorite);

router.get('/cart', protect, getCart);
router.post('/cart', protect, addToCart);
router.put('/cart/:productId', protect, updateCartItem);
router.delete('/cart/:productId', protect, removeCartItem);
router.delete('/cart', protect, clearCart);

router.post('/recently/:productId', protect, pushRecently);
router.get('/recently', protect, getRecently);

// Admin
router.get('/', protect, adminOnly, adminListUsers);
// GET /:id/orders (a customer's order statistics) moved to order-service, which owns
// orders; the API gateway routes that path there.
router.get('/:id', protect, adminOnly, adminGetUserById);

export default router;
