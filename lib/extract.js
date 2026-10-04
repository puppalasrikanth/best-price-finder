// Turns raw Tavily search results into product offers: price, was-price,
// condition, image and store. Prices come from page snippets, so every rule
// here is a heuristic — the UI tells users to confirm at the store.
const { hostOf, retailerName, storeSearchUrl } = require('./retailers');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'on', 'to', 'by',
  'price', 'prices', 'best', 'buy', 'cheap', 'cheapest', 'deal', 'deals', 'new', 'sale',
]);

const CONDITION_RE = /(like[-\s]new|pre[-\s]?owned|used|refurbished|refurb|renewed|restored|open[-\s]?box|new)/gi;
const PRICE_RE = /(~~)?(?:US\s?)?\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(~~)?/g;

// Words right before a price that make it a reference price, not the selling price.
const WAS_BEFORE = /(was|list price|list|reg\.?|regular|msrp|compare at|originally|typical( price)?|new price|previous price was|comp\.? value)\s*:?\s*$/;

// "$82 50" (Walmart writes the cents separately) -> 82.50
function withCents(m, text) {
  const v = parseFloat(m[2].replace(/,/g, ''));
  if (m[2].includes('.')) return v;
  const c = text.slice(m.index + m[0].length, m.index + m[0].length + 4).match(/^ (\d{2})\b/);
  return c ? v + Number(c[1]) / 100 : v;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function queryTokens(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => (t.length > 1 || /^\d+$/.test(t)) && !STOPWORDS.has(t));
}

// Model-like tokens (contain a digit, e.g. "wh1000xm5", "15") must all match;
// otherwise at least 60% of the words must appear.
function relevance(text, tokens) {
  if (!tokens.length) return 1;
  const n = norm(text);
  const lower = String(text || '').toLowerCase();
  const has = (t) => (/^\d+$/.test(t) ? new RegExp(`(^|[^0-9.,$])${t}([^0-9]|$)`).test(lower) : n.includes(t));
  const models = tokens.filter((t) => /\d/.test(t));
  if (models.some((t) => !has(t))) return 0;
  const hits = tokens.filter(has).length;
  return hits / tokens.length;
}

function conditionLabel(word) {
  const w = word.toLowerCase().replace(/[-\s]/g, '');
  if (w === 'new') return 'new';
  if (w === 'likenew') return 'refurbished';
  if (w === 'openbox') return 'open-box';
  if (['refurbished', 'refurb', 'renewed', 'restored'].includes(w)) return 'refurbished';
  return 'used';
}

