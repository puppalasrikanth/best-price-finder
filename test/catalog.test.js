const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { fakeMossBackend } = require('./helpers/fakeMoss');
const { Catalog, productDoc } = require('../lib/catalog');

process.env.CATALOG_STATE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cat-')), 'state.json');
const { runImport, TopN } = require('../scripts/import-catalog');
const quiet = () => {};

// A tiny stand-in for the Amazon Reviews 2023 metadata files.
const ROWS = {
  Video_Games: [
    { title: 'Nintendo Switch OLED Model w/ White Joy-Con', store: 'Nintendo', rating_number: 52000, images: [{ variant: 'MAIN', large: 'https://m.media-amazon.com/images/I/switch.jpg' }] },
    { title: 'PlayStation 5 Console', store: 'Sony', rating_number: 41000, images: [] },
    { title: 'Obscure Controller Skin', store: 'NoName', rating_number: 3 },
    { title: 'Xbox Series X', store: 'Microsoft', rating_number: 38000 },
    { title: 'Nintendo Switch OLED Model w/ White Joy-Con', store: 'Nintendo', rating_number: 100 }, // duplicate name
  ],
  Electronics: [
    { title: 'Sony WH-1000XM5 Wireless Industry Leading Noise Canceling Headphones, Black', store: 'Sony', rating_number: 23000 },
    { title: 'Apple AirPods Pro 2 Wireless Earbuds, Active Noise Cancellation', store: 'Apple', rating_number: 99000 },
    { title: 'Sony WH-1000XM4 Wireless Noise Canceling Headphones', store: 'Sony', rating_number: 61000 },
    { title: 'Generic USB Cable', store: 'X', rating_number: 2 },
  ],
};
function serve() {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      const cat = (req.url.match(/meta_(.+)\.jsonl\.gz$/) || [])[1];
      if (!ROWS[cat]) { res.writeHead(404); return res.end(); }
      const gz = zlib.gzipSync(ROWS[cat].map((r) => JSON.stringify(r)).join('\n') + '\n');
      res.writeHead(200, { 'content-length': gz.length });
      res.end(gz);
    }).listen(0, () => ok(srv));
  });
}

test('TopN keeps the most-reviewed items', () => {
  const t = new TopN(2);
  [5, 50, 7, 500, 1].forEach((pop) => t.push({ pop }));
  assert.deepStrictEqual(t.sorted().map((x) => x.pop), [500, 50]);
});

test('imports the top products per category into Moss, de-duplicated, and resumes', async (t) => {
  const srv = await serve();
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  const backend = fakeMossBackend();
  const client = await backend.factory('p', 'k');
  const state = await runImport({ client, baseUrl, size: 6, restart: true, log: quiet, categories: [['Video_Games', 0.5], ['Electronics', 0.5]] });
  const ix = backend.indexes.get('pricescout-products');
  const names = [...ix.values()].map((d) => d.metadata.name);
  assert.strictEqual(state.done.Video_Games, 3, 'duplicate + low-review items dropped');
  assert.strictEqual(state.done.Electronics, 3);
  assert.ok(names.some((n) => n.startsWith('Apple AirPods Pro 2 Wireless Earbuds')));
  assert.ok(!names.some((n) => /Obscure|Generic/.test(n)));
  const sw = [...ix.values()].find((d) => /Switch OLED/.test(d.metadata.name));
  assert.strictEqual(sw.metadata.image, 'https://m.media-amazon.com/images/I/switch.jpg');
  assert.strictEqual(sw.metadata.popularity, '52000');
  // resume: nothing re-downloaded
  const calls = backend.calls.length;
  await runImport({ client, baseUrl, size: 6, log: quiet, categories: [['Video_Games', 0.5], ['Electronics', 0.5]] });
  assert.ok(!backend.calls.slice(calls).some((c) => c[0] === 'addDocs' || c[0] === 'createIndex'));
});

test('type-ahead lookups: prefix matching, popularity ranking, model numbers, learning, timeouts', async () => {
  const backend = fakeMossBackend();
  const seed = await backend.factory('p', 'k');
  await seed.createIndex('pricescout-products', [
    productDoc({ name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', popularity: 23000 }),
    productDoc({ name: 'Sony WH-1000XM4 Wireless Headphones', brand: 'Sony', popularity: 61000 }),
    productDoc({ name: 'Sony WH-CH720N Headphones', brand: 'Sony', popularity: 9000 }),
    productDoc({ name: 'Sony Bravia 65 inch TV', brand: 'Sony', popularity: 4000 }),
  ]);
  backend.opts.failLoad = true; // your Moss setup: local model blocked → cloud queries
  backend.opts.cloudStripsMetadata = true;
  const cat = await new Catalog({ projectId: 'p', projectKey: 'k', clientFactory: backend.factory, log: quiet, flushMs: 5 }).init();
  clearInterval(cat.retryTimer);
  assert.strictEqual(cat.mode, 'cloud');

  const r = await cat.suggest('sony wh');
  assert.ok(r.length >= 3);
  assert.ok(r.every((x) => /^Sony WH/i.test(x.name)), 'prefix "wh" must match');
  assert.ok(!r.some((x) => /Bravia/.test(x.name)));
  assert.strictEqual(r[0].source, 'moss');
  const xm5 = await cat.suggest('sony wh-1000xm5');
  assert.deepStrictEqual(xm5.map((x) => x.name), ['Sony WH-1000XM5 Wireless Headphones']);

  cat.learn([{ name: 'Amazon.com: Bose QuietComfort Ultra Headphones : Electronics', image: 'https://cdn/b.jpg' }]);
  await new Promise((res) => setTimeout(res, 20));
  await cat.flush();
  const bose = await cat.suggest('bose quiet');
  assert.strictEqual(bose[0].name, 'Bose QuietComfort Ultra Headphones');

  backend.opts.queryDelayMs = 600;
  assert.strictEqual(await cat.suggest('sony wh', { timeoutMs: 100 }), null, 'slow Moss → null so the caller falls back to Tavily');
});
