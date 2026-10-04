const test = require('node:test');
const assert = require('node:assert');
const http = require('http');

test('store search: two parallel Tavily queries without `country`, merged and de-duplicated', async (t) => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      bodies.push(body);
      if (body.country && body.search_depth === 'fast') { res.writeHead(400); return res.end('{"detail":{"error":"Country parameter is not supported"}}'); }
      const amazon = body.include_domains.includes('amazon.com');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        images: [amazon ? 'https://a/img.jpg' : 'https://w/img.jpg'],
        results: amazon
          ? [{ url: 'https://www.amazon.com/s?k=x', score: 0.9 }, { url: 'https://www.walmart.com/c/kp/x', score: 0.5 }]
          : [{ url: 'https://www.walmart.com/c/kp/x', score: 0.5 }, { url: 'https://www.bestbuy.com/site/shop/x', score: 0.7 }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.TAVILY_API_URL = `http://127.0.0.1:${server.address().port}/search`;
  delete require.cache[require.resolve('../lib/tavily')];
  const { searchProducts } = require('../lib/tavily');
  const out = await searchProducts('samsung galaxy', { apiKey: 'k', scope: 'stores', depth: 'fast' });
  assert.strictEqual(bodies.length, 2);
  assert.ok(bodies.every((b) => !('country' in b) && b.search_depth === 'fast'));
  assert.ok(bodies.some((b) => !b.include_domains.includes('amazon.com')), 'one query excludes Amazon');
  assert.deepStrictEqual(out.results.map((r) => r.url), ['https://www.amazon.com/s?k=x', 'https://www.bestbuy.com/site/shop/x', 'https://www.walmart.com/c/kp/x']);
  assert.strictEqual(out.images.length, 2);
  delete process.env.TAVILY_API_URL;
});
