const test = require('node:test');
const assert = require('node:assert');
const { analyzeTrend, lastSixMonths, buildTrendPrompt } = require('../lib/trend');
const demo = require('../fixtures/trend-demo.json');
const NOW = new Date('2026-10-03T12:00:00Z');

test('asks for the six full months before today', () => {
  assert.deepStrictEqual(lastSixMonths(NOW), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.match(buildTrendPrompt('Sony WH-1000XM5', NOW), /2026-04, 2026-05, 2026-06, 2026-07, 2026-08, 2026-09/);
});

test('computes 6-month stats and a 30-day projection', () => {
  const t = analyzeTrend(demo, { now: NOW });
  assert.ok(t.ok);
  assert.strictEqual(t.stats.low6, 248);
  assert.strictEqual(t.stats.high6, 329.99);
  assert.strictEqual(t.stats.lowMonth, '2026-07');
  assert.strictEqual(t.projection.date, '2026-11-02');
  assert.ok(t.projection.low <= t.projection.mid && t.projection.mid <= t.projection.high);
  assert.ok(t.projection.mid < t.current.price, 'a sale event in the window pulls the forecast down');
  assert.strictEqual(t.events[0].name, 'Prime Big Deal Days');
});

test('today\'s best deal does not drag the forecast baseline down', () => {
  const a = analyzeTrend(demo, { now: NOW });
  const b = analyzeTrend(demo, { now: NOW, currentPrice: 159.99 });
  assert.strictEqual(a.projection.mid, b.projection.mid);
  assert.strictEqual(b.bestToday.price, 159.99);
});

test('drops outliers, ignores events outside the window, needs 2+ months', () => {
  const raw = {
    months: [{ month: '2026-08', typical: 300, low: 280 }, { month: '2026-09', typical: 29.99, low: 25 }, { month: '2026-07', typical: 310 }],
    events: [{ name: 'Far away sale', start: '2027-03-01', expected_discount_pct: 30, confidence: 'high' }],
  };
  const t = analyzeTrend(raw, { now: NOW });
  assert.ok(t.ok);
  assert.ok(t.history.find((h) => h.month === '2026-09').dropped, 'accessory-level price dropped');
  assert.strictEqual(t.events.length, 0);
  assert.strictEqual(analyzeTrend({ months: [{ month: '2026-09', typical: 100 }] }, { now: NOW }).ok, false);
});
