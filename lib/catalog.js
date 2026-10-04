// Product-name catalog in Moss, used for type-ahead.
//   • Seeded from Amazon Reviews 2023 (most-reviewed products) by scripts/import-catalog.js
//   • Grows automatically: every product Tavily finds is added ("learned")
// Lookups run against the index loaded in-process when Moss's local mode works, otherwise
// against Moss's cloud query API.
const crypto = require('crypto');
const path = require('path');
const { cleanName, matchesQuery } = require('./suggest');
const { queryTokens } = require('./extract');

const SEP = ' ‖ ';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const productId = (name) => `p-${crypto.createHash('sha1').update(norm(name)).digest('hex').slice(0, 16)}`;

// One Moss document per product. The name leads the text so it can be recovered even when
// a cloud query returns no metadata.
function productDoc({ name, brand = '', category = '', image = '', popularity = 0, source = 'tavily' }) {
  const clean = cleanName(name);
  if (!clean || clean.length < 4) return null;
  const tokens = [...new Set(queryTokens(`${clean} ${brand}`))].join(' '); // "wh1000xm5" for "WH-1000XM5"
  return {
    id: productId(clean),
    text: `${clean}${SEP}${brand}${SEP}${category}${SEP}${tokens}`.slice(0, 600),
    metadata: {
      name: clean.slice(0, 160),
      brand: String(brand || '').slice(0, 60),
      category: String(category || '').slice(0, 60),
      image: /^https:\/\//.test(image || '') ? String(image).slice(0, 400) : '',
      popularity: String(Math.max(0, Math.round(Number(popularity) || 0))),
      source,
    },
  };
}

async function createMossClient(projectId, projectKey) {
  let mod;
  try { mod = await import('@moss-dev/moss'); } catch { mod = await import('@moss-js/moss'); }
  const MossClient = mod.MossClient || (mod.default && mod.default.MossClient);
  return new MossClient(projectId, projectKey);
}

class Catalog {
  constructor({ projectId, projectKey, indexName = 'pricescout-products', cacheDir, log = console.log, clientFactory, timeoutMs = 400, flushMs = 10_000 } = {}) {
    this.projectId = projectId;
    this.projectKey = projectKey;
    this.indexName = indexName;
    this.cacheDir = cacheDir;
    this.log = log;
    this.clientFactory = clientFactory || createMossClient;
    this.timeoutMs = timeoutMs;
    this.flushMs = flushMs;
    this.status = projectId && projectKey ? 'connecting' : 'off';
    this.reason = projectId && projectKey ? '' : 'MOSS_PROJECT_ID / MOSS_PROJECT_KEY not set';
    this.mode = null; // 'local' | 'cloud'
    this.exists = false;
    this.pending = new Map();
    this.flushTimer = null;
    this.retryTimer = null;
    this.stats = { lookups: 0, hits: 0, misses: 0, timeouts: 0, learned: 0, errors: 0 };
    this.pausedUntil = 0;
  }

  get ready() { return this.status === 'ready' && this.exists && !this.paused; }

  // Moss answers 429 (e.g. "credit_exhausted") when the account is over its limit: stop
  // calling it for a while instead of failing on every keystroke; Tavily covers meanwhile.
  get paused() { return this.pausedUntil > Date.now(); }
  _maybePause(e) {
    const msg = String((e && e.message) || '');
    if (!/\b429\b|USAGE_LIMIT|credit_exhausted|Too Many Requests/i.test(msg)) return false;
    const first = !this.paused;
    this.pausedUntil = Date.now() + 15 * 60_000;
    this.reason = `Moss usage limit reached (${/credit_exhausted|USAGE_LIMIT/i.test(msg) ? 'credits exhausted' : 'rate limited'}) — paused for 15 min, Tavily only`;
    if (first) this.log(`[catalog] ${this.reason}`);
    return true;
  }

  async init() {
    if (this.status === 'off') return this;
    try {
      this.client = await this.clientFactory(this.projectId, this.projectKey);
      try { await this.client.getIndex(this.indexName); this.exists = true; } catch { this.exists = false; }
      this.status = 'ready';
      if (this.exists) await this.load();
      else this.log(`[catalog] Moss index "${this.indexName}" doesn't exist yet — run the catalog import`);
    } catch (e) {
      this.status = 'error';
      this.reason = e && e.code === 'ERR_MODULE_NOT_FOUND' ? 'Moss SDK not installed — run "npm install"' : `Moss unavailable: ${e.message}`;
      this.log(`[catalog] ${this.reason} — type-ahead will use Tavily`);
    }
    return this;
  }

