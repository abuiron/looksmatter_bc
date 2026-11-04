// The routing table: which service answers which public path. The first matching rule
// wins. Anything not listed (including every /internal path) is answered with 404 by
// the gateway itself and never reaches a service.
export function buildRoutes({ core, orders }) {
  return [
    {
      // A customer's order statistics (admin). The storefront has always called
      // /api/users/:id/orders; orders moved to order-service, which serves this under
      // its own URL. Rewriting here keeps the public URL unchanged for clients.
      service: 'order-service',
      target: orders,
      match: (path) => /^\/api\/users\/[^/]+\/orders\/?$/.test(path),
      rewrite: (url) => url.replace(/^\/api\/users\/([^/?]+)\/orders\/?/, '/api/orders/admin/users/$1/stats'),
    },
    {
      service: 'order-service',
      target: orders,
      match: (path) => /^\/api\/(orders|payment)(\/|$)/.test(path),
    },
    {
      service: 'core-service',
      target: core,
      match: (path) => /^\/api\/(auth|products|users|reports|uploads)(\/|$)/.test(path) || path.startsWith('/uploads/'),
    },
  ];
}
