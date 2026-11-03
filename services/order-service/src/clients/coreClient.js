// Calls from order-service to core-service. Each function is one endpoint of core's
// internal API (services/core-service/src/routes/internal.js).
import { callService } from './http.js';

const core = (path, options) => callService('core-service', process.env.CORE_SERVICE_URL, path, options);

/**
 * The shopper's bag priced against the live catalogue, plus their name and email:
 * { customer: { id, name, email }, lines: [{ productId, name, image, price, qty, size }], removedCount }
 * Safe to retry: resolving a bag only ever removes lines whose product is gone.
 */
export function getCheckoutCart(userId, requestId) {
  return core(`/internal/users/${encodeURIComponent(userId)}/checkout-cart`, {
    method: 'POST',
    requestId,
    retries: 1,
  });
}

/** Take the lines that were just ordered out of the bag. Removing a line twice is harmless, so retry. */
export function removeCartLines(userId, lines, requestId) {
  return core(`/internal/users/${encodeURIComponent(userId)}/cart/remove-lines`, {
    method: 'POST',
    body: { lines },
    requestId,
    retries: 2,
  });
}
