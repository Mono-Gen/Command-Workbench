// Small rate-limit helpers shared by the TCP controller, the UDP endpoint, the UDP device and the UDP relay (no clock reads of their own:
// the caller passes the time, so tests can drive them).

// At most `maxCount` datagrams and `maxBytes` bytes within any `windowMs` (a real sliding window).
function createWindowLimiter(maxCount, maxBytes, windowMs = 1000) {
  const entries = [];
  let bytes = 0;
  return {
    take(t, size) {
      while (entries.length > 0 && t - entries[0].t >= windowMs) bytes -= entries.shift().size;
      if (entries.length + 1 > maxCount || bytes + size > maxBytes) return false;
      entries.push({ t, size });
      bytes += size;
      return true;
    },
  };
}

// Byte token bucket: `ratePerSecond` bytes refill per second; at most `capacity` (default one
// second's worth) is stored.
function createBucket(ratePerSecond, now, capacity = ratePerSecond) {
  let tokens = capacity;
  let last = now();
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - last) * ratePerSecond) / 1000);
    last = t;
  };
  return {
    has(size) { refill(); return tokens >= size; },
    take(size) { tokens -= size; },
  };
}

module.exports = { createWindowLimiter, createBucket };