  // Try the fast in-process mode; fall back to cloud queries and retry every 15 min.
  async load() {
    const t0 = Date.now();
    try {
      await this.client.loadIndex(this.indexName, {
        autoRefresh: true,
        pollingIntervalInSeconds: 300,
        ...(this.cacheDir ? { cachePath: path.join(this.cacheDir, 'moss') } : {}),
      });
      this.mode = 'local';
      this.reason = '';
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.log(`[catalog] "${this.indexName}" loaded in ${Date.now() - t0} ms — type-ahead lookups are local`);
    } catch (e) {
      const first = this.mode !== 'cloud';
      this.mode = 'cloud';
      this.reason = `local load failed (${String(e.message).slice(0, 140)}) — using Moss cloud queries`;
      if (first) this.log(`[catalog] ${this.reason}`);
      if (!this.retryTimer) {
        this.retryTimer = setInterval(() => this.load(), 15 * 60_000);
        if (this.retryTimer.unref) this.retryTimer.unref();
      }
    }
  }

  // Called when an import finishes so a running server picks up the new index.
  async refresh() {
    if (this.status !== 'ready') return;
    try { await this.client.getIndex(this.indexName); this.exists = true; await this.load(); } catch {}
  }

  _timeout(p, ms) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms); })]).finally(() => clearTimeout(t));
  }

  // Returns [{ name, brand, image, store, source: 'moss' }] (best first) or [] / null on timeout.
  async suggest(q, { limit = 7, timeoutMs = this.timeoutMs } = {}) {
    if (!this.ready) return null;
    this.stats.lookups += 1;
    const t0 = Date.now();
    try {
      const res = await this._timeout(this.client.query(this.indexName, q, { topK: 25, alpha: 0.5 }), timeoutMs);
      let docs = (res && res.docs) || [];
      const missing = docs.filter((d) => !d.metadata).map((d) => d.id);
      if (missing.length) {
        const left = Math.max(80, timeoutMs - (Date.now() - t0));
        const full = await this._timeout(this.client.getDocs(this.indexName, { docIds: missing.slice(0, 25) }), left).catch(() => []);
        const byId = new Map((full || []).map((d) => [d.id, d]));
        docs = docs.map((d) => (d.metadata ? d : { ...d, metadata: (byId.get(d.id) || {}).metadata }));
      }
      const words = norm(q).split(' ').filter(Boolean);
      const out = [];
      const seen = new Set();
      for (const d of docs) {
        const m = d.metadata || {};
        const name = m.name || String(d.text || '').split(SEP)[0];
        if (!name || !matchesQuery(name, q)) continue;
        const key = norm(name).split(' ').slice(0, 6).join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const n = norm(name);
        const startsWith = n.startsWith(words.join(' ')) ? 1 : 0;
        const pop = Math.log10(1 + (Number(m.popularity) || 0)) / 6; // 0..~1
        out.push({ name, brand: m.brand || '', image: m.image || null, store: m.brand || 'Catalog', source: 'moss', rank: startsWith * 0.5 + (d.score || 0) * 0.35 + pop * 0.15 });
      }
      out.sort((a, b) => b.rank - a.rank);
      const result = out.slice(0, limit).map(({ rank, ...x }) => x);
      if (result.length) this.stats.hits += 1; else this.stats.misses += 1;
      return result;
    } catch (e) {
      if (e.timeout) this.stats.timeouts += 1;
      else { this.stats.errors += 1; if (!this._maybePause(e)) this.log(`[catalog] lookup failed: ${e.message}`); }
      return null;
    }
  }

  // Add products seen on Tavily (write-behind, batched, upsert).
  learn(items) {
    if (this.status !== 'ready' || this.paused) return;
    for (const it of items || []) {
      const doc = productDoc({ name: it.name || it.title, brand: it.brand || '', category: it.category || '', image: it.image || '', source: 'tavily' });
      if (doc) this.pending.set(doc.id, doc);
    }
    if (!this.pending.size || this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  async flush() {
    this.flushTimer = null;
    if (!this.pending.size || this.status !== 'ready') return;
    const docs = [...this.pending.values()].slice(0, 500);
    for (const d of docs) this.pending.delete(d.id);
    try {
      if (!this.exists) {
        await this.client.createIndex(this.indexName, docs);
        this.exists = true;
        await this.load();
      } else {
        await this.client.addDocs(this.indexName, docs, { upsert: true });
      }
      this.stats.learned += docs.length;
      this.log(`[catalog] learned ${docs.length} product name(s) from Tavily`);
    } catch (e) {
      this.stats.errors += 1;
      if (!this._maybePause(e)) this.log(`[catalog] learn failed: ${e.message}`);
    }
    if (this.pending.size) this.learn([]);
  }

  info() {
    return { status: this.paused ? 'paused' : this.status, pausedUntil: this.paused ? new Date(this.pausedUntil).toISOString() : undefined, mode: this.mode || undefined, index: this.indexName, exists: this.exists, reason: this.reason || undefined, pendingLearn: this.pending.size, ...this.stats };
  }
}

module.exports = { Catalog, productDoc, productId, createMossClient, SEP };
