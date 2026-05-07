/**
 * In-memory rate limiter for Vercel serverless functions.
 *
 * Note: Vercel runs multiple function instances so this limits per-instance,
 * not globally. For true distributed rate limiting, wire up Vercel KV / Redis.
 * Per-instance limiting still meaningfully reduces brute-force exposure.
 */
const store = new Map();

/**
 * Check and record a hit against a rate-limit bucket.
 * @param {string} key       e.g. "login:1.2.3.4" or "api:user-id"
 * @param {number} limit     max requests allowed in the window
 * @param {number} windowMs  window size in milliseconds
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;

  const hits = (store.get(key) || []).filter(t => t > windowStart);

  if (hits.length >= limit) {
    const retryAfterMs = hits[0] - windowStart;
    return { allowed: false, retryAfterMs };
  }

  hits.push(now);
  store.set(key, hits);

  // Prevent unbounded memory growth — prune stale buckets periodically
  if (store.size > 20000) {
    for (const [k, v] of store.entries()) {
      if (v.every(t => t <= windowStart)) store.delete(k);
    }
  }

  return { allowed: true, retryAfterMs: 0 };
}

/**
 * Extract the real client IP from a Vercel/Node request.
 */
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

module.exports = { rateLimit, getClientIp };