function isListingPage(url) {
  if (/\/(product|products|ip|dp|gp\/product|p|sku|itm|site\/[^/]+\/\d+\.p)\//i.test(url)) return false;
  return /\/(c|b|s|tp|search|browse|clp|kp|sch|shop|deals?|category|cp|bn_\d+)(\/|\?|$)|searchpage|price-history|[?&](k|q|query|st)=/i.test(url);
}

function isReviewPage(url, title) {
  return /\/reviews?(\/|$|\?)|customer-reviews|product-reviews/i.test(url) || /ratings?\s*&\s*reviews|customer reviews/i.test(title || '');
}

// Split content into "segments" (one product line / block each).
function segmentAt(content, idx) {
  const delims = /\n|\s;\s|\[\.\.\.\]|###|\s\|\s/g;
  let start = 0;
  let end = content.length;
  let m;
  while ((m = delims.exec(content))) {
    if (m.index < idx) start = m.index + m[0].length;
    else {
      end = m.index;
      break;
    }
  }
  return content.slice(start, end);
}

function parseAsOf(content) {
  const m = content.match(/as of\s+([a-z]+\.?\s+\d{1,2},\s+\d{4})/i);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

function extractPrices(content, tokens, pageRelevant) {
  const text = String(content || '');
  const out = [];
  let skipNext = false;
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text))) {
    const value = withCents(m, text);
    const start = m.index;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 45), start).toLowerCase();
    const after = text.slice(end, end + 30).toLowerCase();

    if (skipNext) { // upper bound of a "$A - $B" range
      skipNext = false;
      if (out.length) out[out.length - 1].rangeHigh = value;
      continue;
    }
    if (!(value > 0) || value > 100000) continue;
    if (start > 0 && /[\d$]/.test(text[start - 1])) continue; // screen-reader duplicates like "$173.99$17399"

    const near = before.slice(-40);
    if (/\b(save|off|plan|protection|warranty|applecare|shipping|orders? (over|of)|starting at|as low as|financ\w*|credit|reward|gift card|deposit|fees?|coupon|rebate|deductible|service charges?|repair|trade[- ]?in|tax)\b[^.$\n]{0,35}$/.test(near)) continue;
    if (/^\s*(\/\s?mo|per month|a month|\/month|off\b|shipping|back|in rewards)/.test(after)) continue;

    let kind = 'price';
    if ((m[1] && m[3]) || WAS_BEFORE.test(before)) kind = 'was';

    if (/^\s*[-–]\s*(us\s?)?\$/.test(after)) skipNext = true;

    // Condition: an adjacent word after the price wins, then the nearest word before it, then the segment.
    const segment = segmentAt(text, start);
    let condition = 'new';
    const afterCond = after.match(/^\s*\.?\s*(like[-\s]new|pre[-\s]?owned|used|refurbished|renewed|restored|open[-\s]?box|new)\b/);
    if (afterCond) condition = conditionLabel(afterCond[1]);
    else {
      const prior = [...before.matchAll(CONDITION_RE)];
      const segConds = [...segment.matchAll(CONDITION_RE)].map((c) => conditionLabel(c[1]));
      if (/new\s+(and|&)\s+refurb/i.test(segment)) condition = 'mixed';
      else if (prior.length) condition = conditionLabel(prior[prior.length - 1][1]);
      else if (segConds.find((c) => c !== 'new')) condition = segConds.find((c) => c !== 'new');
    }

    // Relevance: a segment that names a product must match the query; a bare
    // price line inherits the page's relevance.
    // A segment naming the product decides for itself; one that names some
    // other product (shares words but fails the match) is rejected; a generic
    // price line ("Current price $X") inherits the page's relevance.
    const segRel = relevance(segment, tokens);
    const wordsHit = tokens.filter((t) => !/^\d+$/.test(t) && norm(segment).includes(t)).length;
    const relevant = segRel >= 0.6 ? true : wordsHit > 0 ? false : pageRelevant;

    out.push({ value, kind, condition, relevant, rangeHigh: null, segment });
  }
  return out;
}

const BAD_IMAGE = /\.svg|\.gif|sprite|icon|logo|banner|badge|placeholder|loading|transparent-pixel|\/nav-|s-l(64|96|140)\.|_MCnd_|pixel|blank\.|1x1|cf-at-glance|flag/i;
const GOOD_CDN = /m\.media-amazon\.com\/images\/I\/|i5\.walmartimages\.com\/(seo|asr)|pisces\.bbystatic\.com|target\.scene7\.com|i\.ebayimg\.com\/images\/g|bhphotovideo\.com\/images|costco-static|newegg|images\.homedepot|mobileimages\.lowes|slimages\.macysassets|media\.kohlsimg|scene7/i;

const CDN_HINTS = {
  bestbuy: 'bbystatic', walmart: 'walmartimages', amazon: 'media-amazon', target: 'scene7',
  ebay: 'ebayimg', costco: 'costco', homedepot: 'homedepot', lowes: 'lowes', macys: 'macysassets', kohls: 'kohlsimg',
};

function upgradeImage(url) {
  if (/i5\.walmartimages\.com/.test(url)) return url.replace(/\?odn.*$/, '?odnHeight=450&odnWidth=450&odnBg=FFFFFF');
  if (/i\.ebayimg\.com/.test(url)) return url.replace(/s-l\d+\.(jpg|webp|png)/, 's-l500.$1');
  return url;
}

