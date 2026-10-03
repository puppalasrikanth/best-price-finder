// Best Price Portal — zero-dependency Node server (Node 18+).
// Serves the web UI from ./public and a streaming search API at /api/search (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runSearch } = require('./lib/pipeline');
const { fetchSuggestions, buildSuggestions } = require('./lib/suggest');
const { buildOffers } = require('./lib/extract');
const { Store } = require('./lib/store');
const { Catalog } = require('./lib/catalog');
const { spawn } = require('child_process');

// --- tiny .env loader ---------------------------------------------------------
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = (process.env.TAVILY_API_KEY || '').trim();
const LIVE = /^tvly-/.test(API_KEY) && !/your-key-here/.test(API_KEY);
const ZOOWORK_KEY = /^zwp_/.test((process.env.ZOOWORK_API_KEY || '').trim()) ? process.env.ZOOWORK_API_KEY.trim() : '';
const DEPTH = ['advanced', 'basic', 'fast', 'ultra-fast'].includes(process.env.SEARCH_DEPTH) ? process.env.SEARCH_DEPTH : 'fast';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo.json'), 'utf8'));

const SUGGEST_ENABLED = process.env.SUGGESTIONS !== 'off';

// Freshness windows. "Fresh" results are served straight from Moss; "stale" ones are shown
// instantly as a preview while live data refreshes in the background.
const HOUR = 3600_000;
const TTL = {
  suggest: (Number(process.env.SUGGEST_CACHE_HOURS) || 168) * HOUR,
};

// Moss persistence is switched off unless MOSS_ENABLED=true; the store then runs in memory only.
const MOSS_ON = process.env.MOSS_ENABLED === 'true';
const store = new Store({
  projectId: MOSS_ON ? (process.env.MOSS_PROJECT_ID || '').trim() : '',
  projectKey: MOSS_ON ? (process.env.MOSS_PROJECT_KEY || '').trim() : '',
  indexName: process.env.MOSS_INDEX || 'pricescout-cache',
  cacheDir: path.join(__dirname, '.cache'),
});
const { offerId } = require('./lib/pipeline');

// Product-name catalog in Moss for type-ahead (independent of MOSS_ENABLED, which is for search persistence).
const CATALOG_ON = process.env.MOSS_CATALOG !== 'false';
const catalog = new Catalog({
  projectId: CATALOG_ON ? (process.env.MOSS_PROJECT_ID || '').trim() : '',
  projectKey: CATALOG_ON ? (process.env.MOSS_PROJECT_KEY || '').trim() : '',
  indexName: process.env.CATALOG_INDEX || 'pricescout-products',
  cacheDir: path.join(__dirname, '.cache'),
  timeoutMs: Number(process.env.CATALOG_TIMEOUT_MS) || 400,
});
let importer = null; // running catalog import (child process)
function startCatalogImport() {
  if (importer || catalog.status !== 'ready') return;
  console.log('[catalog] starting the product catalog import in the background (Amazon Reviews 2023 → Moss). Type-ahead uses Tavily until it has data.');
  importer = spawn(process.execPath, [path.join(__dirname, 'scripts', 'import-catalog.js')], { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const relay = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => {
    console.log(l);
    if (/uploaded|import finished/.test(l)) catalog.refresh();
  });
  importer.stdout.on('data', relay);
  importer.stderr.on('data', relay);
  importer.on('exit', (code) => { console.log(`[catalog] import process exited (${code})`); importer = null; catalog.refresh(); });
}
const crypto = require('crypto');
const IMG_DIR = path.join(__dirname, '.cache', 'img');

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  let closed = false;
  req.on('close', () => { closed = true; });
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  return {
    send: (type, data) => { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); },
    end: () => { clearInterval(ping); if (!closed) res.end(); },
  };
}

