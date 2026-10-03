// Price trend: a ZooWork agent gathers ~6 months of price history; this module
// validates it and projects the next 30 days with a transparent, explainable model.
const { runAgentTask, parseJsonBlock } = require('./zoowork');

const DAY = 24 * 3600 * 1000;

function monthKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The six full months before `now`, oldest first (e.g. Apr…Sep when now is in Oct).
function lastSixMonths(now = new Date()) {
  const out = [];
  for (let i = 6; i >= 1; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

function buildTrendPrompt(query, now = new Date()) {
  const months = lastSixMonths(now);
  const today = now.toISOString().slice(0, 10);
  const windowEnd = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
  return [
    `Today is ${today}. You are a retail price analyst. Research the US price history of: "${query}" (new condition, the exact model/generation).`,
    '',
    `1. For each month ${months.join(', ')}, find the TYPICAL selling price at major US retailers (Amazon, Best Buy, Walmart, Target, the brand store)`,
    '   and the LOWEST price seen that month (sales included). Good sources: camelcamelcamel.com and Keepa (Amazon price history),',
    '   retailer price-history pages, dated deal posts (Slickdeals, 9to5Toys, The Verge/Engadget deals), and Google Shopping price insights.',
    '   Use real observations only. If a month has no data, use null — do NOT invent numbers.',
    '2. The current typical price today.',
    `3. Known US sale events between ${today} and ${windowEnd} that usually discount this product (e.g. Prime Big Deal Days, Black Friday/Cyber Monday,`,
    '   back-to-school, a new-model launch that drops the old price), with the expected discount % based on past years, and your confidence.',
    '4. The MSRP / list price.',
    '',
    'Reply with ONLY a JSON code block in exactly this shape:',
    '```json',
    JSON.stringify({
      product: 'exact product name',
      msrp: 399.99,
      currency: 'USD',
      current_price: 279.99,
      months: months.map((m) => ({ month: m, typical: 299.99, low: 279.99, source: 'camelcamelcamel' })),
      events: [{ name: 'Black Friday', start: '2026-11-27', end: '2026-12-01', expected_discount_pct: 15, confidence: 'medium' }],
      sources: [{ name: 'camelcamelcamel', url: 'https://…' }],
      confidence: 'medium',
      note: 'one or two sentences on what drives the price',
    }, null, 1),
    '```',
  ].join('\n');
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? parseFloat(v.replace(/[$,]/g, '')) : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

// Weighted least-squares slope (recent months weigh more).
function weightedSlope(ys) {
  const pts = ys.map((y, i) => ({ x: i, y, w: i + 1 })).filter((p) => p.y != null);
  if (pts.length < 2) return 0;
  const W = pts.reduce((s, p) => s + p.w, 0);
  const mx = pts.reduce((s, p) => s + p.w * p.x, 0) / W;
  const my = pts.reduce((s, p) => s + p.w * p.y, 0) / W;
  const num_ = pts.reduce((s, p) => s + p.w * (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((s, p) => s + p.w * (p.x - mx) ** 2, 0);
  return den ? num_ / den : 0;
}

// Turns the agent's JSON into chart data + projection.
function analyzeTrend(raw, { now = new Date(), currentPrice = null } = {}) {
  const months = lastSixMonths(now);
  const byMonth = new Map((raw.months || []).map((m) => [String(m.month).slice(0, 7), m]));
  const history = months.map((m) => {
    const r = byMonth.get(m) || {};
    let typical = num(r.typical);
    let low = num(r.low);
    if (typical && low && low > typical) [typical, low] = [low, typical];
    return { month: m, typical: typical || low || null, low: low || typical || null, source: r.source ? String(r.source).slice(0, 80) : null };
  });

  // Drop wild outliers (e.g. an accessory price) relative to the median.
  const vals = history.map((h) => h.typical).filter(Boolean).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
  if (med) for (const h of history) {
    if (h.typical && (h.typical < med * 0.4 || h.typical > med * 2.5)) { h.typical = null; h.low = null; h.dropped = true; }
    if (h.low && h.low < med * 0.4) h.low = null;
  }

  const typicals = history.map((h) => h.typical);
  const known = typicals.filter(Boolean);
  if (known.length < 2) return { ok: false, reason: 'Not enough price history found for this product', history, raw };

  const lows = history.map((h) => h.low).filter(Boolean);
  const agentCurrent = num(raw.current_price);
  // Baseline = today's typical price (not a one-off deal): agent's current price if it is in line
  // with recent months, else the mean of the last two months with data.
  const recent = mean(known.slice(-2));
  const baseline = agentCurrent && Math.abs(agentCurrent / recent - 1) <= 0.2 ? agentCurrent : recent;
  const bestToday = num(currentPrice);
  const current = baseline;
  const low6 = Math.min(...lows, ...known);
  const high6 = Math.max(...known);
  const avg6 = Math.round(mean(known) * 100) / 100;
  const lowMonth = history.find((h) => h.low === low6 || h.typical === low6);

  // 1) Trend: weighted slope per month, damped by half, capped at ±8 %.
  const slope = weightedSlope(typicals);
  const trendMove = Math.max(-0.08 * current, Math.min(0.08 * current, slope * 0.5));
  let mid = current + trendMove;

  // 2) Volatility band from month-over-month changes (min ±3 %).
  const changes = [];
  for (let i = 1; i < typicals.length; i++) if (typicals[i] && typicals[i - 1]) changes.push(Math.abs(typicals[i] / typicals[i - 1] - 1));
  const vol = Math.max(0.03, changes.length ? mean(changes) : 0.05);
  let lowBand = mid * (1 - vol);
  let highBand = mid * (1 + vol);

  // 3) Sale events inside the 30-day window pull the expectation and the low band down.
  const windowEnd = new Date(now.getTime() + 30 * DAY);
  const events = (raw.events || [])
    .map((e) => ({
      name: String(e.name || 'Sale event').slice(0, 60),
      start: e.start ? String(e.start).slice(0, 10) : null,
      end: e.end ? String(e.end).slice(0, 10) : null,
      discount: Math.max(0, Math.min(60, Number(e.expected_discount_pct) || 0)),
      confidence: ['high', 'medium', 'low'].includes(e.confidence) ? e.confidence : 'low',
    }))
    .filter((e) => e.start && new Date(e.start) <= windowEnd && new Date(e.end || e.start) >= now && e.discount > 0);
  const weight = { high: 0.75, medium: 0.5, low: 0.25 };
  const eventMove = events.reduce((m, e) => Math.max(m, (e.discount / 100) * weight[e.confidence]), 0);
  if (eventMove > 0) {
    mid = mid * (1 - eventMove);
    const deepest = Math.max(...events.map((e) => e.discount));
    lowBand = Math.min(lowBand, current * (1 - deepest / 100));
  }

  const round = (x) => Math.round(x * 100) / 100;
  const target = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
  const projection = {
    date: target,
    mid: round(mid),
    low: round(Math.min(lowBand, mid)),
    high: round(Math.max(highBand, mid)),
    changePct: Math.round((mid / current - 1) * 1000) / 10,
    method: `Weighted 6-month trend (${slope >= 0 ? '+' : ''}${Math.round(slope)} $/mo, damped)${eventMove ? ` + expected sale events (−${Math.round(eventMove * 100)}%)` : ''}; band = typical monthly swing (±${Math.round(vol * 100)}%).`,
  };

  return {
    ok: true,
    product: raw.product ? String(raw.product).slice(0, 160) : null,
    msrp: num(raw.msrp),
    current: { price: round(current), date: now.toISOString().slice(0, 10), from: current === agentCurrent ? 'agent' : 'history' },
    bestToday: bestToday ? { price: bestToday, vsTypicalPct: Math.round((bestToday / current - 1) * 1000) / 10, vsProjectedPct: Math.round((bestToday / mid - 1) * 1000) / 10 } : null,
    history,
    stats: { low6, high6, avg6, lowMonth: lowMonth ? lowMonth.month : null, monthsWithData: known.length },
    projection,
    events,
    sources: (raw.sources || []).filter((x) => x && x.url && /^https?:\/\//.test(x.url)).slice(0, 8).map((x) => ({ name: String(x.name || new URL(x.url).hostname).slice(0, 60), url: x.url })),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : known.length >= 5 ? 'medium' : 'low',
    note: raw.note ? String(raw.note).slice(0, 300) : null,
  };
}

async function fetchTrend({ apiKey, query, emit = () => {}, onUrl = () => {}, timeoutMs = 300000, now = new Date() }) {
  const { text } = await runAgentTask({
    apiKey,
    role: 'trend',
    prompt: buildTrendPrompt(query, now),
    metadata: { app: 'pricescout', task: 'trend', query },
    emit: (status, detail) => emit(status, detail === 'Agent is working…' ? 'Agent researching 6 months of price history…' : detail),
    onUrl,
    timeoutMs,
  });
  const raw = parseJsonBlock(text, (j) => Array.isArray(j.months));
  if (!raw) throw Object.assign(new Error('ZooWork agent did not return price history in the expected format'), { status: 502 });
  return raw;
}

module.exports = { fetchTrend, analyzeTrend, buildTrendPrompt, lastSixMonths, weightedSlope };