function pickImage(images, tokens) {
  const list = (images || []).map((i) => (typeof i === 'string' ? i : i && i.url)).filter(Boolean);
  let best = null;
  let bestScore = -Infinity;
  list.forEach((url, i) => {
    if (BAD_IMAGE.test(url) || !/^https?:\/\//.test(url)) return;
    const n = norm(url);
    let score = -i * 0.1; // prefer earlier images slightly
    const models = tokens.filter((t) => /\d/.test(t));
    score += tokens.filter((t) => n.includes(t)).length * 2;
    if (models.length && models.every((t) => n.includes(t))) score += 4;
    if (GOOD_CDN.test(url)) score += 2;
    if (/s-l1600|500x500|_SL1500_|_AC_SL/i.test(url)) score += 1;
    if (/odnHeight=(1\d\d|[1-9]\d)\b|s-l225|_SS\d\d_/i.test(url)) score -= 1;
    if (score > bestScore) { bestScore = score; best = url; }
  });
  return best ? upgradeImage(best) : null;
}

function cleanTitle(title, url, content, tokens) {
  let t = String(title || '').replace(/\s*[-|:]\s*(Walmart\.com|Amazon\.com|Best Buy|Target|eBay|Newegg\.com|Costco)\s*$/i, '').trim();
  if (/^(open prime modal|amazon\.com|robot check|access denied|just a moment|page not found)/i.test(t)) t = '';
  if (!t && content) {
    // First content line that names the product.
    const line = content.split('\n').map((l) => l.replace(/^[#\s]+/, '').trim())
      .find((l) => l.length > 15 && l.length < 200 && relevance(l, tokens) >= 0.6);
    if (line) t = line.split(' | ')[0];
  }
  if (!t) {
    // Build a title from the URL slug.
    try {
      const slug = new URL(url).pathname.split('/').filter(Boolean).find((p) => /[a-z]-[a-z]/i.test(p) && p.length > 12);
      if (slug) t = slug.replace(/[-_]+/g, ' ').replace(/\.html?$/, '');
    } catch {}
  }
  t = t.replace(/\s*(for sale online|for sale)\s*(\|\s*eBay)?\s*$/i, '').trim();
  return t || retailerName(url);
}

function toOffer(result, tokens, fallbackImages) {
  const url = result.url;
  let title = cleanTitle(result.title, url, result.content, tokens);
  const content = String(result.content || '') + '\n' + String(result.raw_content || '').slice(0, 6000);
  const titleOk = !/^(open prime modal|amazon\.com|robot check|access denied|just a moment)/i.test(result.title || '');
  const pageRel = relevance(titleOk ? `${result.title} ${url}` : `${url} ${title}`, tokens) >= 0.6;
  const listing = isListingPage(url);

  const prices = extractPrices(content, tokens, pageRel);
  const usable = prices.filter((p) => p.kind === 'price' && p.relevant);
  const pickFrom = (arr) => (listing ? arr.reduce((a, b) => (b.value < a.value ? b : a)) : arr[0]);

  const titleCond = (result.title || '').match(/\b(pre[-\s]?owned|used|refurbished|renewed|restored|open[-\s]?box)\b/i);
  if (titleCond && !listing) for (const p of prices) if (p.condition === 'new' || p.condition === 'mixed') p.condition = conditionLabel(titleCond[1]);

  let main = null;
  const newOnes = usable.filter((p) => p.condition === 'new');
  if (newOnes.length) main = pickFrom(newOnes);
  else if (usable.length) main = pickFrom(usable);

  // On a listing page the matched product line is a better title than the page's.
  if (main && listing) {
    const seg = main.segment.replace(/(~~)?(US\s?)?\$\s?[\d,]+(\.\d{2})?(~~)?/g, '').replace(/\b(from|was|now)\s*$/i, '').replace(/^[#\s]+/, '').trim();
    const tidy = seg.replace(/\s*·\s*\(\d[\d,]*\)\.?/g, '').replace(/(\s*\.?\s*\b(new|used|pre-owned|refurbished|open box)\b\.?)+\s*$/i, '').trim();
    if (tidy.length > 15 && relevance(tidy, tokens) >= 0.6) title = tidy.replace(/\s+(from|was|now)$/i, '').slice(0, 160);
  }

  let wasPrice = null;
  if (main) {
    const after = prices.slice(prices.indexOf(main) + 1, prices.indexOf(main) + 3);
    const was = after.find((p) => p.kind === 'was' && p.value > main.value);
    if (was) wasPrice = was.value;
    else if (!listing && main.rangeHigh && main.condition === 'new') wasPrice = null;
  }

  const host = hostOf(url);
  let image = pickImage(result.images, tokens);
  if (!image) {
    const site = host.split('.').slice(-2, -1)[0] || host;
    const hint = CDN_HINTS[site] || site;
    image = pickImage((fallbackImages || []).filter((i) => hostOf(i).includes(hint)), tokens);
  }

  return {
    title,
    url,
    store: retailerName(url),
    host,
    image,
    price: main ? main.value : null,
    priceHigh: main && main.rangeHigh ? main.rangeHigh : null,
    wasPrice,
    condition: main ? main.condition : titleCond && !listing ? conditionLabel(titleCond[1]) : null,
    listing,
    asOf: parseAsOf(content),
    relevant: pageRel || usable.length > 0,
    score: result.score || 0,
    suspect: false,
    stale: false,
  };
}


// ---- Search / category pages: one offer per named product -----------------------------
// Tavily mostly returns store search pages ("Amazon.com : samsung galaxy") that list many
// products, each written as "<product name> … $price". Each named product with a price
// becomes its own offer.

const ACCESSORY = /\b(cases?|covers?|screen protectors?|protectors?|tempered glass|chargers?|charging cables?|cables?|adapters?|holsters?|mounts?|stylus|skins?|replacement battery|films?|lens protectors?|wallet case|keyboard case)\b/i;
const FOR_DEVICE = /\b(for|compatible with|fits)\s+(the\s+)?(new\s+)?(apple|samsung|galaxy|iphone|ipad|pixel|google|airpods|motorola|oneplus|sony|nintendo|switch|xbox|ps5|playstation|macbook)\b/i;

function isAccessory(name, tokens) {
  if (tokens.some((t) => ACCESSORY.test(t))) return false; // the shopper is looking for one
  const n = String(name).replace(/\(?(with\s+)?charging case( included)?\)?/gi, ' ');
  return ACCESSORY.test(n) || FOR_DEVICE.test(n);
}

const ITEM_SPLIT = /\n|#{2,}|\s\|\s|\[\.\.\.\]|-{3,}|Image \d+:|\.\s+(?=[A-Z0-9\[#(])|\]\(\)?|!\[|\[(?=[A-Z])/;
const NOT_A_NAME = /\b(reviews?|out of 5|product description|your price|add to cart|free (delivery|shipping)|shipping|delivery|results? for|sponsored|see all|need help|pickup|banner|skip to)\b/i;

function cleanItemName(raw) {
  return String(raw || '')
    .replace(/\]\([^)]*\)?/g, ' ')
    .replace(/[\[\]*_`]/g, ' ')
    .replace(/^\s*\d{1,2}\.\s+/, '')
    .replace(/\b(Sponsored Ad -|Sponsored|Price, product page|current price|Now|Highly rated|Best ?seller|Clearance|Reduced price|Rollback|Top rated for durability|Popular pick|Add|Options?)\s*:?/g, ' ')
    .replace(/\s+(Brand New\s+)?From\s*$/i, '')
    .replace(/\b(Was|Typical|List( Price)?|New Price)\s*:?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s#:;.,\-–|]+|[\s#:;,\-–|]+$/g, '')
    .replace(/\.$/, '')
    .trim();
}

// Nearest product name before a price (within the text since the previous price).
function nameBefore(text, tokens, pageTitle) {
  const chunks = text.split(ITEM_SPLIT);
  const title = norm(pageTitle);
  for (let i = chunks.length - 1; i >= 0; i--) {
    const name = cleanItemName(chunks[i]);
    if (name.length < 12 || name.length > 220) continue;
    if (NOT_A_NAME.test(name) || norm(name) === title || /^amazon\.com/i.test(name)) continue;
    if (relevance(name, tokens) >= 0.6) return name;
  }
  return null;
}

function itemCondition(name) {
  const m = String(name).match(/\b(pre[-\s]?owned|used|refurbished|renewed|restored|open[-\s]?box|like[-\s]new)\b/i);
  return m ? conditionLabel(m[1]) : 'new';
}

function extractItems(result, tokens) {
  const text = String(result.content || '') + '\n' + String(result.raw_content || '').slice(0, 8000);
  const all = [];
  PRICE_RE.lastIndex = 0;
  let m;
  while ((m = PRICE_RE.exec(text))) all.push({ start: m.index, end: m.index + m[0].length, value: withCents(m, text), strike: !!(m[1] && m[3]) });
  const items = [];
  const seen = new Set();
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (!(p.value > 0) || p.value > 100000 || p.strike) continue;
    if (p.start > 0 && /[\d$]/.test(text[p.start - 1])) continue; // "$173.74$173.74"
    const before = text.slice(Math.max(0, p.start - 45), p.start).toLowerCase();
    const after = text.slice(p.end, p.end + 30).toLowerCase();
    if (WAS_BEFORE.test(before)) continue;
    if (/\b(save|off|plan|protection|warranty|shipping|orders? (over|of)|financ\w*|credit|reward|gift card|deposit|fees?|coupon|rebate|trade[- ]?in|tax)\b[^.$\n]{0,35}$/.test(before.slice(-40))) continue;
    if (/^\s*(\/\s?mo|per month|a month|\/month|off\b|shipping|back|in rewards|\/count)/.test(after)) continue;
    const winStart = Math.max(i ? all[i - 1].end : 0, p.start - 400);
    const name = nameBefore(text.slice(winStart, p.start), tokens, result.title);
    if (!name || isAccessory(name, tokens)) continue;
    const key = norm(name).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    let wasPrice = null;
    const next = all[i + 1];
    if (next && next.start - p.end < 45 && next.value > p.value && WAS_BEFORE.test(text.slice(p.end, next.start).toLowerCase().replace(/[\s,.]+$/, ' ').trimEnd())) wasPrice = next.value;
    items.push({ name: name.slice(0, 180), price: p.value, wasPrice, condition: itemCondition(name), pos: items.length });
  }
  return items;
}

// A photo whose file name describes this exact product (Walmart/Best Buy image URLs carry
// the product title); otherwise none — ZooWork fills in the store's photo when it confirms.
function itemImage(name, images) {
  const t = queryTokens(name).filter((x) => !CONDITION_WORDS.has(x));
  if (!t.length) return null;
  const model = t.find((x) => /\d/.test(x) && /[a-z]/.test(x));
  let best = null;
  let bestScore = 0;
  for (const img of images || []) {
    const url = typeof img === 'string' ? img : img && img.url;
    if (!url || BAD_IMAGE.test(url) || !/^https:\/\//.test(url)) continue;
    const n = norm(url);
    if (model && !n.includes(model)) continue;
    const score = t.filter((x) => n.includes(x)).length / t.length;
    if (score > bestScore) { bestScore = score; best = url; }
  }
  return bestScore >= 0.45 ? upgradeImage(best) : null;
}
const CONDITION_WORDS = new Set(['restored', 'renewed', 'refurbished', 'preowned', 'used', 'openbox', 'new', 'unlocked']);

function itemOffers(result, tokens, images) {
  const host = hostOf(result.url);
  return extractItems(result, tokens).map((it) => ({
    title: it.name,
    url: storeSearchUrl(result.url, it.name) || result.url,
    pageUrl: result.url,
    key: `${host}|${norm(it.name).slice(0, 80)}`,
    store: retailerName(result.url),
    host,
    image: itemImage(it.name, [...(result.images || []), ...(images || [])]),
    price: it.price,
    priceHigh: null,
    wasPrice: it.wasPrice,
    condition: it.condition,
    listing: false,
    fromSearchPage: true,
    asOf: null,
    relevant: true,
    score: (result.score || 0) - it.pos * 0.01,
    suspect: false,
    stale: false,
  }));
}

// Picks up to `limit` offers: most relevant first, spread across stores (round-robin), so
// one store's search page can't fill the whole list.
function selectOffers(offers, query, limit) {
  const tokens = queryTokens(query);
  const phrase = tokens.join('');
  const rank = (o) => relevance(o.title, tokens) + (norm(o.title).includes(phrase) ? 0.3 : 0) + (o.price != null ? 0.5 : 0) + (o.score || 0) * 0.5;
  const byStore = new Map();
  for (const o of offers.slice().sort((a, b) => rank(b) - rank(a))) {
    if (!byStore.has(o.store)) byStore.set(o.store, []);
    byStore.get(o.store).push(o);
  }
  const queues = [...byStore.values()];
  const out = [];
  while (out.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (q.length && out.length < limit) out.push(q.shift());
    }
  }
  return out;
}

const INFO_PAGE = /\/\/(support|help|discussions|community|developer|investor|podcasts)\.|\/(questions?|community|t5)\/|\/newsroom\/|\/compare(\/|$)|tech-?specs|\/blog\/|\/news\/|\/wiki\//i;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Main entry: Tavily response -> { offers, summary } (at most `limit` offers).
function buildOffers(tavily, query, { now = new Date(), limit = Number(process.env.MAX_PRODUCTS) || 10 } = {}) {
  const tokens = queryTokens(query);
  const seen = new Set();
  const pages = (tavily.results || [])
    .filter((r) => r && r.url && !isReviewPage(r.url, r.title))
    .filter((r) => {
      const key = r.url.split(/[?#]/)[0].replace(/\/$/, '') + (isListingPage(r.url) ? r.url.split('?')[1] || '' : '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let offers = [];
  for (const r of pages) {
    // Search/category pages list many products: one offer per named product.
    const items = isListingPage(r.url) ? itemOffers(r, tokens, tavily.images) : [];
    if (items.length) { offers.push(...items); continue; }
    const o = toOffer(r, tokens, tavily.images);
    if (!o.relevant || (o.price == null && INFO_PAGE.test(o.url)) || isAccessory(o.title, tokens)) continue;
    offers.push(o);
  }
  // Same product at the same store (e.g. found on two search pages): keep the cheaper one.
  const best = new Map();
  for (const o of offers) {
    const k = o.key || `${o.host}|${norm(o.title).slice(0, 80)}`;
    const cur = best.get(k);
    if (!cur || (o.price != null && (cur.price == null || o.price < cur.price))) best.set(k, o);
  }
  offers = selectOffers([...best.values()], query, limit);

  // Outliers: accessories, parts or bad parses priced far from the pack.
  const med = median(offers.filter((o) => o.price != null).map((o) => o.price));
  const specific = tokens.some((t) => /\d/.test(t));
  const staleBefore = new Date(now.getTime() - 120 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (const o of offers) {
    // Broad queries ("samsung galaxy") legitimately span $70–$1,200, so only flag outliers
    // when the query names a specific model.
    if (specific && o.price != null && med && (o.price < med * 0.35 || o.price > med * 3)) o.suspect = true;
    if (o.asOf && o.asOf < staleBefore) o.stale = true;
  }

  const eligible = (o) => o.price != null && !o.suspect && !o.stale;
  const bestNew = offers.filter((o) => eligible(o) && o.condition === 'new').sort((a, b) => a.price - b.price)[0] || null;
  const bestAny = offers.filter(eligible).sort((a, b) => a.price - b.price)[0] || null;
  if (bestNew) bestNew.isBest = true;

  offers.sort((a, b) => {
    if ((a.price == null) !== (b.price == null)) return a.price == null ? 1 : -1;
    if (a.price != null && eligible(a) !== eligible(b)) return eligible(a) ? -1 : 1;
    if (a.price != null && b.price != null) return a.price - b.price;
    return b.score - a.score;
  });

  const priced = offers.filter(eligible).map((o) => o.price);
  return {
    offers,
    summary: {
      bestNew,
      bestAny: bestAny && bestAny !== bestNew ? bestAny : null,
      low: priced.length ? Math.min(...priced) : null,
      high: priced.length ? Math.max(...priced) : null,
      median: med,
      stores: new Set(offers.map((o) => o.store)).size,
      pricedCount: priced.length,
    },
  };
}

module.exports = { buildOffers, extractPrices, extractItems, isAccessory, pickImage, queryTokens, relevance, isListingPage };
