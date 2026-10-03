// Search pipeline:
//   1. Tavily finds store pages with images and prices        → rendered immediately ("preliminary")
//   2. Saved confirmations from Moss are applied instantly    → no re-check needed
//   3. ZooWork confirms each remaining page in parallel       → one "offer" event per page as it finishes
//   4. Every confirmation is saved to Moss                    → instant next time
const crypto = require('crypto');
const { searchProducts } = require('./tavily');
const { buildOffers } = require('./extract');
const { verifyOne } = require('./zoowork');

const MAX_VERIFY = () => Number(process.env.ZOOWORK_MAX_PAGES) || 8;
const POOL = () => Math.max(1, Math.min(6, Number(process.env.ZOOWORK_CONCURRENCY) || 3));
const OFFER_TTL = () => (Number(process.env.OFFER_CACHE_MINUTES) || 30) * 60_000;

const offerId = (url) => crypto.createHash('sha1').update(String(url).split('#')[0]).digest('hex').slice(0, 12);
const canonicalUrl = (url) => { try { const u = new URL(url); return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, ''); } catch { return String(url); } };
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

function pickCandidates(offers) {
  // Cheapest priced offers first (so a low price never goes unchecked), at most 2 per store,
  // then unpriced retailer pages.
  const perStore = {};
  const priced = offers.filter((o) => o.price != null && !o.suspect).sort((a, b) => a.price - b.price);
  const ordered = [...priced, ...offers.filter((o) => o.price == null || o.suspect)];
  const out = [];
  for (const o of ordered) {
    perStore[o.store] = (perStore[o.store] || 0) + 1;
    if (perStore[o.store] > 2) continue;
    out.push(o);
    if (out.length >= MAX_VERIFY()) break;
  }
  return out;
}

function summarize(offers, { verifiedOnly }) {
  const eligible = (o) => o.price != null && !o.suspect && !o.stale && o.inStock !== false && (!verifiedOnly || o.verified === true);
  for (const o of offers) o.isBest = false;
  const pool = offers.filter(eligible);
  const bestNew = pool.filter((o) => o.condition === 'new').sort((a, b) => a.price - b.price)[0] || null;
  const bestAny = pool.slice().sort((a, b) => a.price - b.price)[0] || null;
  if (bestNew) bestNew.isBest = true;
  offers.sort((a, b) => {
    if (eligible(a) !== eligible(b)) return eligible(a) ? -1 : 1;
    if ((a.price == null) !== (b.price == null)) return a.price == null ? 1 : -1;
    if (a.price != null && b.price != null) return a.price - b.price;
    return b.score - a.score;
  });
  const prices = pool.map((o) => o.price);
  return {
    bestNew,
    bestAny: bestAny && bestAny !== bestNew ? bestAny : null,
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    stores: new Set(offers.map((o) => o.store)).size,
    pricedCount: prices.length,
    verifiedCount: offers.filter((o) => o.verified === true).length,
  };
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[$,]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const goodImage = (u) => typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u) && !/\.svg(\?|$)|sprite|logo|icon|banner|pixel|1x1/i.test(u);

// Applies one ZooWork (or saved) confirmation to an offer, in place.
function applyCheck(o, v, { source = 'zoowork', checkedAt = new Date().toISOString() } = {}) {
  const price = num(v.price);
  o.checkedAt = checkedAt;
  o.checkSource = source;
  if (v.verified && price) {
    if (o.snippetPrice == null && o.price != null && Math.abs(o.price - price) >= 0.01) o.snippetPrice = o.price;
    o.price = price;
    const was = num(v.was_price ?? v.wasPrice);
    o.wasPrice = was && was > price ? was : null;
    o.priceHigh = null;
    o.listing = false;
    o.verified = true;
    o.suspect = false;
    o.stale = false;
    o.check = source === 'recent' ? 'cached' : 'verified';
    if (['new', 'refurbished', 'used', 'open-box'].includes(v.condition)) o.condition = v.condition;
    const stock = v.in_stock ?? v.inStock;
    o.inStock = typeof stock === 'boolean' ? stock : null;
    const img = v.image_url || v.image;
    if (goodImage(img)) { o.image = img; o.imageVerified = true; }
    if (v.title && String(v.title).length > 8) o.title = String(v.title).slice(0, 200);
    if (v.url && /^https?:\/\//.test(v.url)) o.url = v.url;
    o.note = v.note ? String(v.note).slice(0, 140) : '';
  } else {
    o.verified = false;
    o.check = 'failed';
    o.note = v.note ? String(v.note).slice(0, 140) : 'Price could not be confirmed on the store page';
  }
  return o;
}

// What we persist per store page in Moss.
const offerRecord = (o) => ({
  verified: o.verified === true, price: o.price, wasPrice: o.wasPrice, condition: o.condition, inStock: o.inStock,
  image: o.image, title: o.title, url: o.url, note: o.note || '', checkedAt: o.checkedAt,
});

async function runPool(items, size, worker) {
  let next = 0;
  const run = async (slot) => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], slot);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, (_, slot) => run(slot)));
}

