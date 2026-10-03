#!/usr/bin/env node
// Seeds the Moss product catalog with the most-reviewed products from Amazon Reviews 2023
// (McAuley Lab, https://amazon-reviews-2023.github.io). Streams each category's gzipped
// metadata once (nothing large is kept on disk), keeps the top-N by number of ratings,
// cleans the names, and uploads each category to Moss as soon as it's done.
//
//   node scripts/import-catalog.js            # import (resumes where it left off)
//   node scripts/import-catalog.js --restart  # start over
//
// Env: MOSS_PROJECT_ID, MOSS_PROJECT_KEY, CATALOG_INDEX, CATALOG_SIZE, CATALOG_CATEGORIES,
//      CATALOG_BASE_URL (override the download location)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { productDoc, createMossClient } = require('../lib/catalog');

const BASE_URL = process.env.CATALOG_BASE_URL || 'https://mcauleylab.ucsd.edu/public_datasets/data/amazon_2023/raw/meta_categories';
// Hugging Face mirror (uncompressed, ~4× more to download) — used only if CATALOG_ALLOW_HF=true.
const HF_URL = 'https://huggingface.co/datasets/McAuley-Lab/Amazon-Reviews-2023/resolve/main/raw/meta_categories';
const STATE_FILE = process.env.CATALOG_STATE_FILE || path.join(__dirname, '..', '.cache', 'catalog-import.json');

// Shopping-relevant categories, smallest first, with their share of the catalog.
const DEFAULT_CATEGORIES = [
  ['Appliances', 0.10],
  ['Video_Games', 0.10],
  ['Musical_Instruments', 0.06],
  ['Office_Products', 0.08],
  ['Toys_and_Games', 0.16],
  ['Cell_Phones_and_Accessories', 0.18],
  ['Electronics', 0.32],
];

// Small binary min-heap keyed on rating count.
class TopN {
  constructor(n) { this.n = n; this.a = []; }
  get min() { return this.a.length < this.n ? -1 : this.a[0].pop; }
  push(item) {
    const a = this.a;
    if (a.length < this.n) { a.push(item); this._up(a.length - 1); return; }
    if (item.pop <= a[0].pop) return;
    a[0] = item; this._down(0);
  }
  _up(i) { const a = this.a; while (i > 0) { const p = (i - 1) >> 1; if (a[p].pop <= a[i].pop) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  _down(i) { const a = this.a; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].pop < a[m].pop) m = l; if (r < a.length && a[r].pop < a[m].pop) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
  sorted() { return [...this.a].sort((x, y) => y.pop - x.pop); }
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { done: {}, names: 0 }; } }
function writeState(s) { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function mainImage(images) {
  const list = Array.isArray(images) ? images : [];
  const main = list.find((i) => i && i.variant === 'MAIN') || list[0];
  return main ? main.large || main.hi_res || main.thumb || '' : '';
}

async function scanCategory(category, quota, { baseUrl, log, fetchImpl = fetch }) {
  let url = `${baseUrl}/meta_${category}.jsonl.gz`;
  let gz = true;
  let res = await fetchImpl(url).catch((e) => ({ ok: false, status: e.message }));
  if ((!res.ok || !res.body) && process.env.CATALOG_ALLOW_HF === 'true') {
    log(`[catalog] ${category}: ${url} unavailable (${res.status}) — using the Hugging Face mirror (larger, uncompressed download)`);
    url = `${HF_URL}/meta_${category}.jsonl`;
    gz = false;
    res = await fetchImpl(url).catch((e) => ({ ok: false, status: e.message }));
  }
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}${process.env.CATALOG_ALLOW_HF === 'true' ? '' : ' — set CATALOG_ALLOW_HF=true in .env to use the Hugging Face mirror instead'}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let bytes = 0;
  const body = Readable.fromWeb ? Readable.fromWeb(res.body) : res.body;
  body.on('data', (c) => { bytes += c.length; });
  const lines = readline.createInterface({ input: gz ? body.pipe(zlib.createGunzip()) : body, crlfDelay: Infinity });
  const top = new TopN(quota);
  let scanned = 0;
  let lastLog = Date.now();
  const RATING = /"rating_number":\s*(\d+)/;
  for await (const line of lines) {
    scanned += 1;
    const m = RATING.exec(line);
    const pop = m ? Number(m[1]) : 0;
    if (pop <= top.min || pop < 5) continue; // cheap skip before JSON.parse
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j.title) continue;
    top.push({ pop, title: j.title, brand: j.store || '', image: mainImage(j.images), category: j.main_category || category.replace(/_/g, ' ') });
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const pct = total ? ` (${Math.round((bytes / total) * 100)}% of ${(total / 1e9).toFixed(2)} GB)` : ` (${(bytes / 1e9).toFixed(2)} GB)`;
      log(`[catalog] ${category}: scanned ${scanned.toLocaleString()} products${pct}, keeping top ${top.a.length.toLocaleString()}`);
    }
  }
  log(`[catalog] ${category}: scanned ${scanned.toLocaleString()} products, kept ${top.a.length.toLocaleString()}`);
  return top.sorted();
}

