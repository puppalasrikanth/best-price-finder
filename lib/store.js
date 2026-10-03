// Persistence layer: every Tavily / ZooWork result is saved to a Moss index
// (https://github.com/usemoss/moss) and looked up before calling the APIs again.
//
// Moss downloads the index into this process (loadIndex), so lookups are local and take
// a few milliseconds. Lookups are exact (same normalized query) or semantic (a differently
// worded query for the same product), guarded so model numbers must match exactly
// ("AirPods Pro 2" never matches "AirPods Pro 3").
//
// Writes are write-behind: kept in memory immediately, batched to Moss in the background.
// If Moss is not configured or unreachable, the store falls back to memory only.
const path = require('path');
const crypto = require('crypto');
const { queryTokens, relevance } = require('./extract');

const MAX_PAYLOAD = 200_000; // chars of JSON per document

const normKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const docId = (kind, scope, key) => `${kind}-${scope || 'any'}-${crypto.createHash('sha1').update(normKey(key)).digest('hex').slice(0, 16)}`;

// Same product? Every model-like token (has a digit) must match in both directions,
// and most words must overlap.
// `context` is the saved document's text (query + product title), used for word overlap only.
function sameProduct(a, b, context = '') {
  const ta = queryTokens(a);
  const tb = queryTokens(b);
  if (!ta.length || !tb.length) return false;
  const models = (t) => [...new Set(t.filter((x) => /\d/.test(x)))].sort().join(' ');
  if (models(ta) !== models(tb)) return false;
  return relevance(`${b} ${context}`, ta) >= 0.75 && relevance(a, tb) >= 0.75;
}

class Store {
  constructor({ projectId, projectKey, indexName = 'pricescout-cache', cacheDir, log = console.log, clientFactory, flushMs = 1500, semanticMinScore = 0.35 } = {}) {
    this.projectId = projectId;
    this.projectKey = projectKey;
    this.indexName = indexName;
    this.cacheDir = cacheDir;
    this.log = log;
    this.clientFactory = clientFactory;
    this.flushMs = flushMs;
    this.semanticMinScore = semanticMinScore;
    this.mem = new Map(); // id -> doc record
    this.pending = new Map(); // id -> DocumentInfo waiting to be written
    this.status = projectId && projectKey ? 'connecting' : 'off';
    this.reason = projectId && projectKey ? '' : 'MOSS_PROJECT_ID / MOSS_PROJECT_KEY not set';
    this.client = null;
    this.flushTimer = null;
    this.flushing = null;
    this.stats = { hits: 0, semanticHits: 0, misses: 0, writes: 0, errors: 0 };
    this.mode = null; // 'local' (index loaded in-process) | 'cloud' (Moss cloud query API)
    this.retryTimer = null;
    this.lookupTimeoutMs = 2500;
  }

  get enabled() { return this.status === 'ready'; }

  async init() {
    if (this.status === 'off') return this;
    const t0 = Date.now();
    try {
      let MossClient;
      if (this.clientFactory) {
        this.client = await this.clientFactory(this.projectId, this.projectKey);
      } else {
        let mod;
        try { mod = await import('@moss-dev/moss'); } catch { mod = await import('@moss-js/moss'); }
        MossClient = mod.MossClient || (mod.default && mod.default.MossClient);
        this.client = new MossClient(this.projectId, this.projectKey);
      }
      let exists = true;
      try { await this.client.getIndex(this.indexName); } catch { exists = false; }
      if (!exists) {
        this.log(`[moss] creating index "${this.indexName}"…`);
        await this.client.createIndex(this.indexName, [{
          id: 'meta-schema',
          text: 'PriceScout cache index',
          metadata: { kind: 'meta', scope: 'any', key: 'schema', query: 'schema', saved_at: new Date().toISOString(), payload: '{"v":1}' },
        }]);
      }
      this.status = 'ready';
      await this._loadLocal(t0);
    } catch (e) {
      this.status = 'error';
      this.reason = e && e.code === 'ERR_MODULE_NOT_FOUND'
        ? 'Moss SDK not installed — run "npm install" in the project folder'
        : `Moss unavailable: ${e.message}`;
      this.log(`[moss] ${this.reason} — using in-memory cache only`);
    }
    return this;
  }

