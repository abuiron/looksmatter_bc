import { randomUUID } from 'crypto';

// Every request carries an id, set by the API gateway and passed along on every
// service-to-service call, so one shopper action can be followed through the logs of
// all services. A request that didn't come through the gateway gets a fresh id.
export function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}