// emit(event): { type: 'step' | 'preliminary' | 'offer', ... }
async function runSearch({ query, scope, tavilyKey, zooworkKey, depth, emit, store, signal, gate }) {
  const step = (system, status, detail) => emit({ type: 'step', system, status, detail });

  // 1) Tavily
  step('tavily', 'running', scope === 'stores' ? 'Finding products at major US stores…' : 'Finding products across the web…');
  const t0 = Date.now();
  let raw;
  try {
    raw = await searchProducts(query, { apiKey: tavilyKey, scope, depth, signal });
  } catch (e) {
    step('tavily', 'error', e.message);
    throw e;
  }
  const sites = new Set((raw.results || []).map((r) => hostOf(r.url)));
  step('tavily', 'done', `${(raw.results || []).length} pages from ${sites.size} sites in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const { offers } = buildOffers(raw, query);
  for (const o of offers) { o.id = offerId(o.url); o.check = 'skipped'; }
  const candidates = pickCandidates(offers);
  for (const o of candidates) o.check = 'queued';

  // 2) Render immediately — nothing waits between Tavily and the first paint.
  step('parser', 'done', `${offers.length} offers shown · ${offers.filter((o) => o.price != null).length} with a price`);
  emit({ type: 'preliminary', offers, summary: summarize(offers, { verifiedOnly: false }) });

  // 3) Recent confirmations of these exact pages (this session, or Moss when enabled) update rows in place.
  let fromMoss = 0;
  if (store) {
    const hits = await Promise.all(offers.map((o) => store.get('offer', { key: canonicalUrl(o.url), query: `${o.title} ${o.store}`, maxAgeMs: OFFER_TTL() }).catch(() => null)));
    hits.forEach((h, i) => {
      if (!h || !h.payload || !h.payload.verified) return; // failed checks are always retried
      applyCheck(offers[i], h.payload, { source: 'recent', checkedAt: h.payload.checkedAt });
      offers[i].savedAgoMs = h.ageMs;
      fromMoss += 1;
      emit({ type: 'offer', offer: offers[i] });
    });
  }
  if (signal && signal.aborted) return { offers, summary: summarize(offers, { verifiedOnly: false }), verification: 'cancelled' };

  // 4) ZooWork, one check per page, in parallel (cheapest first)
  const anyVerified = offers.some((o) => o.verified);
  const todo = candidates.filter((o) => o.check === 'queued');
  if (!zooworkKey) {
    for (const o of todo) o.check = 'skipped';
    step('zoowork', 'skipped', 'ZOOWORK_API_KEY not set — prices are unconfirmed');
    return { offers, summary: summarize(offers, { verifiedOnly: anyVerified }), verification: fromMoss ? 'verified' : 'off' };
  }
  if (!todo.length) {
    step('zoowork', 'done', fromMoss ? 'All store pages confirmed in the last 30 min' : 'No store pages to confirm');
    return { offers, summary: summarize(offers, { verifiedOnly: offers.some((o) => o.verified) }), verification: offers.some((o) => o.verified) ? 'verified' : 'none' };
  }

  const z0 = Date.now();
  const pool = POOL();
  let finished = 0;
  let confirmed = 0;
  let setupShown = false;
  step('zoowork', 'running', `Confirming ${todo.length} store page${todo.length === 1 ? '' : 's'} (${pool} agents in parallel)…`);
  await runPool(todo, pool, async (o, slot) => {
    if (signal && signal.aborted) return; // shopper left — don't start new checks
    if (gate && !gate.budget.take('zoowork')) {
      o.check = 'skipped';
      o.note = 'Daily store-check limit reached';
      emit({ type: 'offer', offer: o });
      return;
    }
    if (gate) {
      try { await gate.semaphore.acquire(signal); } catch { return; }
    }
    o.check = 'checking';
    emit({ type: 'offer', offer: o });
    try {
      const v = await verifyOne({
        apiKey: zooworkKey,
        query,
        offer: o,
        slot,
        timeoutMs: Number(process.env.ZOOWORK_TIMEOUT_MS) || 180000,
        emit: (status, detail) => {
          // Surface one-time setup (creating/starting agents); per-page chatter stays in the row.
          if (/Creating|Starting/.test(detail) && !setupShown) { setupShown = /Creating/.test(detail); step('zoowork', 'running', detail); }
        },
        onUrl: (host, status) => emit({ type: 'step', system: 'store', status, detail: host }),
      });
      applyCheck(o, v);
      if (o.verified) confirmed += 1;
      if (store) store.put('offer', { key: canonicalUrl(o.url), query: `${o.title} ${o.store}`, text: `${o.title} | ${o.store} | ${query}`, payload: offerRecord(o) });
    } catch (e) {
      o.verified = false;
      o.check = 'failed';
      o.note = `ZooWork: ${String(e.message).slice(0, 120)}`;
    } finally {
      if (gate) gate.semaphore.release();
    }
    finished += 1;
    emit({ type: 'offer', offer: o });
    step('zoowork', 'running', `Confirmed ${confirmed} of ${finished} checked · ${todo.length - finished} to go`);
  });

  const verifiedOnly = offers.some((o) => o.verified);
  const summary = summarize(offers, { verifiedOnly });
  step('zoowork', confirmed || fromMoss ? 'done' : 'error', `Confirmed ${confirmed} of ${todo.length} store pages in ${Math.round((Date.now() - z0) / 1000)}s`);
  return {
    offers,
    summary,
    verification: verifiedOnly ? 'verified' : 'failed',
    ...(verifiedOnly ? {} : { verificationError: 'ZooWork could not confirm any store page' }),
  };
}

module.exports = { runSearch, summarize, applyCheck, pickCandidates, offerId, canonicalUrl, runPool };
