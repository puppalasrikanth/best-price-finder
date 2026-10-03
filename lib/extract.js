// Turns raw Tavily search results into product offers: price, was-price,
// condition, image and store. Prices come from page snippets, so every rule
// here is a heuristic — the UI tells users to confirm at the store.
const { hostOf, retailerName } = require('./retailers');

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'of', 'in', 'on', 'to', 'by',
  'price', 'prices', 'best', 'buy', 'cheap', 'cheapest', 'deal', 'deals', 'new', 'sale',
]);

const CONDITION_RE = /(like[-\s]new|pre[-\s]?owned|used|refurbished|refurb|renewed|restored|open[-\s]?box|new)/gi;
const PRICE_RE = /(~~)?(?:US\s?)?\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)(~~)?/g;

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
  return /\/(c|b|s|search|browse|clp|kp|sch|shop|deals?|category|cp|bn_\d+)(\/|\?|$)|searchpage|price-history|[?&](k|q|query|st)=/i.test(url);
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
    const value = parseFloat(m[2].replace(/,/g, ''));
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
    if ((m[1] && m[3]) || /(was|list price|reg\.?|regular|msrp|compare at|originally)\s*:?\s*$/.test(before)) kind = 'was';

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

const INFO_PAGE = /\/\/(support|help|discussions|developer|investor)\.|\/newsroom\/|\/compare(\/|$)|tech-?specs|\/blog\/|\/news\/|\/wiki\//i;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Main entry: Tavily response -> { offers, summary }
function buildOffers(tavily, query, { now = new Date() } = {}) {
  const tokens = queryTokens(query);
  const seen = new Set();
  let offers = (tavily.results || [])
    .filter((r) => r && r.url && !isReviewPage(r.url, r.title))
    .filter((r) => {
      const key = r.url.split(/[?#]/)[0].replace(/\/$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => toOffer(r, tokens, tavily.images))
    .filter((o) => o.relevant)
    .filter((o) => o.price != null || !INFO_PAGE.test(o.url));

  // Outliers: accessories, parts or bad parses priced far from the pack.
  const med = median(offers.filter((o) => o.price != null).map((o) => o.price));
  const staleBefore = new Date(now.getTime() - 120 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  for (const o of offers) {
    if (o.price != null && med && (o.price < med * 0.35 || o.price > med * 3)) o.suspect = true;
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

module.exports = { buildOffers, extractPrices, pickImage, queryTokens, relevance, isListingPage };
