// Type-ahead product suggestions from Tavily: turns store result titles into clean,
// de-duplicated product names (with an image) the shopper can pick from.
const { RETAILER_DOMAINS, retailerName } = require('./retailers');

const ENDPOINT = process.env.TAVILY_API_URL || 'https://api.tavily.com/search';

const STORE_NOISE = [
  /^amazon\.com\s*:\s*/i,
  /^(buy|shop)\s+/i,
  /\s*[-|–:]\s*(amazon\.com|walmart\.com|best ?buy|target|ebay|newegg(\.com)?|costco|b&h( photo)?|apple|micro center|the home depot|lowe'?s)\s*$/i,
  /\s*:\s*(electronics|home & kitchen|everything else|tools & home improvement|toys & games|video games|cell phones & accessories)\s*$/i,
  /\s*\|\s*.*$/,
  /\s+for sale( online)?\s*$/i,
  /\s+-\s+walmart\.com\s*$/i,
];
const INFO_URL = /\/\/(support|help|discussions|developer|investor)\.|\/newsroom\/|\/compare(\/|$)|tech-?specs|\/blog\/|\/news\//i;
const INFO_TITLE = /tech specs|support|compare models|introduces|announces|review:|how to|vs\.? /i;
const JUNK = /^(open prime modal|robot check|access denied|just a moment|page not found|search results|shop all|deals|customer reviews|ratings? & reviews)/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cleanName(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  for (const re of STORE_NOISE) t = t.replace(re, '');
  t = t.replace(/^(\(open box\)|open box|restored|refurbished|renewed|pre-?owned|used)[:\s-]+/i, '');
  t = t.replace(/\s+\S+-\s*(\.\.\.|…)\s*$/, '').replace(/\s*[-–,]?\s*(\.\.\.|…)\s*$/, '').replace(/\s+[-–]\s*$/, '');
  t = t.replace(/^([A-Z][\w&.]+)\s+-\s+/, '$1 '); // "Sony - WH-1000XM5…" → "Sony WH-1000XM5…"
  // Long marketplace titles: keep the head, up to the first spec-list separator.
  if (t.length > 70) {
    const cut = t.search(/\s[-–|]\s|,\s(?=[A-Z0-9])/);
    if (cut >= 18) t = t.slice(0, cut);
  }
  if (t.length > 90) t = t.slice(0, 90).replace(/\s+\S*$/, '') + '…';
  return t.trim();
}

// Every word the user typed must appear (the last one as a prefix, since they're mid-word).
function matchesQuery(name, q) {
  const words = norm(q).split(' ').filter(Boolean);
  const n = ` ${norm(name)} `;
  const flat = n.replace(/ /g, '');
  return words.every((w, i) => {
    const last = i === words.length - 1;
    if (last) return n.includes(` ${w}`) || flat.includes(w);
    return n.includes(` ${w} `) || flat.includes(w);
  });
}

function pickImage(images) {
  const list = (images || []).map((i) => (typeof i === 'string' ? i : i && i.url)).filter(Boolean);
  return list.find((u) => /^https?:\/\//.test(u) && !/\.svg|\.gif|sprite|icon|logo|banner|s-l(64|96|140)\.|_MCnd_|pixel/i.test(u)) || null;
}

function buildSuggestions(tavily, q, limit = 7) {
  const seen = new Set();
  const out = [];
  for (const r of tavily.results || []) {
    if (!r || !r.title || /\/reviews?(\/|$)|\/(search|s|b|c|browse|kp)\//i.test(r.url || '') || INFO_URL.test(r.url || '') || INFO_TITLE.test(r.title)) continue;
    const name = cleanName(r.title);
    if (!name || name.length < 6 || JUNK.test(name) || !matchesQuery(name, q)) continue;
    // De-duplicate near-identical names (same first 6 words, ignoring color/case).
    const key = norm(name).replace(/\b(black|white|silver|blue|red|green|pink|gray|grey|gold|midnight|starlight|graphite)\b/g, '').split(' ').filter(Boolean).slice(0, 6).join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, image: pickImage(r.images), store: retailerName(r.url), url: r.url });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchSuggestions(q, { apiKey, depth = process.env.SUGGEST_DEPTH || 'ultra-fast', timeoutMs = 8000 } = {}) {
  const call = (search_depth) => fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      query: q,
      search_depth,
      max_results: 10,
      include_images: true,
      include_answer: false,
      include_raw_content: false,
      country: 'united states',
      include_domains: RETAILER_DOMAINS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let res = await call(depth);
  if (res.status === 400 && depth !== 'basic') res = await call('basic'); // older API without fast modes
  if (!res.ok) {
    const err = new Error(res.status === 432 || res.status === 433 ? 'Tavily credits exhausted' : `Tavily error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = { fetchSuggestions, buildSuggestions, cleanName, matchesQuery };
