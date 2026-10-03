// Protection for a public deployment: per-visitor rate limits, daily spend caps for the paid
// APIs (Tavily, ZooWork), a global cap on parallel ZooWork sessions, and an SSRF check for
// the image proxy. All in memory — limits reset when the server restarts.
const dns = require('dns').promises;
const net = require('net');

function clientIp(req) {
  const trust = process.env.TRUST_PROXY !== 'false';
  const fwd = trust && req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : req.socket.remoteAddress || '').trim().replace(/^::ffff:/, '') || 'unknown';
}

// Fixed-window counters: allow(key, limit, windowMs) → { ok, retryAfterSec }
class RateLimiter {
  constructor() {
    this.buckets = new Map();
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, b] of this.buckets) if (b.reset < now) this.buckets.delete(k);
    }, 60_000);
    if (t.unref) t.unref();
  }
  allow(key, limit, windowMs) {
    if (!limit || limit <= 0) return { ok: true };
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; this.buckets.set(key, b); }
    if (b.n >= limit) return { ok: false, retryAfterSec: Math.ceil((b.reset - now) / 1000) };
    b.n += 1;
    return { ok: true };
  }
}

// Daily budget per paid API (UTC day).
class Budget {
  constructor(limits) { this.limits = limits; this.day = ''; this.used = {}; }
  _roll() { const d = new Date().toISOString().slice(0, 10); if (d !== this.day) { this.day = d; this.used = {}; } }
  left(name) { this._roll(); const l = this.limits[name]; return l > 0 ? Math.max(0, l - (this.used[name] || 0)) : Infinity; }
  take(name, n = 1) {
    this._roll();
    if (this.left(name) < n) return false;
    this.used[name] = (this.used[name] || 0) + n;
    return true;
  }
  info() { this._roll(); return Object.fromEntries(Object.keys(this.limits).map((k) => [k, { used: this.used[k] || 0, limit: this.limits[k] || null }])); }
}

// Counting semaphore: limits concurrent ZooWork sessions across all visitors.
class Semaphore {
  constructor(n) { this.n = n; this.active = 0; this.queue = []; }
  async acquire(signal) {
    if (this.active < this.n) { this.active += 1; return; }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);
      if (signal) signal.addEventListener('abort', () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) { this.queue.splice(i, 1); reject(new Error('cancelled')); }
      }, { once: true });
    });
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next.resolve();
  }
}

// Blocks private, loopback, link-local (incl. cloud metadata 169.254.169.254) and other
// non-public addresses — checked after DNS resolution, not just on the hostname.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

async function isPublicHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !isPrivateIp(h);
  if (!h.includes('.') || /\.(local|internal|localhost)$/i.test(h) || /^localhost$/i.test(h)) return false;
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

module.exports = { clientIp, RateLimiter, Budget, Semaphore, isPrivateIp, isPublicHost, SECURITY_HEADERS };
