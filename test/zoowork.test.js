const test = require('node:test');
const assert = require('node:assert');
const { parseOfferCheck, normalizeEvent, buildOfferPrompt, roleFor } = require('../lib/zoowork');
const { applyCheck, summarize, runPool, offerId } = require('../lib/pipeline');

test('parses the per-offer JSON block even with prose around it', () => {
  const v = parseOfferCheck('Checked.\n```json\n{"verified":true,"price":99.5,"image_url":"https://x.com/a.jpg"}\n```\nDone');
  assert.strictEqual(v.price, 99.5);
  assert.strictEqual(parseOfferCheck('no json here'), null);
});

test('normalizes both event wire shapes', () => {
  assert.strictEqual(normalizeEvent({ seq: 3, event_type: 'run.finished', payload: { status: 'succeeded' } }).type, 'run.finished');
  assert.strictEqual(normalizeEvent({ seq: 3, eventType: 'agent.tool' }).type, 'agent.tool');
});

test('prompt asks for one page, price and main image; pool slots get their own agents', () => {
  const p = buildOfferPrompt('AirPods Pro 2', { url: 'https://www.bestbuy.com/x', store: 'Best Buy', title: 'AirPods Pro 2', price: 199 });
  assert.match(p, /https:\/\/www\.bestbuy\.com\/x/);
  assert.match(p, /image_url/);
  assert.strictEqual(roleFor('verify').label, 'pricescout');
  assert.strictEqual(roleFor('verify-2').label, 'pricescout-verify-2');
});

test('a confirmation updates price, image and stock; only confirmed in-stock offers can win', () => {
  const mk = (store, price) => ({ store, price, url: `https://${store}.com/p`, condition: 'new', score: 1, image: 'https://cdn/old.jpg' });
  const offers = [mk('a', 100), mk('b', 150), mk('c', 200)];
  applyCheck(offers[0], { verified: false, note: 'blocked' });
  applyCheck(offers[1], { verified: true, price: '$180.00', condition: 'new', in_stock: false, image_url: 'https://cdn/b.jpg' });
  applyCheck(offers[2], { verified: true, price: 210, was_price: 250, condition: 'new', in_stock: true, image_url: 'https://cdn/sprite-logo.png' });
  assert.strictEqual(offers[1].price, 180);
  assert.strictEqual(offers[1].snippetPrice, 150);
  assert.strictEqual(offers[1].image, 'https://cdn/b.jpg');
  assert.strictEqual(offers[2].image, 'https://cdn/old.jpg', 'logo/sprite images are rejected');
  const s = summarize(offers, { verifiedOnly: true });
  assert.strictEqual(s.bestNew.store, 'c');
  assert.strictEqual(s.bestNew.wasPrice, 250);
  assert.strictEqual(s.verifiedCount, 2);
});

test('runs checks in parallel up to the pool size', async () => {
  let active = 0, peak = 0;
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 10)); active--; });
  assert.strictEqual(peak, 3);
  assert.strictEqual(offerId('https://a.com/x'), offerId('https://a.com/x#frag'));
});

test('search without a ZooWork key still returns offers (regression)', async () => {
  const http = require('http');
  const demo = require('../fixtures/demo.json');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(demo)); });
  await new Promise((r) => srv.listen(0, r));
  process.env.TAVILY_API_URL = `http://127.0.0.1:${srv.address().port}`;
  delete require.cache[require.resolve('../lib/tavily')];
  delete require.cache[require.resolve('../lib/pipeline')];
  const { runSearch } = require('../lib/pipeline');
  const events = [];
  const out = await runSearch({ query: 'Sony WH-1000XM5', scope: 'stores', tavilyKey: 'tvly-x', zooworkKey: '', depth: 'fast', emit: (e) => events.push(e.type) });
  srv.close();
  assert.ok(out.offers.length > 0);
  assert.strictEqual(out.verification, 'off');
  assert.ok(events.includes('preliminary'));
});

test('every store check gets its own agent slot and they all run at once', async () => {
  const { runPool, MAX_AGENTS } = require('../lib/pipeline');
  assert.strictEqual(MAX_AGENTS(), 10);
  const slots = [];
  let live = 0;
  let peak = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await runPool(items, Math.min(MAX_AGENTS(), items.length), async (_, slot) => {
    slots.push(slot);
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live -= 1;
  });
  assert.strictEqual(peak, 10);
  assert.strictEqual(new Set(slots).size, 10, 'ten different agents');
});
