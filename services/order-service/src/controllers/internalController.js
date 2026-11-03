import mongoose from 'mongoose';
import Order from '../models/Order.js';

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// The order fields other services may rely on. Keeping the list short keeps the
// contract short: core-service can't come to depend on anything else in an order.
const SUMMARY_FIELDS = 'orderNumber total status paymentStatus createdAt';
const MAX_SUMMARIES = 500;

/**
 * GET /internal/orders/:id?userId=
 * One order (summary fields plus items). With `userId`, only if that user placed it,
 * which is how core-service checks ownership before filing a support report.
 */
export async function orderForService(req, res) {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    if (!isValidObjectId(id) || (userId !== undefined && !isValidObjectId(userId))) {
      return res.status(400).json({ message: 'Invalid id' });
    }
    const filter = userId ? { _id: id, user: userId } : { _id: id };
    const order = await Order.findOne(filter).select(`${SUMMARY_FIELDS} user items`).lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error(`[${req.id}] orderForService error:`, err);
    res.status(500).json({ message: 'Failed to load order' });
  }
}

/**
 * POST /internal/orders/summaries  { ids: [...] }
 * Many orders in one round trip, so a list of N reports costs one call, not N.
 * Unknown ids are simply absent from the answer.
 */
export async function orderSummaries(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(isValidObjectId) : [];
    if (ids.length > MAX_SUMMARIES) {
      return res.status(400).json({ message: `At most ${MAX_SUMMARIES} ids per request` });
    }
    const orders = ids.length
      ? await Order.find({ _id: { $in: ids } }).select(SUMMARY_FIELDS).lean()
      : [];
    res.json({ orders });
  } catch (err) {
    console.error(`[${req.id}] orderSummaries error:`, err);
    res.status(500).json({ message: 'Failed to load orders' });
  }
}
