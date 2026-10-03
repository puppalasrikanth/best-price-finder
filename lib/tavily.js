// Thin client for the Tavily Search API (https://docs.tavily.com).
const { RETAILER_DOMAINS } = require('./retailers');

const ENDPOINT = process.env.TAVILY_API_URL || 'https://api.tavily.com/search';

async function searchProducts(query, { apiKey, scope = 'stores', depth = 'fast', maxResults = 20, timeoutMs = 20000, signal } = {}) {
  if (!apiKey) throw Object.assign(new Error('TAVILY_API_KEY is not set'), { status: 500 });

  const body = {
    query: `${query} price`,
    search_depth: depth, // "fast" / "basic" = 1 credit (fast = lowest latency), "advanced" = 2 credits
    max_results: maxResults,
    include_images: true,
    include_answer: false,
    include_raw_content: false,
    country: 'united states',
    topic: 'general',
  };
  if (scope === 'stores') body.include_domains = RETAILER_DOMAINS;

  const call = (b) => fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(b),
    signal: signal && AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  let res = await call(body);
  if (res.status === 400 && !['basic', 'advanced'].includes(depth)) res = await call({ ...body, search_depth: 'basic' }); // API without fast modes

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

module.exports = { searchProducts };
