const test = require('node:test');
const assert = require('node:assert');
const { buildOffers, extractPrices, queryTokens, relevance } = require('../lib/extract');
const demo = require('../fixtures/demo.json');

test('model numbers must match exactly', () => {
  const t = queryTokens('Sony WH-1000XM5');
  assert.ok(relevance('Sony WH-1000XM5 Headphones', t) >= 0.6);
  assert.strictEqual(relevance('Sony WF-1000XM5 Earbuds', t), 0);
});

test('ignores savings, protection plans and financing amounts', () => {
  const p = extractPrices('$298.00\n\n~~$398.00~~\n\nSave$100.00\n\nAdd a protection plan from$42.99\n\nstarting at$37.25', ['sony'], true);
  assert.deepStrictEqual(p.map((x) => [x.value, x.kind]), [[298, 'price'], [398, 'was']]);
});

test('reads condition next to a price', () => {
  const p = extractPrices('Sony WH-1000XM5 Wireless Headphones. $195.00 New. $18.99 Used', queryTokens('sony wh-1000xm5'), true);
  assert.deepStrictEqual(p.map((x) => x.condition), ['new', 'used']);
});

test('builds offers from a real Tavily response', () => {
  const { offers, summary } = buildOffers(demo, 'Sony WH-1000XM5', { now: new Date('2026-10-03') });
  assert.ok(!offers.some((o) => /reviews/.test(o.url)), 'review pages are dropped');
  const bh = offers.find((o) => o.store === 'B&H Photo');
  assert.strictEqual(bh.price, 298);
  assert.strictEqual(bh.wasPrice, 398);
  assert.ok(bh.image);
  assert.strictEqual(summary.bestNew.price, 159.99);
  assert.strictEqual(summary.bestNew.store, 'Walmart');
  assert.ok(offers.find((o) => o.asOf === '2024-09-01').stale, 'old prices are flagged');
  assert.ok(offers.every((o) => !o.title.includes('open prime modal')));
});

test('AirPods Pro 2: rejects Pro 3 page, info pages and glued duplicate prices', () => {
  const { offers, summary } = buildOffers(require('../fixtures/airpods.json'), 'AirPods Pro 2', { now: new Date('2026-10-03') });
  assert.ok(!offers.some((o) => /airpods-pro-3|support\.apple|newsroom|compare/.test(o.url)));
  const wm = offers.find((o) => o.store === 'Walmart');
  assert.strictEqual(wm.price, 173.99);
  assert.strictEqual(wm.condition, 'refurbished');
  assert.ok(!offers.some((o) => o.price === 17399 || o.price === 29), 'no glued duplicates or service fees');
  assert.strictEqual(offers.find((o) => o.store === 'Best Buy').price, 164.99);
  assert.strictEqual(summary.bestNew, null, 'no confirmed new price in this result set');
});

test('Samsung Galaxy: one offer per product on store search pages, max 10, no accessories', () => {
  const { offers } = buildOffers(require('../fixtures/samsung-galaxy.json'), 'samsung galaxy', { now: new Date('2026-10-03') });
  assert.ok(offers.length >= 8 && offers.length <= 10, `got ${offers.length}`);
  assert.ok(new Set(offers.map((o) => o.store)).size >= 4, 'spread across stores');
  assert.ok(!offers.some((o) => /\bcase\b/i.test(o.title)), 'phone cases are dropped');
  assert.ok(!offers.some((o) => /review|product description/i.test(o.title)), 'page headings are not product names');
  assert.strictEqual(new Set(offers.map((o) => o.key || o.url)).size, offers.length, 'every offer has its own key');
  const s21 = offers.find((o) => /Galaxy S21 Ultra/.test(o.title));
  assert.strictEqual(s21.price, 250.8);
  assert.strictEqual(s21.condition, 'refurbished');
  assert.match(s21.url, /^https:\/\/www\.amazon\.com\/s\?k=Samsung%20Galaxy%20S21%20Ultra/);
  assert.strictEqual(offers.find((o) => /A02s/.test(o.title)).price, 82.5, 'Walmart split cents');
  assert.ok(!offers.some((o) => o.price === 289.88 || o.price === 399.99), '"New Price" references are not selling prices');
  assert.ok(offers.find((o) => /S24 FE 5G with Galaxy AI/.test(o.title)).image.includes('Galaxy-S24-FE'), 'image matched by product name');
  assert.ok(offers.find((o) => /S26\+/.test(o.title)).suspect === false, 'broad queries keep high-end models');
  assert.ok(buildOffers(require('../fixtures/samsung-galaxy.json'), 'samsung galaxy', { limit: 5 }).offers.length === 5);
});

test('extractItems reads was-prices and skips "Your price" repeats', () => {
  const { extractItems } = require('../lib/extract');
  const items = extractItems({ url: 'https://www.walmart.com/c/kp/x', title: 'x', content: '### Restored Samsung Galaxy S24 FE SM-S721U 128GB Graphite (Refurbished) $239.99 Was $264.99\n\n### Samsung Galaxy Buds FE Wireless Earbuds $59.99 Your price for this item is $59.99.' }, queryTokens('samsung galaxy'));
  assert.deepStrictEqual(items.map((i) => [i.price, i.wasPrice, i.condition]), [[239.99, 264.99, 'refurbished'], [59.99, null, 'new']]);
});
