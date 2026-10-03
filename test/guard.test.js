const test = require('node:test');
const assert = require('node:assert');
const { RateLimiter, Budget, Semaphore, isPrivateIp, isPublicHost } = require('../lib/guard');

test('blocks private, loopback and cloud-metadata addresses', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['8.8.8.8', '23.45.67.89', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
  assert.strictEqual(await isPublicHost('localhost'), false);
  assert.strictEqual(await isPublicHost('169.254.169.254'), false);
  assert.strictEqual(await isPublicHost('[::1]'), false);
  assert.strictEqual(await isPublicHost('printer.local'), false);
});

test('rate limiter allows N per window per visitor', () => {
  const rl = new RateLimiter();
  const r = [1, 2, 3, 4].map(() => rl.allow('search:1.2.3.4', 3, 60_000).ok);
  assert.deepStrictEqual(r, [true, true, true, false]);
  assert.ok(rl.allow('search:5.6.7.8', 3, 60_000).ok, 'other visitors unaffected');
});

test('daily budget stops spending at the cap; 0 means unlimited', () => {
  const b = new Budget({ tavily: 2, zoowork: 0 });
  assert.deepStrictEqual([b.take('tavily'), b.take('tavily'), b.take('tavily')], [true, true, false]);
  for (let i = 0; i < 1000; i++) assert.ok(b.take('zoowork'));
});

test('semaphore caps concurrent ZooWork sessions and honours cancellation', async () => {
  const s = new Semaphore(2);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    await s.acquire(); active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5)); active--; s.release();
  }));
  assert.strictEqual(peak, 2);
  await s.acquire(); await s.acquire();
  const ac = new AbortController();
  const waiting = s.acquire(ac.signal);
  ac.abort();
  await assert.rejects(waiting, /cancelled/);
});
