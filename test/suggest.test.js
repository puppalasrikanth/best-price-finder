const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { buildSuggestions, cleanName, matchesQuery } = require('../lib/suggest');

test('cleans store noise from product titles', () => {
  assert.strictEqual(cleanName('Amazon.com: Apple AirPods Pro 2 Wireless Earbuds, Active Noise Cancellation, Hearing Aid Feature : Electronics'), 'Apple AirPods Pro 2 Wireless Earbuds');
  assert.strictEqual(cleanName('Sony - WH-1000XM5 Wireless Noise Cancelling Over- ...'), 'Sony WH-1000XM5 Wireless Noise Cancelling');
  assert.strictEqual(cleanName('Restored Apple AirPods Pro 2 In-Ear Headphones ...'), 'Apple AirPods Pro 2 In-Ear Headphones');
});

test('matches partially typed words', () => {
  assert.ok(matchesQuery('Sony WH-1000XM5 Headphones', 'sony wh-10'));
  assert.ok(matchesQuery('Apple AirPods Pro 2', 'airp'));
  assert.ok(!matchesQuery('Bose QuietComfort Ultra', 'sony'));
});

test('suggests products, not support/news pages, from real results', () => {
  const s = buildSuggestions(require('../fixtures/airpods.json'), 'airpods pro');
  const names = s.map((x) => x.name);
  assert.ok(names.length >= 3);
  assert.ok(!names.some((n) => /tech specs|introduces|compare/i.test(n)));
  assert.ok(names.every((n) => /airpods pro/i.test(n)));
});

test('Tavily suggestions include products listed on store search pages', () => {
  const { buildSuggestions } = require('../lib/suggest');
  const fx = require('../fixtures/samsung-galaxy.json');
  const names = buildSuggestions(fx, 'samsung gal').map((x) => x.name);
  assert.ok(names.length >= 6, names.join(' / '));
  assert.ok(names.some((n) => /Galaxy S21 Ultra/.test(n)), 'from an Amazon search page');
  assert.ok(names.some((n) => /Galaxy S26\+/.test(n)), 'from a Target search page');
  assert.ok(!names.some((n) => /\bcase\b/i.test(n)), 'no accessories');
  assert.ok(names.every((n) => /samsung/i.test(n) && /gal/i.test(n)), 'everything matches what was typed');
});

test('merge: Moss first, Tavily adds new products, duplicates (color/condition variants) shown once', () => {
  const { mergeSuggestions } = require('../lib/suggest');
  const moss = [{ name: 'Samsung Galaxy S24 Ultra, Black', source: 'moss' }, { name: 'Samsung Galaxy Buds FE', source: 'moss' }];
  const tavily = [{ name: 'Samsung Galaxy S24 Ultra (Renewed)', source: 'tavily' }, { name: 'Samsung Galaxy Z Fold 4', source: 'tavily' }, { name: 'Apple iPhone 15', source: 'tavily' }];
  assert.deepStrictEqual(mergeSuggestions([moss, tavily], 'samsung gal').map((x) => x.source + ':' + x.name), [
    'moss:Samsung Galaxy S24 Ultra, Black', 'moss:Samsung Galaxy Buds FE', 'tavily:Samsung Galaxy Z Fold 4',
  ]);
});

