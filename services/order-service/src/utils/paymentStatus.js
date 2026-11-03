// Turning payment-provider events into order state.
//
// The same event can arrive more than once and out of order: the provider retries
// webhooks, and the shopper's "Check status" button asks for the same answer again.
// So events are mapped onto our own small set of statuses, and only moves that make
// sense are applied. A late "PENDING" can't undo a payment, and a repeated "SUCCESS"
// can't pull a shipped order back to "order confirmed".

const normalize = (status) => String(status || '').toUpperCase().replace(/_/g, '');

/** Provider status in any spelling ("Success", "CB_REFUNDED", "On_Hold", …) → our paymentStatus, or null when unknown. */
export function toPaymentStatus(providerStatus) {
  const s = normalize(providerStatus);
  if (s === 'SUCCESS') return 'paid';
  if (s === 'FAILED' || s === 'FAILURE' || s === 'TAMPERED') return 'failed';
  if (s === 'REFUNDED' || s === 'CBREFUNDED') return 'refunded';
  if (['INITIATED', 'PENDING', 'TRANSACTIONINPROGRESS', 'HOLD', 'ONHOLD'].includes(s)) return 'pending';
  return null;
}

// Current paymentStatus → the statuses a provider event may move it to.
const ALLOWED_MOVES = {
  pending: ['pending', 'paid', 'failed'],
  failed: ['failed', 'paid', 'pending'], // a later attempt for the same order can still succeed
  paid: ['paid', 'refunded'],
  refunded: ['refunded'],
};

/**
 * Apply one provider event to an order in memory; the caller saves it.
 * `details` are the provider's ids for the transaction and the payer's UPI address.
 * Returns { applied, from, to }. `applied` is false for unknown statuses and for
 * moves the table above doesn't allow; those leave the order untouched.
 */
export function applyProviderStatus(order, providerStatus, details = {}, source = 'provider') {
  const { txnRefId, gatewayOrderId, payerVpa } = details;
  const from = order.paymentStatus;
  const to = toPaymentStatus(providerStatus);

  if (!to) {
    console.warn(`[payment] ${source}: unknown provider status "${providerStatus}" for order ${order._id}; left unchanged`);
    return { applied: false, from, to: null };
  }
  if (!ALLOWED_MOVES[from]?.includes(to)) {
    console.warn(`[payment] ${source}: ignored ${from} -> ${to} for order ${order._id} (provider status "${providerStatus}")`);
    return { applied: false, from, to };
  }

  order.paymentStatus = to;
  if (txnRefId) order.paymentRefId = txnRefId;
  if (gatewayOrderId) order.PaymentGatewayOrderId = gatewayOrderId;
  if ((to === 'paid' || to === 'refunded') && payerVpa) order.payerVpa = payerVpa;

  // Fulfilment follows the payment only at the start of an order's life.
  if (to === 'paid' && order.status === 'pending') order.status = 'order confirmed';
  // TAMPERED means the amount paid didn't match the amount requested. It only applies
  // to unpaid orders (see ALLOWED_MOVES), and those are cancelled.
  if (normalize(providerStatus) === 'TAMPERED') order.status = 'cancelled';
  if (to === 'paid' && order.status === 'cancelled') {
    console.warn(`[payment] ${source}: order ${order._id} was paid after it was cancelled; needs a refund or review`);
  }

  console.log(`[payment] ${source}: order ${order._id} payment ${from} -> ${to}`);
  return { applied: true, from, to };
}
