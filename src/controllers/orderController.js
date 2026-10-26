import mongoose from 'mongoose';
import Order from '../models/Order.js';
import User from '../models/User.js';
import { resolveCartLines } from '../utils/cart.js';

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/** POST /api/orders */
export async function createOrder(req, res) {
  try {
    const { shippingAddress, billingAddress, shippingMethod, paymentMethod } = req.body;

    const user = await User.findById(req.user.id).select('cart').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (!user.cart || user.cart.length === 0) {
      return res.status(400).json({ message: 'Cart is empty. Please add items to cart before placing order.' });
    }

    // A bag line can point at a product that was deleted (or re-imported with a
    // new id) after the shopper added it. Never order those: remove them from the
    // bag and ask the shopper to review it, rather than crashing or silently
    // placing a smaller order than the one they saw.
    const { lines, missingIds } = await resolveCartLines(user.cart);
    if (missingIds.length) {
      await User.updateOne({ _id: user._id }, { $pull: { cart: { product: { $in: missingIds } } } });
      const removedCount = user.cart.length - lines.length;
      return res.status(409).json({
        code: 'CART_ITEMS_UNAVAILABLE',
        removedCount,
        message: lines.length
          ? 'Some items in your bag are no longer available and have been removed. Please review your bag and place the order again.'
          : 'The items in your bag are no longer available and have been removed. Please add products to your bag again.',
      });
    }

    const items = lines.map(({ product, qty, size }) => ({
      product: product._id,
      name: product.name,
      image: product.image,
      price: product.price,
      qty: Math.max(1, Math.floor(Number(qty)) || 1),
      size: size || '',
    }));

    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const tax = subtotal * 0.005; // 0.5% tax
    const shippingCost = 45; // ₹45 shipping
    const total = subtotal + tax + shippingCost;

    const order = await Order.create({
      user: user._id,
      items,
      shippingAddress,
      billingAddress: billingAddress || shippingAddress,
      shippingMethod: shippingMethod || 'standard',
      shippingCost,
      tax,
      subtotal,
      paymentMethod: paymentMethod || 'cod',
      paymentStatus: (paymentMethod === 'cod') ? 'pending' : 'pending',
      total,
    });

    await User.updateOne({ _id: user._id }, { $set: { cart: [] } });

    res.status(201).json(order);
  } catch (err) {
    console.error('createOrder error:', err);
    // Bad input (e.g. a malformed address) is the client's to fix; anything else
    // is ours — log it, but don't leak internal error text to shoppers.
    if (err?.name === 'ValidationError' || err?.name === 'CastError') {
      return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: 'Failed to create order. Please try again.' });
  }
}

/** GET /api/orders/my */
export async function myOrders(req, res) {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('myOrders error:', err);
    res.status(500).json({ message: 'Failed to load orders' });
  }
}

/** GET /api/orders/:id */
export async function getOrder(req, res) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    const order = await Order.findOne({ _id: id, user: req.user.id });
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (err) {
    console.error('getOrder error:', err);
    res.status(500).json({ message: 'Failed to load order' });
  }
}

/** GET /api/orders/admin/all */
export async function allOrders(req, res) {
  try {
    const orders = await Order.find({}).populate('user', 'name email').sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('allOrders error:', err);
    res.status(500).json({ message: 'Failed to load all orders' });
  }
}

/** PUT /api/orders/admin/:id/status */
export async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (err) {
    console.error('updateStatus error:', err);
    res.status(500).json({ message: 'Failed to update status' });
  }
}

/** PUT /api/orders/admin/:id/delivery-date */
export async function updateDeliveryDate(req, res) {
  try {
    const { id } = req.params;
    const { estimatedDeliveryDate } = req.body;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    const order = await Order.findByIdAndUpdate(id, { estimatedDeliveryDate }, { new: true });
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json(order);
  } catch (err) {
    console.error('updateDeliveryDate error:', err);
    res.status(500).json({ message: 'Failed to update delivery date' });
  }
}

/** DELETE /api/orders/admin/:id - Admin marks order for deletion with message */
export async function deleteOrder(req, res) {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ message: 'Deletion message is required' });
    }
    const order = await Order.findByIdAndUpdate(
      id, 
      { isDeleted: true, deletionMessage: message }, 
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Order marked for deletion', order });
  } catch (err) {
    console.error('deleteOrder error:', err);
    res.status(500).json({ message: 'Failed to delete order' });
  }
}

/** DELETE /api/orders/:id/confirm - User confirms deletion permanently */
export async function confirmDeletion(req, res) {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    const order = await Order.findOneAndDelete({ _id: id, user: req.user.id, isDeleted: true });
    if (!order) return res.status(404).json({ message: 'Order not found or not marked for deletion' });
    res.json({ message: 'Order permanently deleted' });
  } catch (err) {
    console.error('confirmDeletion error:', err);
    res.status(500).json({ message: 'Failed to confirm deletion' });
  }
}

/** PUT /api/orders/admin/:id/payment-status - Admin updates payment status */
export async function updatePaymentStatus(req, res) {
  try {
    const { id } = req.params;
    const { paymentStatus } = req.body;
    
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    
    if (!paymentStatus || !['pending', 'paid', 'failed', 'refunded'].includes(paymentStatus)) {
      return res.status(400).json({ message: 'Invalid payment status' });
    }
    
    const order = await Order.findByIdAndUpdate(
      id,
      { paymentStatus },
      { new: true }
    ).populate('user', 'name email');
    
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    res.json(order);
  } catch (err) {
    console.error('updatePaymentStatus error:', err);
    res.status(500).json({ message: 'Failed to update payment status' });
  }
}

/** PUT /api/orders/:id/cancel - User cancels their own pending payment order */
export async function cancelOrder(req, res) {
  try {
    const { id } = req.params;
    
    if (!isValidObjectId(id)) {
      return res.status(400).json({ message: 'Invalid order id' });
    }
    
    // Find order and verify it belongs to the user
    const order = await Order.findOne({ _id: id, user: req.user.id });
    
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    // Only allow cancellation for pending payment status
    if (order.paymentStatus !== 'pending') {
      return res.status(400).json({ 
        message: `Cannot cancel order. Payment status is ${order.paymentStatus}. Only pending orders can be cancelled.` 
      });
    }
    
    // Update order status to cancelled
    order.status = 'cancelled';
    order.paymentStatus = 'failed'; // Mark payment as failed since order is cancelled
    await order.save();
    
    console.log(`✅ Order ${order.orderNumber} cancelled by user ${req.user.id}`);
    
    res.json({ 
      message: 'Order cancelled successfully',
      order 
    });
  } catch (err) {
    console.error('cancelOrder error:', err);
    res.status(500).json({ message: 'Failed to cancel order' });
  }
}