async function runImport({ client, indexName = process.env.CATALOG_INDEX || 'pricescout-products', size = Number(process.env.CATALOG_SIZE) || 100_000, categories, baseUrl = BASE_URL, restart = false, log = console.log, fetchImpl } = {}) {
  const cats = categories || (process.env.CATALOG_CATEGORIES
    ? process.env.CATALOG_CATEGORIES.split(',').map((c) => c.trim()).filter(Boolean).map((c, _, all) => [c, 1 / all.length])
    : DEFAULT_CATEGORIES);
  const weightSum = cats.reduce((s, [, w]) => s + w, 0);
  const state = restart ? { done: {}, names: 0 } : readState();
  let exists = true;
  try { await client.getIndex(indexName); } catch { exists = false; }
  if (restart && exists) { try { await client.deleteIndex(indexName); } catch {} exists = false; }
  const seen = new Set();
  const t0 = Date.now();
  log(`[catalog] importing up to ${size.toLocaleString()} products from Amazon Reviews 2023 into Moss index "${indexName}"`);
  for (const [category, w] of cats) {
    if (state.done[category]) { log(`[catalog] ${category}: already imported (${state.done[category]} products) — skipping`); continue; }
    const quota = Math.max(100, Math.round((size * w) / weightSum));
    const c0 = Date.now();
    const items = await scanCategory(category, quota, { baseUrl, log, fetchImpl });
    const docs = [];
    for (const it of items) {
      const doc = productDoc({ name: it.title, brand: it.brand, category: it.category, image: it.image, popularity: it.pop, source: 'amazon2023' });
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      docs.push(doc);
    }
    for (let i = 0; i < docs.length; i += 5000) {
      const chunk = docs.slice(i, i + 5000);
      if (!exists) { await client.createIndex(indexName, chunk); exists = true; }
      else await client.addDocs(indexName, chunk, { upsert: true });
      log(`[catalog] ${category}: uploaded ${Math.min(i + 5000, docs.length).toLocaleString()} / ${docs.length.toLocaleString()} to Moss`);
    }
    state.done[category] = docs.length;
    state.names = Object.values(state.done).reduce((s, n) => s + n, 0);
    state.updatedAt = new Date().toISOString();
    writeState(state);
    log(`[catalog] ${category}: done in ${Math.round((Date.now() - c0) / 1000)}s — catalog now has ${state.names.toLocaleString()} products`);
  }
  state.completedAt = new Date().toISOString();
  writeState(state);
  log(`[catalog] import finished in ${Math.round((Date.now() - t0) / 60000)} min — ${state.names.toLocaleString()} products in Moss`);
  return state;
}

module.exports = { runImport, scanCategory, TopN, DEFAULT_CATEGORIES, STATE_FILE, readState };

if (require.main === module) {
  // Load .env without dependencies.
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  const id = (process.env.MOSS_PROJECT_ID || '').trim();
  const key = (process.env.MOSS_PROJECT_KEY || '').trim();
  if (!id || !key) { console.error('Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY in .env first.'); process.exit(1); }
  createMossClient(id, key)
    .then((client) => runImport({ client, restart: process.argv.includes('--restart') }))
    .then(() => process.exit(0))
    .catch((e) => { console.error(`[catalog] import stopped: ${e.message} — run it again to resume`); process.exit(1); });
}
