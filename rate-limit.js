// MidRound — reusable per-IP rate limiting.
//
// Why the IP is derived carefully: a client can PREPEND fake entries to the
// X-Forwarded-For header, but every trusted proxy in front of us APPENDS the
// address it actually saw. So the real client sits TRUSTED_PROXY_HOPS entries
// from the RIGHT end of the chain — never the left, client-controlled end.
// When there is no proxy (local dev, direct exposure) TRUSTED_PROXY_HOPS is 0
// and the header is ignored entirely; we use the socket address, which a
// client cannot forge. Falling back to the socket also "fails safe": it can
// only over-limit (group users behind one proxy), never under-limit.

const TRUSTED_PROXY_HOPS = (() => {
  const n = Number.parseInt(process.env.TRUSTED_PROXY_HOPS || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
})();

function clientIp(req, hops = TRUSTED_PROXY_HOPS) {
  if (hops > 0) {
    // Node joins repeated X-Forwarded-For headers with ", " in wire order, so
    // splitting on commas sees the combined chain; the trusted proxy's
    // appended entry is always last overall.
    const parts = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length >= hops) return parts[parts.length - hops];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// All limiter buckets, so tests can reset state between cases.
const allBuckets = [];

// rateLimit({ max: 10 }) -> Express middleware allowing `max` requests per
// client IP per window (default one minute), then answering 429.
function rateLimit({ max, windowMs = 60_000 }) {
  const buckets = new Map(); // ip -> { count, resetAt }
  allBuckets.push(buckets);
  let lastSweep = Date.now();

  return function limit(req, res, next) {
    const nowMs = Date.now();

    // Drop expired buckets occasionally so the map can't grow forever.
    if (nowMs - lastSweep > windowMs) {
      lastSweep = nowMs;
      for (const [key, b] of buckets) {
        if (b.resetAt <= nowMs) buckets.delete(key);
      }
    }

    const key = clientIp(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= nowMs) {
      bucket = { count: 0, resetAt: nowMs + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - nowMs) / 1000));
      return res.status(429).json({ error: 'Too many requests. Wait a minute, then try again.' });
    }
    next();
  };
}

function resetRateLimits() {
  for (const buckets of allBuckets) buckets.clear();
}

module.exports = { clientIp, rateLimit, resetRateLimits, TRUSTED_PROXY_HOPS };