  // Loads the index into this process for ms lookups. If that fails (for example the embedding
  // model download is refused), keep working through Moss's cloud query API and retry later.
  async _loadLocal(t0 = Date.now()) {
    try {
      await this.client.loadIndex(this.indexName, {
        autoRefresh: true,
        pollingIntervalInSeconds: 60,
        ...(this.cacheDir ? { cachePath: path.join(this.cacheDir, 'moss') } : {}),
      });
      this.mode = 'local';
      this.reason = '';
      clearInterval(this.retryTimer);
      this.retryTimer = null;
      this.log(`[moss] index "${this.indexName}" loaded in ${Date.now() - t0} ms — lookups are now local`);
    } catch (e) {
      const first = this.mode !== 'cloud';
      this.mode = 'cloud';
      this.reason = `Local index load failed (${String(e.message).slice(0, 160)}) — using Moss cloud lookups`;
      if (first) this.log(`[moss] ${this.reason}; retrying local load every 15 min`);
      if (!this.retryTimer) {
        this.retryTimer = setInterval(() => this._loadLocal(), 15 * 60_000);
        if (this.retryTimer.unref) this.retryTimer.unref();
      }
    }
  }

  _withTimeout(p) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out after ${this.lookupTimeoutMs} ms`)), this.lookupTimeoutMs); })])
      .finally(() => clearTimeout(t));
  }

  // Cloud mode: the query API may not apply metadata filters or return metadata, so filter by
  // our id prefix (ids encode kind and scope) and fetch full documents by id.
  async _cloudLookup(kind, scope, id, query, semantic) {
    const exactDocs = await this._withTimeout(this.client.getDocs(this.indexName, { docIds: [id] })).catch(() => []);
    const exact = (exactDocs || []).find((d) => d && d.id === id && d.metadata);
    if (exact) return { doc: exact, match: 'exact', score: 1 };
    if (!semantic) return null;
    const res = await this._withTimeout(this.client.query(this.indexName, normKey(query) || String(query), { topK: 10, alpha: 0.5 }));
    const prefix = `${kind}-${scope || 'any'}-`;
    const cands = ((res && res.docs) || []).filter((d) => d && String(d.id).startsWith(prefix) && d.score >= this.semanticMinScore);
    if (!cands.length) return null;
    const missing = cands.filter((d) => !d.metadata).map((d) => d.id);
    let full = new Map(cands.filter((d) => d.metadata).map((d) => [d.id, d]));
    if (missing.length) {
      const fetched = await this._withTimeout(this.client.getDocs(this.indexName, { docIds: missing })).catch(() => []);
      for (const d of fetched || []) if (d && d.metadata) full.set(d.id, { ...d, score: (cands.find((c) => c.id === d.id) || {}).score });
    }
    for (const c of cands) {
      const d = full.get(c.id);
      if (d && sameProduct(query, d.metadata.query, d.text)) return { doc: d, match: 'semantic', score: c.score };
    }
    return null;
  }

  _record(doc) {
    let payload = null;
    try { payload = JSON.parse(doc.metadata.payload); } catch {}
    return {
      id: doc.id,
      kind: doc.metadata.kind,
      scope: doc.metadata.scope,
      key: doc.metadata.key,
      query: doc.metadata.query,
      savedAt: Date.parse(doc.metadata.saved_at) || 0,
      payload,
    };
  }

  // Returns { payload, ageMs, savedAt, match: 'memory'|'exact'|'semantic', score, matchedQuery, tookMs } or null.
  async get(kind, { key, query = key, scope = 'any', maxAgeMs = Infinity, semantic = false } = {}) {
    const t0 = process.hrtime.bigint();
    const done = (rec, match, score) => {
      const tookMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!rec) { this.stats.misses += 1; return null; }
      const ageMs = Date.now() - rec.savedAt;
      if (ageMs > maxAgeMs || !rec.payload) { this.stats.misses += 1; return null; }
      this.stats.hits += 1;
      if (match === 'semantic') this.stats.semanticHits += 1;
      return { payload: rec.payload, ageMs, savedAt: rec.savedAt, match, score, matchedQuery: rec.query, tookMs: Math.round(tookMs * 10) / 10 };
    };

    const id = docId(kind, scope, key);
    const local = this.mem.get(id);
    if (local) return done(local, 'memory', 1);
    if (!this.enabled) return done(null);

    try {
      if (this.mode !== 'local') {
        const found = await this._cloudLookup(kind, scope, id, query, semantic);
        if (!found) return done(null);
        const rec = this._record(found.doc);
        if (found.match === 'exact') this.mem.set(id, rec);
        return done(rec, found.match, found.score);
      }
      const res = await this._withTimeout(this.client.query(this.indexName, normKey(query) || String(query), {
        topK: 5,
        alpha: 0.5, // half semantic, half keyword
        filter: { $and: [
          { field: 'kind', condition: { $eq: kind } },
          { field: 'scope', condition: { $eq: scope || 'any' } },
        ] },
      }));
      const docs = (res && res.docs) || [];
      // Exact key first.
      const exact = docs.find((d) => d.id === id) || docs.find((d) => d.metadata && normKey(d.metadata.key) === normKey(key));
      if (exact) {
        const rec = this._record(exact);
        this.mem.set(id, rec);
        return done(rec, 'exact', exact.score);
      }
      if (semantic) {
        const hit = docs.find((d) => d.score >= this.semanticMinScore && d.metadata && sameProduct(query, d.metadata.query, d.text));
        if (hit) return done(this._record(hit), 'semantic', hit.score);
      }
      return done(null);
    } catch (e) {
      this.stats.errors += 1;
      this.log(`[moss] lookup failed: ${e.message}`);
      return done(null);
    }
  }

  // Saves immediately in memory; writes to Moss in the background.
  put(kind, { key, query = key, scope = 'any', text, payload }) {
    let json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD) {
      this.log(`[moss] payload for "${key}" is ${json.length} chars — not persisted`);
      json = null;
    }
    const savedAt = new Date().toISOString();
    const id = docId(kind, scope, key);
    this.mem.set(id, { id, kind, scope, key, query, savedAt: Date.parse(savedAt), payload });
    if (this.mem.size > 5000) this.mem.delete(this.mem.keys().next().value);
    if (!this.enabled || !json) return;
    this.pending.set(id, {
      id,
      // Add compact tokens ("wh1000xm5" for "WH-1000XM5") so keyword search matches either spelling.
      text: `${String(text || query).slice(0, 1600)} | ${[...new Set(queryTokens(`${query} ${text || ''}`))].join(' ')}`.slice(0, 2000),
      metadata: { kind, scope: scope || 'any', key: normKey(key), query: String(query).slice(0, 200), saved_at: savedAt, payload: json },
    });
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
  }

  async flush() {
    if (this.flushing) { await this.flushing; }
    if (!this.pending.size || !this.enabled) return;
    const docs = [...this.pending.values()];
    this.pending.clear();
    const t0 = Date.now();
    this.flushing = this.client.addDocs(this.indexName, docs, { upsert: true })
      .then(() => {
        this.stats.writes += docs.length;
        this.log(`[moss] saved ${docs.length} document(s) in ${Date.now() - t0} ms`);
      })
      .catch((e) => {
        this.stats.errors += 1;
        this.log(`[moss] save failed (${e.message}) — will retry`);
        for (const d of docs) if (!this.pending.has(d.id)) this.pending.set(d.id, d);
        clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => this.flush(), 15000);
      })
      .finally(() => { this.flushing = null; });
    await this.flushing;
  }

  info() {
    return { status: this.status, mode: this.mode || undefined, reason: this.reason || undefined, index: this.indexName, memoryEntries: this.mem.size, pendingWrites: this.pending.size, ...this.stats };
  }
}

module.exports = { Store, sameProduct, docId, normKey };
