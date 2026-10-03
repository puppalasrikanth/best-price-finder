const test = require('node:test');
const assert = require('node:assert');
const { parseVerdict, normalizeEvent } = require('../lib/zoowork');
const { mergeVerdict, summarize } = require('../lib/pipeline');

test('parses the agent JSON block even with prose around it', () => {
  const v = parseVerdict('Checked them.\n```json\n{"offers":[{"n":1,"verified":true,"price":99.5}]}\n```\nDone');
  assert.strictEqual(v.offers[0].price, 99.5);
  assert.strictEqual(parseVerdict('no json here'), null);
});

test('normalizes both event wire shapes', () => {
  assert.strictEqual(normalizeEvent({ seq: 3, event_type: 'run.finished', payload: { status: 'succeeded' } }).type, 'run.finished');
  assert.strictEqual(normalizeEvent({ seq: 3, eventType: 'agent.tool' }).type, 'agent.tool');
});

test('only verified, in-stock prices can win best price', () => {
  const mk = (store, price) => ({ store, price, url: `https://${store}.com/p`, condition: 'new', score: 1 });
  const offers = [mk('a', 100), mk('b', 150), mk('c', 200)];
  mergeVerdict(offers, { offers: [
    { n: 1, verified: false, note: 'blocked' },
    { n: 2, verified: true, price: '$180.00', condition: 'new', in_stock: false },
    { n: 3, verified: true, price: 210, was_price: 250, condition: 'new', in_stock: true },
  ] });
  const s = summarize(offers, { verifiedOnly: true });
  assert.strictEqual(s.bestNew.store, 'c');
  assert.strictEqual(s.bestNew.price, 210);
  assert.strictEqual(s.bestNew.wasPrice, 250);
  assert.strictEqual(offers.find((o) => o.store === 'b').price, 180);
  assert.strictEqual(s.verifiedCount, 2);
});
