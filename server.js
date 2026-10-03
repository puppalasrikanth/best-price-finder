// Best Price Portal — zero-dependency Node server (Node 18+).
// Serves the web UI from ./public and a streaming search API at /api/search (SSE).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { runSearch } = require('./lib/pipeline');
const { fetchTrend, analyzeTrend } = require('./lib/trend');
const { buildOffers } = require('./lib/extract');

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
const CACHE_MINUTES = Number(process.env.CACHE_MINUTES) || 30;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEMO = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'demo.json'), 'utf8'));

const cache = new Map(); // key -> { at, data }
const trendCache = new Map(); // query -> { at, raw }
const trendInflight = new Map(); // query -> Promise<raw>
const TREND_CACHE_HOURS = Number(process.env.TREND_CACHE_HOURS) || 12;
const DEMO_TREND = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'trend-demo.json'), 'utf8'));

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

// Streams progress as Server-Sent Events: step / preliminary / final / error.
async function handleSearch(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ');
  const scope = url.searchParams.get('scope') === 'web' ? 'web' : 'stores';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (type, data) => { if (!closed) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  const finish = () => { clearInterval(ping); if (!closed) res.end(); };

  if (q.length < 2 || q.length > 120) {
    send('error', { error: 'Enter a product name (2–120 characters).' });
    return finish();
  }

  if (!LIVE) {
    const { offers, summary } = buildOffers(DEMO, 'Sony WH-1000XM5');
    send('step', { system: 'tavily', status: 'skipped', detail: 'Demo mode — add TAVILY_API_KEY to .env for live search' });
    send('final', { mode: 'demo', query: q, demoQuery: 'Sony WH-1000XM5', scope, offers, summary, verification: 'off', fetchedAt: new Date().toISOString() });
    return finish();
  }

  const key = `${scope}|${q.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MINUTES * 60_000) {
    send('step', { system: 'cache', status: 'done', detail: `Using results from ${Math.round((Date.now() - hit.at) / 60000)} min ago (no credits used)` });
    send('final', { ...hit.data, cached: true });
    return finish();
  }

  const started = Date.now();
  console.log(`[search] "${q}" (${scope}) started`);
  try {
    const result = await runSearch({
      query: q, scope, tavilyKey: API_KEY, zooworkKey: ZOOWORK_KEY, depth: DEPTH,
      emit: (ev) => {
        if (ev.type === 'step') {
          console.log(`  [${ev.system}] ${ev.status}: ${ev.detail}`);
          send('step', ev);
        } else if (ev.type === 'preliminary') {
          send('preliminary', { mode: 'live', query: q, scope, offers: ev.offers, summary: ev.summary, verification: ZOOWORK_KEY ? 'pending' : 'off', fetchedAt: new Date().toISOString() });
        }
      },
    });
    const data = { mode: 'live', query: q, scope, ...result, fetchedAt: new Date().toISOString(), tookMs: Date.now() - started };
    if (result.verification !== 'failed') {
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    console.log(`[search] "${q}" done: ${result.offers.length} offers, verification=${result.verification}, ${data.tookMs} ms`);
    send('final', { ...data, cached: false });
  } catch (err) {
    const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error(`[search] "${q}" failed:`, err.message);
    send('error', { error: timeout ? 'The search took too long. Please try again.' : err.message || 'Search failed.' });
  }
  finish();
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

// 6-month price history (ZooWork agent) + 30-day projection, streamed as SSE.
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
  if (!ZOOWORK_KEY) {
    step('skipped', 'Add ZOOWORK_API_KEY to .env to see price trends');
    send('final', { query: q, trend: { ok: false, reason: 'Price trends need a ZooWork API key.' } });
    return end();
  }

  const key = q.toLowerCase();
  const hit = trendCache.get(key);
  try {
    let raw;
    if (hit && Date.now() - hit.at < TREND_CACHE_HOURS * 3600_000) {
      step('done', `Using price history gathered ${Math.max(1, Math.round((Date.now() - hit.at) / 60000))} min ago`);
      raw = hit.raw;
    } else {
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
      raw = await p;
      trendCache.set(key, { at: Date.now(), raw });
      step('done', `Price history gathered in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    const trend = analyzeTrend(raw, { currentPrice: price });
    if (!trend.ok) trendCache.delete(key);
    send('final', { query: q, trend });
  } catch (err) {
    console.error(`[trend] "${q}" failed:`, err.message);
    step('error', err.message);
    send('final', { query: q, trend: { ok: false, reason: err.message } });
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
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, mode: LIVE ? 'live' : 'demo', depth: DEPTH, verification: ZOOWORK_KEY ? 'zoowork' : 'off' });
  serveStatic(req, res, url);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Best Price Portal running at http://localhost:${PORT}`);
    console.log(LIVE
      ? `  Mode: LIVE (Tavily ${DEPTH} search, ${DEPTH === 'advanced' ? 2 : 1} credit(s) per new search, ${CACHE_MINUTES} min cache)\n`
      : '  Mode: DEMO — add your Tavily key to .env (TAVILY_API_KEY=tvly-...) and restart for live results\n');
    console.log(ZOOWORK_KEY ? '  Price verification: ZooWork agent (checks each store page)\n' : '  Price verification: OFF — add ZOOWORK_API_KEY to .env to verify prices\n');
  });
}

module.exports = server;