test('/api/suggest asks Moss and Tavily and returns one unique list', async (t) => {
  const fx = require('../fixtures/samsung-galaxy.json');
  let tavilyCalls = 0;
  const mock = http.createServer((req, res) => { tavilyCalls += 1; req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fx)); }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { TAVILY_API_KEY: 'tvly-test', TAVILY_API_URL: `http://127.0.0.1:${mock.address().port}/search`, MOSS_PROJECT_ID: '', MOSS_ENABLED: 'false', ZOOWORK_API_KEY: '' });
  const server = require('../server');
  const { fakeMossBackend } = require('./helpers/fakeMoss');
  const { productDoc } = require('../lib/catalog');
  const fake = fakeMossBackend();
  const client = await fake.factory('p', 'k');
  await client.createIndex('pricescout-products', [
    productDoc({ name: 'Samsung Galaxy S24 Ultra Cell Phone, 256GB, Titanium Black', brand: 'Samsung', popularity: 9000 }),
    productDoc({ name: 'Samsung Galaxy S21 Ultra 5G, US Version, 128GB, Phantom Black - Unlocked', brand: 'Samsung', popularity: 5000 }),
    productDoc({ name: 'Samsung Galaxy Tab S9 FE', brand: 'Samsung', popularity: 4000 }),
  ]);
  Object.assign(server.catalog, { client, status: 'ready', exists: true, mode: 'cloud' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); mock.close(); });
  const get = async (qs) => (await fetch(`http://127.0.0.1:${server.address().port}/api/suggest?${qs}`)).json();

  const moss = await get('q=samsung+gal&source=moss');
  assert.ok(moss.suggestions.length >= 3 && moss.suggestions.every((x) => x.source === 'moss'));
  assert.strictEqual(tavilyCalls, 0, 'source=moss never calls Tavily');

  const both = await get('q=samsung+gal');
  assert.strictEqual(both.source, 'moss+tavily');
  assert.ok(both.counts.moss >= 3 && both.counts.tavily >= 5);
  assert.ok(both.suggestions.length <= 10);
  const keys = both.suggestions.map((x) => x.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => !/^(black|unlocked|renewed)$/.test(w)).slice(0, 6).join(' '));
  assert.strictEqual(new Set(keys).size, keys.length, 'unique products');
  assert.strictEqual(both.suggestions.filter((x) => /Galaxy S21 Ultra/.test(x.name)).length, 1, 'S21 Ultra from Moss and Tavily appears once');
  assert.ok(both.suggestions.findIndex((x) => x.source === 'tavily') > both.suggestions.findIndex((x) => x.source === 'moss'), 'Moss results first');

  const tav = await get('q=samsung+gal&source=tavily');
  assert.ok(tav.suggestions.every((x) => x.source === 'tavily'));
  assert.strictEqual(tavilyCalls, 1, 'Tavily answers are cached');
});

test('suggestions skip accessories, parts, Q&A pages and cut-off names', () => {
  const { buildSuggestions } = require('../lib/suggest');
  const raw = { results: [
    { url: 'https://www.walmart.com/ip/Samsung-Gal-S5-Mini-SView-Cover-Gold/1', title: 'Samsung Gal S5 Mini SView Cover-Gold' },
    { url: 'https://www.bestbuy.com/site/questions/samsung-galaxy-book4/6572182/question/x', title: "Hello, I'm interested in purchasing a Samsung Gal – Q&A" },
    { url: 'https://www.ebay.com/itm/1', title: 'Cartoon Animal Capybara Phone Case For Samsung Gal' },
    { url: 'https://www.amazon.com/dp/B0DF', title: 'Perzework Rear Back Glass Replacement for Samsung Galaxy S10' },
    { url: 'https://www.target.com/p/x', title: 'Samsung Galaxy S21 5G (128GB' },
    { url: 'https://www.bestbuy.com/site/samsung-galaxy-s25/123.p', title: 'Samsung - Galaxy S25 128GB (Unlocked) - Navy' },
  ] };
  assert.deepStrictEqual(buildSuggestions(raw, 'samsung gal').map((x) => x.name), ['Samsung Galaxy S25 128GB (Unlocked) - Navy']);
});

test('Moss usage-limit errors pause the catalog instead of failing every keystroke', async () => {
  const { Catalog } = require('../lib/catalog');
  const logs = [];
  const c = new Catalog({ projectId: 'p', projectKey: 'k', log: (m) => logs.push(m), clientFactory: async () => ({
    getIndex: async () => ({}), loadIndex: async () => { throw new Error('nope'); },
    query: async () => { throw new Error('Invalid response: HTTP 429 Too Many Requests: {"error":"USAGE_LIMIT_EXCEEDED","message":"credit_exhausted"}'); },
  }) });
  await c.init();
  assert.strictEqual(await c.suggest('samsung'), null);
  assert.strictEqual(c.info().status, 'paused');
  assert.strictEqual(await c.suggest('samsung'), null, 'no further calls while paused');
  assert.strictEqual(c.stats.lookups, 1);
  assert.strictEqual(logs.filter((l) => /usage limit/.test(l)).length, 1);
});
