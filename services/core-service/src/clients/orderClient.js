// Calls from core-service to order-service. Each function is one endpoint of the order
// service's internal API (services/order-service/src/routes/internal.js).
import { callService } from './http.js';

const orders = (path, options) => callService('order-service', process.env.ORDER_SERVICE_URL, path, options);

/**
 * One order with its items, or null if it doesn't exist. With `userId`, null also
 * when that user didn't place it, which is how report creation checks ownership.
 */
export async function getOrder(orderId, { userId, requestId } = {}) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  try {
    return await orders(`/internal/orders/${encodeURIComponent(orderId)}${query}`, { requestId, retries: 1 });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Summaries ({ _id, orderNumber, total, status, paymentStatus, createdAt }) for many orders in one call. */
export async function getOrderSummaries(ids, requestId) {
  if (!ids.length) return [];
  const { orders: found } = await orders('/internal/orders/summaries', {
    method: 'POST',
    body: { ids },
    requestId,
    retries: 1, // a read, so repeating it is safe
    timeoutMs: 3000,
  });
  return found;
}
