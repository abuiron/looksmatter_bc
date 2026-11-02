import { timingSafeEqual } from 'crypto';

// /internal routes are for other services only. The gateway never routes them, and
// every call must also carry the shared INTERNAL_API_KEY, so they stay closed even if
// this service's port is reachable from outside.
export function requireInternalKey(req, res, next) {
  const expected = Buffer.from(process.env.INTERNAL_API_KEY || '');
  const given = Buffer.from(req.get('x-internal-api-key') || '');
  // timingSafeEqual needs equal lengths; comparing in constant time avoids leaking the key byte by byte.
  if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ message: 'Internal access only' });
  }
  next();
}
