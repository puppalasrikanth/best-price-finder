// Thin client for the Tavily Search API (https://docs.tavily.com).
const { RETAILER_DOMAINS } = require('./retailers');

const ENDPOINT = process.env.TAVILY_API_URL || 'https://api.tavily.com/search';

async function searchProducts(query, { apiKey, scope = 'stores', depth = 'advanced', maxResults = 20, timeoutMs = 25000 } = {}) {
  if (!apiKey) throw Object.assign(new Error('TAVILY_API_KEY is not set'), { status: 500 });

  const body = {
    query: `${query} price`,
    search_depth: depth, // "basic" = 1 credit, "advanced" = 2 credits
    max_results: maxResults,
    include_images: true,
    include_answer: false,
    include_raw_content: false,
    country: 'united states',
    topic: 'general',
  };
  if (scope === 'stores') body.include_domains = RETAILER_DOMAINS;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

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
