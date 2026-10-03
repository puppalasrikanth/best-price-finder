// Price trend chart: monthly typical price (line), monthly lows (dots), today's best (diamond),
// and a 30-day forecast (dashed line + range band). Plain SVG, crosshair tooltip on hover.
window.TrendChart = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
  const shortMoney = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const monthDate = (m) => new Date(`${m}-15T12:00:00`);
  const fmtDay = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;

  function niceTicks(min, max, count = 4) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) || 10 * mag;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  function render(container, trend, { bestToday, tooltip } = {}) {
    container.innerHTML = '';
    const W = Math.max(280, container.clientWidth);
    const H = Math.max(230, container.clientHeight || 260);
    const m = { top: 22, right: 64, bottom: 28, left: 52 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;

    const hist = trend.history.filter((h) => h.typical != null);
    const today = new Date(`${trend.current.date}T12:00:00`);
    const fcDate = new Date(`${trend.projection.date}T12:00:00`);
    const x0 = monthDate(trend.history[0].month).getTime();
    const x1 = fcDate.getTime();

    const values = [
      ...hist.map((h) => h.typical), ...trend.history.map((h) => h.low).filter(Boolean),
      trend.current.price, trend.projection.low, trend.projection.high,
    ];
    if (bestToday) values.push(bestToday.price);
    const ticks = niceTicks(Math.min(...values) * 0.97, Math.max(...values) * 1.02);
    const y0 = ticks[0];
    const y1 = ticks[ticks.length - 1];
    const X = (t) => m.left + ((t - x0) / (x1 - x0)) * iw;
    const Y = (v) => m.top + ih - ((v - y0) / (y1 - y0)) * ih;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Price history for the last 6 months and a 30-day forecast. Typical price now ${money(trend.current.price)}, forecast ${money(trend.projection.mid)}.` }, container);

    // Grid + y axis
    const g = el('g', {}, svg);
    for (const t of ticks) {
      el('line', { x1: m.left, x2: m.left + iw, y1: Y(t), y2: Y(t), stroke: 'var(--grid)', 'stroke-width': 1 }, g);
      const tx = el('text', { x: m.left - 8, y: Y(t) + 4, 'text-anchor': 'end' }, g);
      tx.textContent = shortMoney(t);
    }
    // X labels: Today + forecast first, then months that don't collide (min 34px apart)
    const placed = [];
    const xLabel = (x, text, cls) => {
      if (placed.some((px) => Math.abs(px - x) < 34)) return;
      placed.push(x);
      const tx = el('text', { x, y: H - 8, 'text-anchor': 'middle', ...(cls ? { class: cls } : {}) }, g);
      tx.textContent = text;
    };
    xLabel(X(today.getTime()), 'Today', 'lbl-2');
    xLabel(X(fcDate.getTime()), fmtDay(fcDate));
    for (const h of trend.history) xLabel(X(monthDate(h.month).getTime()), MONTHS[Number(h.month.slice(5)) - 1]);
    // "Today" divider (hairline)
    el('line', { x1: X(today.getTime()), x2: X(today.getTime()), y1: m.top - 6, y2: m.top + ih, stroke: 'var(--border)', 'stroke-width': 1 }, g);

    // Forecast band + dashed line (from today to +30 days)
    const tx0 = X(today.getTime());
    const tx1 = X(fcDate.getTime());
    const cy = Y(trend.current.price);
    el('path', { d: `M${tx0},${cy} L${tx1},${Y(trend.projection.high)} L${tx1},${Y(trend.projection.low)} Z`, fill: 'var(--series-1-wash)' }, svg);
    el('line', { x1: tx0, y1: cy, x2: tx1, y2: Y(trend.projection.mid), stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-dasharray': '5 4', 'stroke-linecap': 'round' }, svg);

    // History line (typical) through today's typical price
    const pts = hist.map((h) => [X(monthDate(h.month).getTime()), Y(h.typical)]);
    pts.push([tx0, cy]);
    el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);

    // Monthly lows (orange dots with surface ring)
    for (const h of trend.history) if (h.low != null) {
      el('circle', { cx: X(monthDate(h.month).getTime()), cy: Y(h.low), r: 4, fill: 'var(--series-2)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    }
    // Typical-price markers
    for (const [px, py] of pts.slice(0, -1)) el('circle', { cx: px, cy: py, r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    el('circle', { cx: tx0, cy, r: 5, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    el('circle', { cx: tx1, cy: Y(trend.projection.mid), r: 5, fill: 'var(--surface)', stroke: 'var(--series-1)', 'stroke-width': 2 }, svg);

    // Today's best verified price (ink diamond)
    if (bestToday) {
      const by = Y(bestToday.price);
      el('rect', { x: tx0 - 5, y: by - 5, width: 10, height: 10, rx: 2, transform: `rotate(45 ${tx0} ${by})`, fill: 'var(--text)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
      const lb = el('text', { x: tx0 - 10, y: by + 4, 'text-anchor': 'end', class: 'lbl' }, svg);
      lb.textContent = `Best today ${shortMoney(bestToday.price)}`;
    }

    // Selective labels: forecast end + 6-month low
    const endLbl = el('text', { x: tx1 + 9, y: Y(trend.projection.mid) + 4, class: 'lbl' }, svg);
    endLbl.textContent = `~${shortMoney(trend.projection.mid)}`;
    const lowPt = trend.history.find((h) => h.low === trend.stats.low6) || trend.history.find((h) => h.typical === trend.stats.low6);
    if (lowPt) {
      const lx = X(monthDate(lowPt.month).getTime());
      const ly = Y(trend.stats.low6);
      const t = el('text', { x: lx, y: Math.min(ly + 18, m.top + ih - 4), 'text-anchor': 'middle', class: 'lbl-2' }, svg);
      t.textContent = `6-mo low ${shortMoney(trend.stats.low6)}`;
    }

    // Hover: crosshair snapping to the nearest point in time
    const stops = trend.history.map((h) => ({ t: monthDate(h.month).getTime(), kind: 'month', h }));
    stops.push({ t: today.getTime(), kind: 'today' }, { t: fcDate.getTime(), kind: 'forecast' });
    const cross = el('line', { y1: m.top - 6, y2: m.top + ih, stroke: 'var(--muted)', 'stroke-width': 1, opacity: 0 }, svg);
    const hit = el('rect', { x: m.left, y: 0, width: iw + m.right - 8, height: H, fill: 'transparent' }, svg);
    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      const stop = stops.reduce((a, b) => (Math.abs(X(b.t) - px) < Math.abs(X(a.t) - px) ? b : a));
      cross.setAttribute('x1', X(stop.t));
      cross.setAttribute('x2', X(stop.t));
      cross.setAttribute('opacity', 0.6);
      let html = '';
      if (stop.kind === 'month') {
        const d = monthDate(stop.h.month);
        html = `<b>${MONTHS[d.getMonth()]} ${d.getFullYear()}</b><br>`
          + `<span class="k" style="background:var(--series-1)"></span>Typical ${money(stop.h.typical)}<br>`
          + `<span class="k" style="background:var(--series-2)"></span>Lowest ${money(stop.h.low)}`
          + (stop.h.source ? `<br><span style="opacity:.75">Source: ${escapeHtml(stop.h.source)}</span>` : '');
      } else if (stop.kind === 'today') {
        html = `<b>Today · ${fmtDay(today)}</b><br><span class="k" style="background:var(--series-1)"></span>Typical ${money(trend.current.price)}`
          + (bestToday ? `<br>◆ Best verified ${money(bestToday.price)}` : '');
      } else {
        html = `<b>Forecast · ${fmtDay(fcDate)}</b><br>Expected ~${money(trend.projection.mid)}<br>Range ${money(trend.projection.low)} – ${money(trend.projection.high)}`;
      }
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      const left = evt.clientX + 14 + tw > window.innerWidth ? evt.clientX - tw - 14 : evt.clientX + 14;
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(8, evt.clientY - 20)}px`;
    };
    const hide = () => { cross.setAttribute('opacity', 0); tooltip.hidden = true; };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return { render, money };
})();
