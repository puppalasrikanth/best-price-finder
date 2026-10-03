const test = require('node:test');
const assert = require('node:assert');
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
