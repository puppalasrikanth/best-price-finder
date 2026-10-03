// Best Price Portal — zero-dependency Node server (Node 18+).
// Serves the web UI from ./public and a streaming search API at /api/search (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runSearch } = require('./lib/pipeline');
const { fetchTrend, analyzeTrend } = require('./lib/trend');
const { fetchSuggestions, buildSuggestions } = require('./lib/suggest');
const { buildOffers } = require('./lib/extract');
const { Store } = require('./lib/store');

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
const DEPTH = process.env.SEARCH_DEPTH === 'basic' ? 'basic' : 'advanced';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo.json'), 'utf8'));

const SUGGEST_ENABLED = process.env.SUGGESTIONS !== 'off';
const DEMO_TREND = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trend-demo.json'), 'utf8'));

// Freshness windows. "Fresh" results are served straight from Moss; "stale" ones are shown
// instantly as a preview while live data refreshes in the background.
const HOUR = 3600_000;
const TTL = {
  searchFresh: (Number(process.env.CACHE_MINUTES) || 30) * 60_000,
  searchStale: (Number(process.env.SEARCH_STALE_HOURS) || 48) * HOUR,
  trendFresh: (Number(process.env.TREND_CACHE_HOURS) || 12) * HOUR,
  trendStale: (Number(process.env.TREND_STALE_DAYS) || 14) * 24 * HOUR,
  suggest: (Number(process.env.SUGGEST_CACHE_HOURS) || 168) * HOUR,
};

const store = new Store({
  projectId: (process.env.MOSS_PROJECT_ID || '').trim(),
  projectKey: (process.env.MOSS_PROJECT_KEY || '').trim(),
  indexName: process.env.MOSS_INDEX || 'pricescout-cache',
  cacheDir: path.join(__dirname, '.cache'),
});
const trendInflight = new Map(); // query -> Promise<raw>

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function hitDetail(hit) {
  const what = hit.match === 'semantic' ? `similar search “${hit.matchedQuery}”` : 'this search';
  return `Moss: saved results for ${what} from ${ago(hit.ageMs)} · looked up in ${hit.tookMs} ms`;
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

  const hit = await store.get('search', { key: q, query: q, scope, maxAgeMs: TTL.searchStale, semantic: true });
  if (hit && hit.ageMs < TTL.searchFresh) {
    console.log(`[search] "${q}" served from ${hit.match} (${hit.tookMs} ms)`);
    step('moss', 'done', hitDetail(hit));
    for (const sys of ['tavily', 'parser', 'zoowork']) step(sys, 'done', `Loaded from Moss · saved ${ago(hit.ageMs)}`);
    send('final', { ...hit.payload, query: q, cached: true, cache: { ageMs: hit.ageMs, match: hit.match, matchedQuery: hit.matchedQuery, tookMs: hit.tookMs } });
    return end();
  }
  if (hit) {
    step('moss', 'done', `${hitDetail(hit)} — showing them while refreshing live`);
    send('preliminary', { ...hit.payload, query: q, stale: true, cache: { ageMs: hit.ageMs, match: hit.match, matchedQuery: hit.matchedQuery, tookMs: hit.tookMs } });
  } else {
    step('moss', 'done', store.enabled ? 'Moss: nothing saved yet for this product — searching live' : `Saved results unavailable (${store.reason || store.status})`);
  }

  const started = Date.now();
  console.log(`[search] "${q}" (${scope}) started${hit ? ' (stale preview sent)' : ''}`);
  try {
    const result = await runSearch({
      query: q, scope, tavilyKey: API_KEY, zooworkKey: ZOOWORK_KEY, depth: DEPTH,
      emit: (ev) => {
        if (ev.type === 'step') {
          console.log(`  [${ev.system}] ${ev.status}: ${ev.detail}`);
          send('step', ev);
        } else if (ev.type === 'preliminary' && !hit) {
          // With a saved preview on screen, skip the unverified snippet prices.
          send('preliminary', { mode: 'live', query: q, scope, offers: ev.offers, summary: ev.summary, verification: ZOOWORK_KEY ? 'pending' : 'off', fetchedAt: new Date().toISOString() });
        }
      },
    });
    const data = { mode: 'live', query: q, scope, ...result, fetchedAt: new Date().toISOString(), tookMs: Date.now() - started };
    if (result.verification !== 'failed' && result.offers.length) {
      const best = result.summary.bestNew || result.summary.bestAny;
      store.put('search', { key: q, query: q, scope, text: [q, best && best.title].filter(Boolean).join(' | '), payload: data });
      step('moss', 'done', 'Saved to Moss for instant repeat searches');
    }
    console.log(`[search] "${q}" done: ${result.offers.length} offers, verification=${result.verification}, ${data.tookMs} ms`);
    send('final', { ...data, cached: false });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error(`[search] "${q}" failed:`, err.message);
    if (hit) {
      step('tavily', 'error', `${err.message} — keeping the saved results`);
      send('final', { ...hit.payload, query: q, stale: true, cached: true, cache: { ageMs: hit.ageMs, match: hit.match, matchedQuery: hit.matchedQuery } });
    } else {
      send('error', { error: timeout ? 'The search took too long. Please try again.' : err.message || 'Search failed.' });
    }
  }
  end();
}

