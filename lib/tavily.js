// Thin client for the Tavily Search API (https://docs.tavily.com).
const { RETAILER_DOMAINS } = require('./retailers');

const endpoint = () => process.env.TAVILY_API_URL || 'https://api.tavily.com/search';

// Amazon search pages tend to fill every result slot, so a second query covers the other stores.
const NON_AMAZON = () => RETAILER_DOMAINS.filter((d) => d !== 'amazon.com');

async function tavilyCall(body, { apiKey, timeoutMs, signal }) {
  const call = (b) => fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(b),
    signal: signal && AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  let res = await call(body);
  if (res.status === 400 && !['basic', 'advanced'].includes(body.search_depth)) res = await call({ ...body, search_depth: 'basic' }); // API without fast modes

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.detail && (j.detail.error || j.detail)) || j.error || '';
    } catch {}
    const messages = {
      401: 'Tavily rejected the API key. Check TAVILY_API_KEY in your .env file.',
      429: 'Tavily rate limit reached. Wait a moment and try again.',
      432: 'Your Tavily plan has run out of credits for this month.',
      433: 'Your Tavily pay-as-you-go limit has been reached.',
    };
    const err = new Error(messages[res.status] || `Tavily error ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status === 401 || res.status >= 432 ? 502 : res.status;
    throw err;
  }
  return res.json();
}

// Finds store pages for a product. In "stores" mode two searches run in parallel — all
// retailers, and all retailers except Amazon — and their results are merged, so one store
// can't crowd out the rest. Note: Tavily's `country` option is not supported with the fast
// depths (it returns 400, and the basic-depth retry then returned no results at all), so it
// isn't sent; the retailer list already keeps results to US stores.
async function searchProducts(query, { apiKey, scope = 'stores', depth = 'fast', maxResults = 20, timeoutMs = 20000, signal } = {}) {
  if (!apiKey) throw Object.assign(new Error('TAVILY_API_KEY is not set'), { status: 500 });

  const base = {
    query: `${query} price`,
    search_depth: depth, // "fast" / "basic" = 1 credit (fast = lowest latency), "advanced" = 2 credits
    max_results: maxResults,
    include_images: true,
    include_answer: false,
    include_raw_content: false,
    topic: 'general',
  };
  const opts = { apiKey, timeoutMs, signal };
  if (scope !== 'stores') return tavilyCall(base, opts);

  const settled = await Promise.allSettled([
    tavilyCall({ ...base, include_domains: RETAILER_DOMAINS }, opts),
    tavilyCall({ ...base, include_domains: NON_AMAZON() }, opts),
  ]);
  const ok = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!ok.length) throw settled[0].reason;
  return mergeResponses(ok);
}

function mergeResponses(responses) {
  const seen = new Set();
  const results = [];
  const images = [];
  for (const r of responses) {
    for (const x of r.results || []) {
      const key = String(x.url || '').split('#')[0];
      if (!key || seen.has(key)) continue;
      seen.add(key);
      results.push(x);
    }
    for (const i of r.images || []) if (!images.includes(i)) images.push(i);
  }
  results.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { ...responses[0], results, images };
}

module.exports = { searchProducts, mergeResponses };
