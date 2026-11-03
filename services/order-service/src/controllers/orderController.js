import mongoose from 'mongoose';
import Order from '../models/Order.js';
import { getCheckoutCart, removeCartLines } from '../clients/coreClient.js';

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Admin screens show who placed each order. Customers live in core-service, so rather
// than populating across databases, answer with the snapshot taken at checkout, in the
// same { _id, name, email } shape the populated `user` field always had.
const withCustomer = (order) => ({
  ...order,
  user: { _id: order.user, name: order.customer?.name, email: order.customer?.email },
});

/** POST /api/orders */
export async function createOrder(req, res) {
  try {
    const { shippingAddress, billingAddress, shippingMethod, paymentMethod } = req.body;

    // The bag, the catalogue and the customer belong to core-service, so checkout starts
    // by asking it for the bag priced against the live catalogue. Totals are still
    // computed here from those server-side prices, never from the request body.
    let cart;
    try {
      cart = await getCheckoutCart(req.user.id, req.id);
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ message: 'User not found' });
      console.error(`[${req.id}] createOrder: could not load the bag from core-service:`, err.message);
      return res.status(503).json({ message: 'Checkout is temporarily unavailable. Please try again in a moment.' });
    }

    // A bag line can point at a product that was deleted (or re-imported with a
    // new id) after the shopper added it. core-service has already removed those
    // lines; never order them, and ask the shopper to review the bag rather than
    // silently placing a smaller order than the one they saw.
    if (cart.removedCount > 0) {
      return res.status(409).json({
        code: 'CART_ITEMS_UNAVAILABLE',
        removedCount: cart.removedCount,
        message: cart.lines.length
          ? 'Some items in your bag are no longer available and have been removed. Please review your bag and place the order again.'
          : 'The items in your bag are no longer available and have been removed. Please add products to your bag again.',
      });
    }

    if (cart.lines.length === 0) {
      return res.status(400).json({ message: 'Cart is empty. Please add items to cart before placing order.' });
    }

    const items = cart.lines.map(({ productId, name, image, price, qty, size }) => ({
      product: productId,
      name,
      image,
      price,
      qty: Math.max(1, Math.floor(Number(qty)) || 1),
      size: size || '',
    }));

    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const tax = subtotal * 0.005; // 0.5% tax
    const shippingCost = 45; // ₹45 shipping
    const total = subtotal + tax + shippingCost;

    const order = await Order.create({
      user: req.user.id,
      customer: { name: cart.customer?.name, email: cart.customer?.email },
      items,
      shippingAddress,
      billingAddress: billingAddress || shippingAddress,
      shippingMethod: shippingMethod || 'standard',
      shippingCost,
      tax,
      subtotal,
      paymentMethod: paymentMethod || 'cod',
      total,
    });

    // The order is placed; now take the ordered lines out of the bag. This is a call to
    // another service, so it can fail after the order exists. That is tolerable: the
    // order stands, the storefront also clears the bag after a successful checkout, and
    // a leftover line is only an inconvenience. It is logged so it can be noticed.
    try {
      await removeCartLines(req.user.id, items.map(({ product, size }) => ({ productId: product, size })), req.id);
    } catch (err) {
      console.error(`[${req.id}] order ${order.orderNumber} placed, but its lines could not be removed from the bag:`, err.message);
    }

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
    const orders = await Order.find({}).sort({ createdAt: -1 }).lean();
    res.json(orders.map(withCustomer));
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
    ).lean();

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(withCustomer(order));
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

/**
 * GET /api/orders/admin/users/:userId/stats - Order statistics for one customer (admin only)
 * Moved here from core-service, because orders live here. The gateway also serves it at
 * GET /api/users/:id/orders, the path the storefront has always called.
 */
export async function userOrderStats(req, res) {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ message: 'Invalid user id' });
    }

    // Get all orders for this user
    const orders = await Order.find({ user: userId })
      .select('orderNumber total status paymentStatus createdAt items')
      .sort({ createdAt: -1 });

    // Calculate statistics
    const totalOrders = orders.length;
    const successfulOrders = orders.filter(o => o.status === 'delivered').length;
    const pendingOrders = orders.filter(o =>
      o.status !== 'delivered' &&
      o.status !== 'cancelled' &&
      o.status !== 'refunded'
    ).length;
    const cancelledOrders = orders.filter(o =>
      o.status === 'cancelled' || o.status === 'refunded'
    ).length;

    const totalSpent = orders
      .filter(o => o.paymentStatus === 'paid')
      .reduce((sum, o) => sum + o.total, 0);

    res.json({
      totalOrders,
      successfulOrders,
      pendingOrders,
      cancelledOrders,
      totalSpent,
      orders: orders.slice(0, 10), // Return last 10 orders
    });
  } catch (err) {
    console.error('userOrderStats error:', err);
    res.status(500).json({ message: 'Failed to fetch user orders' });
  }
}
