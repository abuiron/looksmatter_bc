// HTTP calls to other services: JSON in and out, the shared internal key, the
// caller's request id, a timeout, and retries for calls that are safe to repeat.

/** A failed call to another service. `status` is its HTTP status, or 503 if it never answered. */
export class ServiceError extends Error {
  constructor(message, { status = 503, body = {}, service } = {}) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.body = body;
    this.service = service;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call another service's internal API.
 * Only pass `retries` for calls that give the same result when repeated (reads, or
 * writes like "remove these lines"): a retry may repeat a request that did succeed
 * but whose response was lost.
 */
export async function callService(service, baseUrl, path, { method = 'GET', body, requestId, timeoutMs = 5000, retries = 0 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Api-Key': process.env.INTERNAL_API_KEY || '',
          ...(requestId && { 'X-Request-Id': requestId }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No answer at all: connection refused, DNS failure or timeout.
      if (attempt < retries) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      const reason = err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : err.cause?.code || err.message;
      throw new ServiceError(`${service} is unreachable (${reason})`, { service });
    }

    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    // A 5xx may be temporary and is worth another try; a 4xx is a real answer.
    if (response.status >= 500 && attempt < retries) {
      await sleep(200 * 2 ** attempt);
      continue;
    }
    throw new ServiceError(data.message || `${service} responded ${response.status}`, {
      status: response.status,
      body: data,
      service,
    });
  }
}
