// Search pipeline: Tavily (find pages) → parser (snippet prices) → ZooWork (verify on the live page).
const { searchProducts } = require('./tavily');
const { buildOffers } = require('./extract');
const { verifyOffers } = require('./zoowork');

const MAX_VERIFY = Number(process.env.ZOOWORK_MAX_PAGES) || 8;

function pickCandidates(offers) {
  // Priced offers first, at most 2 per store, then unpriced retailer pages.
  const perStore = {};
  const ordered = [...offers.filter((o) => o.price != null && !o.suspect), ...offers.filter((o) => o.price == null || o.suspect)];
  const out = [];
  for (const o of ordered) {
    perStore[o.store] = (perStore[o.store] || 0) + 1;
    if (perStore[o.store] > 2) continue;
    out.push(o);
    if (out.length >= MAX_VERIFY) break;
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

function mergeVerdict(candidates, verdict) {
  const byN = new Map((verdict.offers || []).map((v) => [Number(v.n), v]));
  candidates.forEach((o, i) => {
    const v = byN.get(i + 1) || (verdict.offers || []).find((x) => x.url && x.url.split('?')[0] === o.url.split('?')[0]);
    o.checked = true;
    if (!v) { o.verified = false; o.note = 'Not checked by the agent'; return; }
    const price = typeof v.price === 'string' ? parseFloat(v.price.replace(/[$,]/g, '')) : v.price;
    if (v.verified && price > 0) {
      o.snippetPrice = o.price;
      o.price = Math.round(price * 100) / 100;
      const was = typeof v.was_price === 'string' ? parseFloat(v.was_price.replace(/[$,]/g, '')) : v.was_price;
      o.wasPrice = was > o.price ? was : null;
      o.priceHigh = null;
      o.listing = false;
      o.verified = true;
      o.suspect = false;
      o.stale = false;
      if (['new', 'refurbished', 'used', 'open-box'].includes(v.condition)) o.condition = v.condition;
      o.inStock = typeof v.in_stock === 'boolean' ? v.in_stock : null;
      if (v.title && v.title.length > 8) o.title = String(v.title).slice(0, 200);
      if (v.url && /^https?:\/\//.test(v.url)) o.url = v.url;
    } else {
      o.verified = false;
      o.note = v.note ? String(v.note).slice(0, 140) : 'Price could not be confirmed on the store page';
    }
  });
}

// emit(event) receives { type: 'step' | 'preliminary' | 'final', ... }
async function runSearch({ query, scope, tavilyKey, zooworkKey, depth, emit }) {
  const step = (system, status, detail) => emit({ type: 'step', system, status, detail });

  step('tavily', 'running', scope === 'stores' ? 'Connecting to Tavily · searching major US stores…' : 'Connecting to Tavily · searching the web…');
  const t0 = Date.now();
  let raw;
  try {
    raw = await searchProducts(query, { apiKey: tavilyKey, scope, depth });
  } catch (e) {
    step('tavily', 'error', e.message);
    throw e;
  }
  const hosts = new Set((raw.results || []).map((r) => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } }));
  step('tavily', 'done', `${(raw.results || []).length} pages from ${hosts.size} sites in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  step('parser', 'running', 'Reading prices from search snippets…');
  const { offers } = buildOffers(raw, query);
  const prelim = summarize(offers, { verifiedOnly: false });
  step('parser', 'done', `${offers.length} matching offers, ${prelim.pricedCount} with a snippet price`);
  emit({ type: 'preliminary', offers, summary: prelim });

  if (!zooworkKey) {
    step('zoowork', 'skipped', 'ZOOWORK_API_KEY not set — prices are unverified');
    return { offers, summary: prelim, verification: 'off' };
  }
  const candidates = pickCandidates(offers);
  if (!candidates.length) {
    step('zoowork', 'skipped', 'Nothing to verify');
    return { offers, summary: prelim, verification: 'none' };
  }
  const z0 = Date.now();
  try {
    const verdict = await verifyOffers({
      apiKey: zooworkKey,
      query,
      candidates,
      timeoutMs: Number(process.env.ZOOWORK_TIMEOUT_MS) || 240000,
      emit: (system, status, detail) => step(system, status, detail),
    });
    mergeVerdict(candidates, verdict);
    for (const o of offers) if (!o.checked) { o.verified = false; o.note = o.note || 'Not verified'; }
    const summary = summarize(offers, { verifiedOnly: true });
    step('zoowork', 'done', `Verified ${summary.verifiedCount} of ${candidates.length} store pages in ${Math.round((Date.now() - z0) / 1000)}s`);
    return { offers, summary, verification: 'verified' };
  } catch (e) {
    step('zoowork', 'error', `${e.message} — showing unverified snippet prices`);
    return { offers, summary: prelim, verification: 'failed', verificationError: e.message };
  }
}

module.exports = { runSearch, summarize, mergeVerdict, pickCandidates };
