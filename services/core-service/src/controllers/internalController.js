import mongoose from 'mongoose';
import User from '../models/User.js';
import { isObjectId, resolveCartLines } from '../utils/cart.js';

/**
 * POST /internal/users/:userId/checkout-cart
 * The shopper's bag for checkout, each line priced against the live catalogue, plus the
 * customer's name and email for the order. Lines whose product no longer exists are
 * removed from the bag here (the same self-healing as GET /api/users/cart) and counted
 * in `removedCount`, so the order service can ask the shopper to review the bag.
 */
export async function checkoutCart(req, res) {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ message: 'Invalid user id' });

    const user = await User.findById(userId).select('name email cart').lean();
    if (!user) return res.status(404).json({ message: 'User not found' });

    const cart = user.cart || [];
    const { lines, missingIds } = await resolveCartLines(cart);
    if (missingIds.length) {
      await User.updateOne({ _id: user._id }, { $pull: { cart: { product: { $in: missingIds } } } });
    }

    res.json({
      customer: { id: user._id, name: user.name, email: user.email },
      lines: lines.map(({ product, qty, size }) => ({
        productId: product._id,
        name: product.name,
        image: product.image,
        price: product.price,
        qty,
        size,
      })),
      removedCount: cart.length - lines.length,
    });
  } catch (err) {
    console.error(`[${req.id}] checkoutCart error:`, err);
    res.status(500).json({ message: 'Failed to load cart' });
  }
}

/**
 * POST /internal/users/:userId/cart/remove-lines  { lines: [{ productId, size }] }
 * Remove exactly these bag lines: the ones that were just ordered. A line added while
 * checkout was in flight stays in the bag. Removing a line that is already gone does
 * nothing, so the order service can safely retry this call.
 */
export async function removeCartLines(req, res) {
  try {
    const { userId } = req.params;
    if (!isObjectId(userId)) return res.status(400).json({ message: 'Invalid user id' });

    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).filter((line) =>
      isObjectId(String(line?.productId))
    );
    if (lines.length) {
      const match = lines.map(({ productId, size }) => ({
        product: new mongoose.Types.ObjectId(String(productId)),
        // A line without a size may have '' or no size field at all; match both.
        size: size ? String(size) : { $in: ['', null] },
      }));
      await User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(userId) },
        { $pull: { cart: { $or: match } } }
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`[${req.id}] removeCartLines error:`, err);
    res.status(500).json({ message: 'Failed to update cart' });
  }
}
