// In-memory stand-in for @moss-dev/moss's MossClient (same method names and shapes).
function fakeMossBackend() {
  const indexes = new Map();
  const calls = [];
  const words = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean));
  const matchFilter = (doc, f) => {
    if (!f) return true;
    if (f.$and) return f.$and.every((x) => matchFilter(doc, x));
    if (f.$or) return f.$or.some((x) => matchFilter(doc, x));
    const v = doc.metadata && doc.metadata[f.field];
    if ('$eq' in f.condition) return v === f.condition.$eq;
    return true;
  };
  class FakeClient {
    constructor(id, key) { this.id = id; this.key = key; }
    async getIndex(name) { calls.push(['getIndex', name]); if (!indexes.has(name)) throw new Error('Index not found'); return { name, docCount: indexes.get(name).size }; }
    async createIndex(name, docs) { calls.push(['createIndex', name]); indexes.set(name, new Map(docs.map((d) => [d.id, d]))); return { indexName: name, docCount: docs.length }; }
    async loadIndex(name, opts) { calls.push(['loadIndex', name, opts]); if (!indexes.has(name)) throw new Error('Index not found'); return name; }
    async addDocs(name, docs, opts) { calls.push(['addDocs', name, docs.length, opts]); const ix = indexes.get(name); for (const d of docs) ix.set(d.id, d); return { jobId: 'j1' }; }
    async query(name, text, opts = {}) {
      calls.push(['query', name, text, opts]);
      const q = words(text);
      const docs = [...indexes.get(name).values()].filter((d) => matchFilter(d, opts.filter)).map((d) => {
        const w = words(d.text);
        const inter = [...q].filter((x) => w.has(x)).length;
        return { ...d, score: inter / Math.max(1, q.size) }; // share of query words found
      }).sort((a, b) => b.score - a.score).slice(0, opts.topK || 5);
      return { docs, query: text, indexName: name, timeTakenInMs: 1 };
    }
  }
  return { factory: async (id, key) => new FakeClient(id, key), calls, indexes };
}
module.exports = { fakeMossBackend };