// Type-ahead: Tavily-backed product suggestions (JSON), persisted in Moss.
async function handleSuggest(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (q.length < 3 || !SUGGEST_ENABLED) return sendJson(res, 200, { query: q, suggestions: [] });
  if (!LIVE) {
    const fixtures = ['demo', 'airpods'].map((f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${f}.json`), 'utf8')));
    const suggestions = fixtures.flatMap((fx) => buildSuggestions(fx, q));
    return sendJson(res, 200, { query: q, suggestions: suggestions.slice(0, 7), demo: true });
  }
  const hit = await store.get('suggest', { key: q, query: q, maxAgeMs: TTL.suggest });
  if (hit) return sendJson(res, 200, { query: q, suggestions: hit.payload, cached: hit.match, tookMs: hit.tookMs });
  try {
    const t0 = Date.now();
    const raw = await fetchSuggestions(q, { apiKey: API_KEY });
    const suggestions = buildSuggestions(raw, q);
    store.put('suggest', { key: q, query: q, text: [q, ...suggestions.map((s) => s.name)].join(' | '), payload: suggestions });
    console.log(`[suggest] "${q}" -> ${suggestions.length} in ${Date.now() - t0} ms`);
    sendJson(res, 200, { query: q, suggestions });
  } catch (err) {
    console.error(`[suggest] "${q}" failed:`, err.message);
    sendJson(res, 200, { query: q, suggestions: [], error: err.message });
  }
}

// 6-month price history (ZooWork agent) + 30-day projection, persisted in Moss, streamed as SSE.
async function handleTrend(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
  const price = Number(url.searchParams.get('price')) || null;
  const { send, end } = openStream(req, res);
  const step = (status, detail) => send('step', { system: 'trend', status, detail });
  if (q.length < 2 || q.length > 120) { send('error', { error: 'Enter a product name.' }); return end(); }

  if (!LIVE) {
    step('done', 'Demo mode — sample price history');
    send('final', { query: q, demo: true, trend: analyzeTrend(DEMO_TREND, { currentPrice: price }) });
    return end();
  }

  const hit = await store.get('trend', { key: q, query: q, maxAgeMs: TTL.trendStale, semantic: true });
  const cacheInfo = hit && { ageMs: hit.ageMs, match: hit.match, matchedQuery: hit.matchedQuery, tookMs: hit.tookMs };
  if (hit && (hit.ageMs < TTL.trendFresh || !ZOOWORK_KEY)) {
    step('done', `Loaded from Moss · price history saved ${ago(hit.ageMs)} (${hit.tookMs} ms)`);
    send('final', { query: q, trend: analyzeTrend(hit.payload, { currentPrice: price }), cache: cacheInfo });
    return end();
  }
  if (!ZOOWORK_KEY) {
    step('skipped', 'Add ZOOWORK_API_KEY to .env to see price trends');
    send('final', { query: q, trend: { ok: false, reason: 'Price trends need a ZooWork API key.' } });
    return end();
  }
  if (hit) {
    step('running', `Showing price history saved ${ago(hit.ageMs)} (Moss) while ZooWork refreshes it…`);
    send('preliminary', { query: q, trend: analyzeTrend(hit.payload, { currentPrice: price }), stale: true, cache: cacheInfo });
  }

  const key = q.toLowerCase();
  try {
    const t0 = Date.now();
    let p = trendInflight.get(key);
    if (!p) {
      p = fetchTrend({
        apiKey: ZOOWORK_KEY, query: q,
        timeoutMs: Number(process.env.ZOOWORK_TREND_TIMEOUT_MS) || 300000,
        emit: (status, detail) => { console.log(`  [trend] ${status}: ${detail}`); step(status, detail); },
        onUrl: (host, status) => send('step', { system: 'trend-source', status, detail: host }),
      });
      trendInflight.set(key, p);
      p.finally(() => trendInflight.delete(key)).catch(() => {});
    } else {
      step('running', 'Joining a price-history lookup already in progress…');
    }
    const raw = await p;
    const trend = analyzeTrend(raw, { currentPrice: price });
    if (trend.ok) store.put('trend', { key: q, query: q, text: [q, trend.product].filter(Boolean).join(' | '), payload: raw });
    step('done', `Price history gathered in ${Math.round((Date.now() - t0) / 1000)}s${trend.ok ? ' · saved to Moss' : ''}`);
    send('final', { query: q, trend });
  } catch (err) {
    console.error(`[trend] "${q}" failed:`, err.message);
    if (hit) {
      step('error', `${err.message} — keeping the saved price history`);
      send('final', { query: q, trend: analyzeTrend(hit.payload, { currentPrice: price }), stale: true, cache: cacheInfo });
    } else {
      step('error', err.message);
      send('final', { query: q, trend: { ok: false, reason: err.message } });
    }
  }
  end();
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
  if (url.pathname === '/api/trend') return void handleTrend(req, res, url);
  if (url.pathname === '/api/suggest') return void handleSuggest(req, res, url);
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: LIVE ? 'live' : 'demo', depth: DEPTH, verification: ZOOWORK_KEY ? 'zoowork' : 'off', moss: store.info() });
  serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Best Price Portal running at http://localhost:${PORT}`);
    console.log(LIVE
      ? `  Mode: LIVE (Tavily ${DEPTH} search, ${DEPTH === 'advanced' ? 2 : 1} credit(s) per new search)\n`
      : '  Mode: DEMO — add your Tavily key to .env (TAVILY_API_KEY=tvly-...) and restart for live results\n');
    console.log(ZOOWORK_KEY ? '  Price verification: ZooWork agent (checks each store page)\n' : '  Price verification: OFF — add ZOOWORK_API_KEY to .env to verify prices\n');
    console.log(store.status === 'off' ? '  Persistence: in-memory only — add MOSS_PROJECT_ID and MOSS_PROJECT_KEY to .env to persist results in Moss\n' : '  Persistence: Moss (loading index…)\n');
  });
  store.init();
  const flushAndExit = () => { store.flush().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);
}

module.exports = server;
module.exports.store = store;