// Store prices: Moss → (fresh: done) | (stale: instant preview, then live) | live pipeline → save to Moss.
async function handleSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
  const scope = url.searchParams.get('scope') === 'web' ? 'web' : 'stores';
  const { send, end } = openStream(req, res);
  const step = (system, status, detail) => send('step', { system, status, detail });

  if (q.length < 2 || q.length > 120) {
    send('error', { error: 'Enter a product name (2–120 characters).' });
    return end();
  }

  if (!LIVE) {
    const { offers, summary } = buildOffers(DEMO, 'Sony WH-1000XM5');
    step('tavily', 'skipped', 'Demo mode — add TAVILY_API_KEY to .env for live search');
    send('final', { mode: 'demo', query: q, demoQuery: 'Sony WH-1000XM5', scope, offers, summary, verification: 'off', fetchedAt: new Date().toISOString() });
    return end();
  }

  // Stop work (no new ZooWork checks) as soon as the shopper leaves or starts another search.
  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  const started = Date.now();
  console.log(`[search] "${q}" (${scope}) started`);
  try {
    const result = await runSearch({
      query: q, scope, tavilyKey: API_KEY, zooworkKey: ZOOWORK_KEY, depth: DEPTH, store, signal: ctrl.signal,
      emit: (ev) => {
        if (ev.type === 'step') {
          if (ev.system !== 'store') console.log(`  [${ev.system}] ${ev.status}: ${ev.detail}`);
          send('step', ev);
        } else if (ev.type === 'preliminary') {
          send('preliminary', { mode: 'live', query: q, scope, offers: ev.offers, summary: ev.summary, verification: ZOOWORK_KEY ? 'pending' : 'off', fetchedAt: new Date().toISOString() });
        } else if (ev.type === 'offer') {
          send('offer', ev.offer);
        }
      },
    });
    const data = { mode: 'live', query: q, scope, ...result, fetchedAt: new Date().toISOString(), tookMs: Date.now() - started };
    catalog.learn(result.offers.filter((o) => !o.listing && o.title).map((o) => ({ name: o.title, image: o.image, brand: '' })));
    console.log(`[search] "${q}" done: ${result.offers.length} offers, verification=${result.verification}, ${data.tookMs} ms`);
    send('final', { ...data, cached: false });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error(`[search] "${q}" failed:`, err.message);
    if (!ctrl.signal.aborted) send('error', { error: timeout ? 'The search took too long. Please try again.' : err.message || 'Search failed.' });
  }
  end();
}

