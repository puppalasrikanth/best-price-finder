const test = require('node:test');
const assert = require('node:assert');
const { Store, sameProduct } = require('../lib/store');
const { fakeMossBackend } = require('./helpers/fakeMoss');

const quiet = () => {};
const mk = (backend, extra = {}) => new Store({ projectId: 'p', projectKey: 'k', clientFactory: backend.factory, log: quiet, flushMs: 5, ...extra });

test('model numbers must match for a semantic hit', () => {
  assert.ok(sameProduct('airpods pro 2', 'Apple AirPods Pro 2'));
  assert.ok(!sameProduct('airpods pro 2', 'AirPods Pro 3'));
  assert.ok(!sameProduct('sony wh-1000xm5', 'sony wh-1000xm4'));
});

test('without credentials it works as an in-memory cache', async () => {
  const s = new Store({ log: quiet });
  await s.init();
  assert.strictEqual(s.status, 'off');
  s.put('search', { key: 'Kindle', payload: { a: 1 } });
  assert.deepStrictEqual((await s.get('search', { key: 'kindle' })).payload, { a: 1 });
});

test('creates and loads the index, persists writes, and survives a restart', async () => {
  const backend = fakeMossBackend();
  const a = await mk(backend).init();
  assert.strictEqual(a.status, 'ready');
  assert.ok(backend.calls.some((c) => c[0] === 'createIndex'));
  assert.ok(backend.calls.some((c) => c[0] === 'loadIndex' && c[2].autoRefresh));
  a.put('search', { key: 'AirPods Pro 2', scope: 'stores', text: 'AirPods Pro 2 | Apple AirPods Pro 2 Wireless Earbuds', payload: { offers: [1, 2] } });
  await a.flush();
  assert.ok(backend.calls.some((c) => c[0] === 'addDocs' && c[3].upsert));

  const b = await mk(backend).init(); // fresh process, empty memory
  assert.ok(!backend.calls.filter((c) => c[0] === 'createIndex')[1], 'does not recreate an existing index');
  const hit = await b.get('search', { key: 'airpods pro 2', scope: 'stores' });
  assert.strictEqual(hit.match, 'exact');
  assert.deepStrictEqual(hit.payload, { offers: [1, 2] });
  assert.ok(hit.tookMs >= 0);
});

test('semantic lookup finds a differently worded query but never a different model', async () => {
  const backend = fakeMossBackend();
  const a = await mk(backend).init();
  a.put('trend', { key: 'AirPods Pro 2', text: 'AirPods Pro 2 | Apple AirPods Pro 2nd generation', payload: { months: [] } });
  await a.flush();
  const b = await mk(backend).init();
  const hit = await b.get('trend', { key: 'apple airpods pro 2', semantic: true });
  assert.ok(hit, 'semantic hit');
  assert.strictEqual(hit.match, 'semantic');
  assert.strictEqual(hit.matchedQuery, 'AirPods Pro 2');
  assert.strictEqual(await b.get('trend', { key: 'airpods pro 3', semantic: true }), null);
  assert.strictEqual(await b.get('search', { key: 'apple airpods pro 2', semantic: true }), null, 'kinds are kept apart');
});

test('respects max age and falls back to memory if Moss fails to load', async () => {
  const backend = fakeMossBackend();
  const s = await mk(backend).init();
  s.put('suggest', { key: 'sony', payload: ['x'] });
  assert.strictEqual(await s.get('suggest', { key: 'sony', maxAgeMs: -1 }), null);
  const broken = await new Store({ projectId: 'p', projectKey: 'k', log: quiet, clientFactory: async () => { throw new Error('network down'); } }).init();
  assert.strictEqual(broken.status, 'error');
  broken.put('suggest', { key: 'sony', payload: ['y'] });
  assert.deepStrictEqual((await broken.get('suggest', { key: 'sony' })).payload, ['y']);
});

test('extra descriptive words still match via the saved product title', () => {
  assert.ok(sameProduct('sony wh1000xm5 headphones', 'Sony WH-1000XM5', 'Sony WH-1000XM5 | Sony WH-1000XM5 Wireless Noise Canceling Headphones'));
  assert.ok(!sameProduct('sony wh1000xm4 headphones', 'Sony WH-1000XM5', 'Sony WH-1000XM5 Wireless Noise Canceling Headphones'));
});