// Type-ahead: Moss product catalog first (fast); Tavily only when Moss has too few matches or is slow.
// Products found through Tavily are added to the catalog so it keeps growing.
async function handleSuggest(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (q.length < 3 || !SUGGEST_ENABLED) return sendJson(res, 200, { query: q, suggestions: [] });
  const t0 = Date.now();
  const memo = await store.get('suggest', { key: q, query: q, maxAgeMs: TTL.suggest });
  if (memo) return sendJson(res, 200, { query: q, ...memo.payload, cached: true, tookMs: Date.now() - t0 });

  const fromMoss = await catalog.suggest(q); // null = unavailable or slower than CATALOG_TIMEOUT_MS
  if (fromMoss && fromMoss.length >= 3) {
    const payload = { suggestions: fromMoss, source: 'moss' };
    store.put('suggest', { key: q, payload });
    console.log(`[suggest] "${q}" -> ${fromMoss.length} from Moss in ${Date.now() - t0} ms`);
    return sendJson(res, 200, { query: q, ...payload, tookMs: Date.now() - t0 });
  }

  if (!LIVE) {
    const fixtures = ['demo', 'airpods'].map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${f}.json`), 'utf8')));
    const suggestions = [...(fromMoss || []), ...fixtures.flatMap((fx) => buildSuggestions(fx, q))].slice(0, 7);
    return sendJson(res, 200, { query: q, suggestions, source: 'demo', demo: true });
  }
  try {
    const raw = await fetchSuggestions(q, { apiKey: API_KEY });
    const fromTavily = buildSuggestions(raw, q);
    catalog.learn(fromTavily);
    const seen = new Set();
    const suggestions = [...(fromMoss || []), ...fromTavily].filter((x) => {
      const k = x.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').slice(0, 6).join(' ');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 7);
    const payload = { suggestions, source: fromMoss && fromMoss.length ? 'moss+tavily' : 'tavily' };
    store.put('suggest', { key: q, payload });
    console.log(`[suggest] "${q}" -> ${fromMoss ? fromMoss.length : 0} Moss + ${fromTavily.length} Tavily in ${Date.now() - t0} ms`);
    sendJson(res, 200, { query: q, ...payload, tookMs: Date.now() - t0 });
  } catch (err) {
    console.error(`[suggest] "${q}" failed:`, err.message);
    sendJson(res, 200, { query: q, suggestions: fromMoss || [], source: 'moss', error: err.message });
  }
}

// Image streaming cache: product images are fetched once from the store CDN, kept on disk
// (.cache/img) and served with long browser caching, so repeat views render instantly.
const PRIVATE_HOST = /^(localhost|0\.|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[|.*\.local$|.*\.internal$)/i;
const imgInflight = new Map();
async function handleImage(req, res, url) {
  const src = url.searchParams.get('u') || '';
  let u;
  try { u = new URL(src); } catch { res.writeHead(400); return res.end(); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname) || !u.hostname.includes('.')) { res.writeHead(400); return res.end(); }
  const key = crypto.createHash('sha1').update(u.href).digest('hex');
  const file = path.join(IMG_DIR, key);
  const serve = (type, buf, hit) => {
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Image-Cache': hit ? 'hit' : 'miss' });
    res.end(buf);
  };
  try {
    const [buf, type] = await Promise.all([fs.promises.readFile(file), fs.promises.readFile(`${file}.type`, 'utf8')]);
    return serve(type, buf, true);
  } catch {}
  try {
    let p = imgInflight.get(key);
    if (!p) {
      p = (async () => {
        const r = await fetch(u.href, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(8000),
          redirect: 'follow',
        });
        const type = (r.headers.get('content-type') || '').split(';')[0];
        if (!r.ok || !type.startsWith('image/') || type === 'image/svg+xml') throw new Error(`bad image ${r.status} ${type}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) throw new Error('image too large');
        await fs.promises.mkdir(IMG_DIR, { recursive: true });
        await fs.promises.writeFile(file, buf);
        await fs.promises.writeFile(`${file}.type`, type);
        return { buf, type };
      })();
      imgInflight.set(key, p);
      p.finally(() => imgInflight.delete(key)).catch(() => {});
    }
    const { buf, type } = await p;
    serve(type, buf, false);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'max-age=300' });
    res.end();
  }
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end();
  }
  if (url.pathname === '/api/search') return void handleSearch(req, res, url);
  if (url.pathname === '/img') return void handleImage(req, res, url);
  if (url.pathname === '/api/suggest') return void handleSuggest(req, res, url);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: LIVE ? 'live' : 'demo', depth: DEPTH, verification: ZOOWORK_KEY ? 'zoowork' : 'off', moss: MOSS_ON ? store.info() : 'disabled', catalog: { ...catalog.info(), importing: !!importer } });
  serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  PriceScout — powered by ZooWork & Tavily\n  Running at http://localhost:${PORT}`);
    console.log(LIVE
      ? `  Mode: LIVE (Tavily ${DEPTH} search, ${DEPTH === 'advanced' ? 2 : 1} credit(s) per search)\n`
      : '  Mode: DEMO — add your Tavily key to .env (TAVILY_API_KEY=tvly-...) and restart for live results\n');
    console.log(ZOOWORK_KEY ? '  Price verification: ZooWork agent (checks each store page)\n' : '  Price verification: OFF — add ZOOWORK_API_KEY to .env to verify prices\n');
    console.log(MOSS_ON ? '  Persistence: Moss (loading index…)\n' : '  Persistence: off (Moss disabled) — store confirmations kept in memory for this session\n');
    console.log(catalog.status === 'off' ? '  Type-ahead: Tavily (add MOSS_PROJECT_ID / MOSS_PROJECT_KEY for the Moss product catalog)\n' : '  Type-ahead: Moss product catalog first, Tavily fallback\n');
  });
  store.init();
  catalog.init().then(() => {
    if (catalog.status !== 'ready') return;
    let state = {};
    try { state = JSON.parse(fs.readFileSync(path.join(__dirname, '.cache', 'catalog-import.json'), 'utf8')); } catch {}
    if (process.env.CATALOG_AUTO_IMPORT !== 'false' && !state.completedAt) startCatalogImport();
  });
  const flushAndExit = () => {
    if (importer) importer.kill();
    Promise.allSettled([store.flush(), catalog.flush()]).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);
}

module.exports = server;
module.exports.store = store;
module.exports.catalog = catalog;
