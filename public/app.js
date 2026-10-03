(() => {
  const $ = (s) => document.querySelector(s);
  const form = $('#searchForm');
  const input = $('#q');
  const btn = $('#searchBtn');
  const banner = $('#banner');
  const results = $('#results');
  const empty = $('#empty');
  const chipsEl = $('#chips');
  const modePill = $('#modePill');
  const productCard = $('#productCard');
  const trendBody = $('#trendBody');
  const trendSub = $('#trendSub');
  const offersEl = $('#offers');
  const compareTitle = $('#compareTitle');
  const compareSub = $('#compareSub');
  const newOnly = $('#newOnly');
  const verifiedOnly = $('#verifiedOnly');
  const sortSel = $('#sort');
  const tooltip = $('#tooltip');
  const progressEl = $('#progress');
  const stepper = $('#stepper');
  const progressNow = $('#progressNow');
  const progressTitle = $('#progressTitle');
  const progressTime = $('#progressTime');
  const progressLog = $('#progressLog');
  const progressDetails = $('#progressDetails');
  const progressToggle = $('#progressToggle');

  const SUGGESTIONS = ['AirPods Pro 2', 'Sony WH-1000XM5', 'Nintendo Switch 2', 'Dyson V15 Detect', 'Kindle Paperwhite', 'Instant Pot Duo 6qt'];
  const PLACEHOLDER = '<svg class="ph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8.6l3.3-3.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L19 13.6V7H5Zm4 2.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/></svg>';
  const COND = { new: 'New', used: 'Used', refurbished: 'Refurbished', 'open-box': 'Open box', mixed: 'New & refurb' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const STEPS = [
    { key: 'tavily', name: 'Search stores', sub: 'Tavily' },
    { key: 'parser', name: 'Read prices', sub: 'From search results' },
    { key: 'zoowork', name: 'Verify prices', sub: 'ZooWork agent' },
    { key: 'trend', name: 'Price trend', sub: 'ZooWork agent' },
  ];

  let scope = 'stores';
  let data = null; // search result
  let searchError = null;
  let trend = null; // { state: 'loading'|'done'|'error', data }
  let view = 'list';
  let tview = 'chart';
  let streams = [];
  let openStreams = 0;
  let t0 = 0;
  let timer = null;

  const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const discount = (o) => (o.wasPrice && o.price ? Math.round((1 - o.price / o.wasPrice) * 100) : 0);
  const fmtDay = (iso) => { const d = new Date(`${iso}T12:00:00`); return `${MONTHS[d.getMonth()]} ${d.getDate()}`; };
  const agoText = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const fmtMonth = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
  window.__ph = PLACEHOLDER;
  const imgHtml = (src, alt) => (src ? `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML=window.__ph">` : PLACEHOLDER);

  // ---------- recent searches (per-browser convenience) ----------
  const recent = {
    get() { try { return JSON.parse(localStorage.getItem('ps.recent') || '[]'); } catch { return []; } },
    add(q) { try { localStorage.setItem('ps.recent', JSON.stringify([q, ...this.get().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6))); } catch {} },
    remove(q) { try { localStorage.setItem('ps.recent', JSON.stringify(this.get().filter((x) => x !== q))); } catch {} },
  };
  function renderChips() {
    const r = recent.get();
    const items = r.length ? r : SUGGESTIONS;
    chipsEl.innerHTML = `<span class="chip-label">${r.length ? 'Recent:' : 'Try:'}</span>` + items.map((q) =>
      `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}${r.length ? `<span class="x" data-remove="${esc(q)}" aria-label="Remove">×</span>` : ''}</button>`).join('');
  }
  chipsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { e.stopPropagation(); recent.remove(rm.dataset.remove); return renderChips(); }
    const chip = e.target.closest('.chip');
    if (chip) { input.value = chip.dataset.q; search(chip.dataset.q); }
  });

  // ---------- controls ----------
  document.querySelectorAll('.scope button').forEach((b) => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    document.querySelectorAll('.scope button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (data && input.value.trim().length >= 2) search(input.value.trim());
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('[data-view]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderOffers();
  }));
  document.querySelectorAll('[data-tview]').forEach((b) => b.addEventListener('click', () => {
    tview = b.dataset.tview;
    document.querySelectorAll('[data-tview]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    renderTrend();
  }));
  form.addEventListener('submit', (e) => { e.preventDefault(); closeSuggest(); const q = input.value.trim(); if (q.length >= 2) search(q); });

  // ---------- type-ahead (Tavily product suggestions) ----------
  const sugEl = $('#suggest');
  const sugCache = new Map(); // lowercased query -> suggestions
  let sugItems = [];
  let sugActive = -1;
  let sugTimer = null;
  let sugCtrl = null;
  let sugQuery = '';
  let sugLoading = false;

  const sugNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const sugMatch = (name, q) => {
    const n = ` ${sugNorm(name)} `;
    const flat = n.replace(/ /g, '');
    return sugNorm(q).split(' ').filter(Boolean).every((w) => n.includes(` ${w}`) || flat.includes(w));
  };
  const highlight = (name, q) => {
    let html = esc(name);
    for (const w of sugNorm(q).split(' ').filter((x) => x.length > 1).sort((a, b) => b.length - a.length)) {
      html = html.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
    }
    return html;
  };

  function closeSuggest() {
    sugEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    sugActive = -1;
    clearTimeout(sugTimer);
    if (sugCtrl) sugCtrl.abort();
  }

  function renderSuggest() {
    const q = input.value.trim();
    const recentMatches = recent.get().filter((r) => !q || sugMatch(r, q)).slice(0, q ? 3 : 5);
    const items = [];
    if (q.length >= 2) items.push({ kind: 'search', name: q });
    for (const r of recentMatches) if (r.toLowerCase() !== q.toLowerCase()) items.push({ kind: 'recent', name: r });
    for (const sgi of sugItems) if (!items.some((i) => i.name.toLowerCase() === sgi.name.toLowerCase())) items.push({ kind: 'product', ...sgi });
    if (!items.length && !sugLoading) { closeSuggest(); return; }
    sugEl._items = items;
    if (sugActive >= items.length) sugActive = items.length - 1;
    let html = '';
    let headerDone = false;
    items.forEach((it, i) => {
      if (it.kind === 'product' && !headerDone) {
        headerDone = true;
        html += `<div class="sg-head">Products at US stores<span class="src">via Tavily</span></div>`;
      }
      const thumb = it.kind === 'product'
        ? `<span class="sg-thumb">${it.image ? `<img src="${esc(it.image)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML=window.__ph">` : PLACEHOLDER}</span>`
        : `<span class="sg-thumb ic">${it.kind === 'recent' ? '↺' : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'}</span>`;
      const label = it.kind === 'search' ? `Search for “<mark>${esc(it.name)}</mark>”` : highlight(it.name, q);
      const side = it.kind === 'product' ? esc(it.store) : it.kind === 'recent' ? 'Recent' : '';
      html += `<div class="sg-opt" role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === sugActive}"><span>${thumb}</span><span class="sg-name">${label}</span><span class="sg-store">${side}</span></div>`;
    });
    if (sugLoading) html += `<div class="sg-head"><span class="spinner"></span>Looking up products with Tavily…</div>`;
    else if (q.length >= 3 && !sugItems.length && sugQuery === q.toLowerCase()) html += '<div class="sg-empty">No matching products found — press Enter to search anyway.</div>';
    html += '<div class="sg-foot"><kbd>↑</kbd> <kbd>↓</kbd> to choose · <kbd>Enter</kbd> to compare prices · <kbd>Esc</kbd> to close</div>';
    sugEl.innerHTML = html;
    sugEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (sugActive >= 0) input.setAttribute('aria-activedescendant', `sg-${sugActive}`);
    else input.removeAttribute('aria-activedescendant');
  }

  async function fetchSuggest(q) {
    const key = q.toLowerCase();
    if (sugCache.has(key)) { sugItems = sugCache.get(key); sugQuery = key; sugLoading = false; renderSuggest(); return; }
    // Reuse a shorter query's results while the user keeps typing (saves Tavily credits).
    for (let k = key.length - 1; k >= 3; k--) {
      const prev = sugCache.get(key.slice(0, k));
      if (prev) {
        const still = prev.filter((x) => sugMatch(x.name, q));
        if (still.length >= 3) { sugItems = still; sugQuery = key; sugLoading = false; renderSuggest(); return; }
        sugItems = still;
        break;
      }
    }
    if (sugCtrl) sugCtrl.abort();
    sugCtrl = new AbortController();
    sugLoading = true;
    renderSuggest();
    try {
      const r = await fetch('/api/suggest?' + new URLSearchParams({ q }), { signal: sugCtrl.signal });
      const j = await r.json();
      if (!j.error) sugCache.set(key, j.suggestions || []);
      if (input.value.trim().toLowerCase() !== key) return;
      sugItems = j.suggestions || [];
      sugQuery = key;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
    sugLoading = false;
    if (document.activeElement === input) renderSuggest();
  }

  function chooseSuggestion(i) {
    const it = (sugEl._items || [])[i];
    if (!it) return;
    input.value = it.name;
    closeSuggest();
    search(it.name);
  }

  input.addEventListener('input', () => {
    const q = input.value.trim();
    sugActive = -1;
    clearTimeout(sugTimer);
    if (q.length < 3) { sugItems = []; sugLoading = false; renderSuggest(); return; }
    sugLoading = !sugCache.has(q.toLowerCase());
    renderSuggest();
    sugTimer = setTimeout(() => fetchSuggest(q), 350);
  });
  input.addEventListener('focus', () => { if (!btn.disabled || input.value.trim().length < 3) renderSuggest(); });
  input.addEventListener('blur', () => setTimeout(closeSuggest, 120));
  input.addEventListener('keydown', (e) => {
    if (sugEl.hidden) { if (e.key === 'ArrowDown') { renderSuggest(); e.preventDefault(); } return; }
    const n = (sugEl._items || []).length;
    if (e.key === 'ArrowDown') { sugActive = (sugActive + 1) % n; renderSuggest(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sugActive = sugActive <= 0 ? n - 1 : sugActive - 1; renderSuggest(); e.preventDefault(); }
    else if (e.key === 'Escape') { closeSuggest(); e.preventDefault(); }
    else if (e.key === 'Enter' && sugActive >= 0) { e.preventDefault(); chooseSuggestion(sugActive); }
  });
  sugEl.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.sg-opt');
    if (!opt) return;
    e.preventDefault();
    chooseSuggestion(Number(opt.dataset.i));
  });
  [newOnly, verifiedOnly, sortSel].forEach((c) => c.addEventListener('change', renderOffers));
  progressToggle.addEventListener('click', () => {
    const open = progressDetails.hidden;
    progressDetails.hidden = !open;
    progressToggle.setAttribute('aria-expanded', String(open));
    progressToggle.textContent = open ? 'Hide details' : 'Details';
  });
  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(renderTrend, 120); });

  function showBanner(html, kind = '') { banner.className = 'banner ' + kind; banner.innerHTML = html; banner.hidden = false; }
  function setMode(mode) {
    modePill.hidden = false;
    modePill.textContent = mode === 'live' ? 'Live prices' : 'Demo mode';
    modePill.className = 'pill' + (mode === 'live' ? '' : ' demo');
  }

  // ---------- progress ----------
  const sites = new Map();
  function resetProgress() {
    progressEl.hidden = false;
    progressEl.classList.remove('is-done');
    progressTitle.textContent = 'Finding the best price…';
    stepper.innerHTML = STEPS.map((s) => `<li data-step="${s.key}" data-status="pending"><span class="ic"></span><span class="txt"><span class="nm">${s.name}</span><span class="dt">${s.sub}</span></span></li>`).join('');
    progressNow.innerHTML = '';
    progressLog.innerHTML = '';
    sites.clear();
    t0 = Date.now();
    clearInterval(timer);
    progressTime.textContent = '0s';
    timer = setInterval(() => { progressTime.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 500);
  }
  function log(sys, status, detail) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${Math.round((Date.now() - t0) / 1000)}s</span><span class="s">${esc(sys)}</span>${esc(status)} · ${esc(detail)}`;
    progressLog.appendChild(li);
    progressDetails.scrollTop = progressDetails.scrollHeight;
  }
  function onStep(ev) {
    if (ev.system === 'moss') {
      let chip = sites.get('moss');
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'site moss';
        progressNow.prepend(chip);
        sites.set('moss', chip);
      }
      chip.textContent = `⚡ ${ev.detail}`;
      chip.dataset.status = 'done';
      log('moss', ev.status, ev.detail);
      return;
    }
    if (ev.system === 'store' || ev.system === 'trend-source') {
      const key = `${ev.system}:${ev.detail}`;
      let chip = sites.get(key);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'site';
        chip.textContent = (ev.system === 'trend-source' ? '📈 ' : '') + ev.detail;
        chip.title = ev.system === 'trend-source' ? 'Price-history source' : 'Store page being verified';
        progressNow.appendChild(chip);
        sites.set(key, chip);
      }
      chip.dataset.status = ev.status;
      log(ev.system === 'store' ? 'verify' : 'trend', ev.status, ev.detail);
      return;
    }
    const sysKey = ev.system === 'cache' ? 'tavily' : ev.system;
    const li = stepper.querySelector(`[data-step="${sysKey}"]`);
    if (li) {
      li.dataset.status = ev.status;
      li.querySelector('.dt').textContent = ev.detail || '';
      li.title = ev.detail || '';
    }
    if (ev.system === 'cache') {
      for (const k of ['parser', 'zoowork']) {
        const s = stepper.querySelector(`[data-step="${k}"]`);
        if (s && s.dataset.status === 'pending') { s.dataset.status = 'done'; s.querySelector('.dt').textContent = 'From cache'; }
      }
    }
    log(ev.system, ev.status, ev.detail);
  }
  function streamDone() {
    openStreams -= 1;
    if (openStreams > 0) return;
    clearInterval(timer);
    progressEl.classList.add('is-done');
    btn.disabled = false; btn.textContent = 'Compare';
    progressTitle.textContent = `Done in ${Math.round((Date.now() - t0) / 1000)}s`;
    for (const li of stepper.querySelectorAll('[data-status="pending"],[data-status="running"]')) li.dataset.status = 'skipped';
    for (const chip of sites.values()) if (chip.dataset.status === 'running') chip.dataset.status = 'done';
  }

  // ---------- search ----------
  function closeStreams() { streams.forEach((s) => s.close()); streams = []; openStreams = 0; }

  function search(q) {
    closeStreams();
    document.body.classList.add('has-results');
    btn.disabled = true; btn.textContent = 'Searching…';
    banner.hidden = true;
    empty.hidden = true;
    data = null;
    searchError = null;
    trend = { state: 'loading' };
    results.hidden = false;
    resetProgress();
    renderAll();
    const params = new URLSearchParams({ q, scope });
    history.replaceState(null, '', '?' + params);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // 1) store prices (Tavily → parser → ZooWork verification)
    const es = new EventSource('/api/search?' + params);
    streams.push(es); openStreams += 1;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; es.close(); streamDone(); };
    es.addEventListener('step', (e) => onStep(JSON.parse(e.data)));
    es.addEventListener('preliminary', (e) => { data = JSON.parse(e.data); setMode(data.mode); renderAll(); });
    es.addEventListener('final', (e) => {
      data = JSON.parse(e.data);
      recent.add(q);
      setMode(data.mode);
      if (data.mode === 'demo') {
        showBanner(`<strong>Demo mode.</strong> Showing sample results for “${esc(data.demoQuery)}”. Add <code>TAVILY_API_KEY</code> and <code>ZOOWORK_API_KEY</code> to <code>.env</code> and restart to search live.`);
      } else if (data.verification === 'failed') {
        showBanner(`<strong>Prices not verified.</strong> ZooWork couldn’t check the store pages (${esc(data.verificationError || 'unknown error')}). Showing prices from search results — confirm at the store.`);
      }
      renderAll();
      finish();
    });
    es.addEventListener('error', (e) => {
      if (finished) return;
      searchError = e.data ? JSON.parse(e.data).error : 'Lost connection to the server. Is it still running?';
      showBanner(`<strong>Store search failed.</strong> ${esc(searchError)}`, 'error');
      renderAll();
      finish();
    });

    // 2) price trend (runs in parallel on its own ZooWork agent)
    const ts = new EventSource('/api/trend?' + new URLSearchParams({ q }));
    streams.push(ts); openStreams += 1;
    let tFinished = false;
    const tFinish = () => { if (tFinished) return; tFinished = true; ts.close(); streamDone(); };
    ts.addEventListener('step', (e) => onStep(JSON.parse(e.data)));
    ts.addEventListener('preliminary', (e) => {
      const d = JSON.parse(e.data);
      if (d.trend && d.trend.ok) { trend = { state: 'done', data: d.trend, stale: true, refreshing: true, cache: d.cache }; renderAll(); }
    });
    ts.addEventListener('final', (e) => {
      const d = JSON.parse(e.data);
      trend = d.trend && d.trend.ok
        ? { state: 'done', data: d.trend, demo: d.demo, stale: !!d.stale, cache: d.cache }
        : (trend && trend.state === 'done' ? { ...trend, refreshing: false } : { state: 'error', reason: (d.trend && d.trend.reason) || 'No price history found' });
      renderAll();
      tFinish();
    });
    ts.addEventListener('error', (e) => {
      if (tFinished) return;
      trend = { state: 'error', reason: e.data ? JSON.parse(e.data).error : 'Lost connection while loading the price trend' };
      renderAll();
      tFinish();
    });
  }

  // ---------- buy-or-wait verdict ----------
  function bestOffer() {
    if (!data) return null;
    return data.summary.bestNew || data.summary.bestAny || null;
  }
  function verdict() {
    const b = bestOffer();
    const t = trend && trend.state === 'done' ? trend.data : null;
    if (!data && searchError) return { kind: 'neutral', title: 'Store prices unavailable', text: 'The store search failed — try again in a moment.' };
    if (!data) return { kind: 'pending', title: 'Checking prices…', text: 'Comparing stores and looking up the price history.' };
    if (!b) return { kind: 'neutral', title: 'No confirmed price yet', text: 'Open the stores below to check their current price.' };
    const verifying = data.verification === 'pending';
    if (!t) {
      if (trend && trend.state === 'loading') return { kind: 'pending', title: verifying ? 'Verifying prices…' : 'Analyzing the price trend…', text: 'Buy-or-wait advice appears when the price history is ready.' };
      const others = data.offers.filter((o) => o.price != null && o !== b && !o.suspect);
      const med = others.length ? others.map((o) => o.price).sort((a, c) => a - c)[Math.floor(others.length / 2)] : null;
      return med && med > b.price
        ? { kind: 'good', title: 'Lowest price we found', text: `${money(med - b.price)} less than the typical store price (${money(med)}).` }
        : { kind: 'neutral', title: 'Best available price', text: 'Price history isn’t available for this product.' };
    }
    if (verifying) return { kind: 'pending', title: 'Verifying prices…', text: 'Price history is ready — buy-or-wait advice appears once store prices are confirmed.' };
    const p = b.price;
    const { low6, avg6 } = t.stats;
    const fc = t.projection;
    const sale = t.events && t.events[0];
    if (p <= low6 * 1.03) return { kind: 'good', title: 'Great time to buy', text: `At or below the 6-month low of ${money(low6)}${p < avg6 ? ` — ${Math.round((1 - p / avg6) * 100)}% under the 6-month average` : ''}.` };
    if (fc.mid < p * 0.95) return { kind: 'warn', title: 'Consider waiting', text: `Expected around ${money(fc.mid)} by ${fmtDay(fc.date)}${sale ? ` (${sale.name} starts ${fmtDay(sale.start)})` : ''} — about ${Math.round((1 - fc.mid / p) * 100)}% less than today.` };
    if (p <= avg6) return { kind: 'good', title: 'Good price', text: `${Math.round((1 - p / avg6) * 100)}% below the 6-month average of ${money(avg6)}. No big drop expected in the next 30 days.` };
    return { kind: 'warn', title: 'Above the usual price', text: `It has typically sold for ${money(avg6)} over the last 6 months (low ${money(low6)}).` };
  }

  // ---------- render ----------
  function renderAll() {
    const searchDone = data && data.verification !== 'pending';
    if (searchDone && !data.offers.length) {
      results.hidden = true;
      empty.hidden = false;
      empty.innerHTML = `<h2>No offers found for “${esc(data.query)}”</h2><p>Try a more specific name or model number${scope === 'stores' ? ', or switch the search to <strong>Web</strong>' : ''}.</p>`;
      return;
    }
    results.hidden = false;
    renderProduct();
    renderTrend();
    renderOffers();
  }

  function renderProduct() {
    const b = bestOffer();
    const t = trend && trend.state === 'done' ? trend.data : null;
    const v = verdict();
    const name = (t && t.product) || (b && b.title) || (data && (data.demoQuery || data.query)) || input.value;
    const verified = data && data.verification === 'verified';
    const eyebrow = !data ? (searchError ? 'Store search failed' : 'Searching…') : b ? (verified ? 'Best verified price' : data.verification === 'pending' ? 'Best price · verifying…' : 'Best price found') : 'No price yet';
    const vIcon = v.kind === 'good' ? '✓' : v.kind === 'warn' ? '!' : v.kind === 'pending' ? '' : 'i';
    const fact = (l, val, s) => `<div class="fact"><span class="l">${l}</span><span class="v">${val}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    const pend = trend && trend.state === 'loading' ? '…' : '—';
    productCard.innerHTML = `
      <div class="product-top">
        <div class="product-img">${b ? imgHtml(b.image, name) : PLACEHOLDER}</div>
        <div>
          <p class="product-name" title="${esc(name)}">${esc(name)}</p>
          <p class="eyebrow">${eyebrow}</p>
          <p class="hero-price">${b ? money(b.price) : '—'}</p>
          ${b ? `<p class="hero-store">at <strong>${esc(b.store)}</strong> · ${esc(COND[b.condition] || 'New')}${b.wasPrice ? `<span class="hero-was">${money(b.wasPrice)}</span>` : ''}</p>` : ''}
        </div>
      </div>
      <div class="verdict" data-kind="${v.kind}"><span class="vi">${vIcon}</span><div><strong>${esc(v.title)}</strong><p>${esc(v.text)}</p></div></div>
      <div class="facts">
        ${fact('6-month low', t ? money(t.stats.low6) : pend, t && t.stats.lowMonth ? fmtMonth(t.stats.lowMonth) : '')}
        ${fact('6-month average', t ? money(t.stats.avg6) : pend, '')}
        ${fact(`Forecast${t ? ` · ${fmtDay(t.projection.date)}` : ''}`, t ? `~${money(t.projection.mid)}` : pend, t ? `${t.projection.changePct > 0 ? '+' : ''}${t.projection.changePct}% vs typical` : '')}
      </div>
      <div class="cta-row">
        ${b ? `<a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">Buy at ${esc(b.store)} <span aria-hidden="true">→</span></a>` : ''}
        ${data && data.offers.length > 1 ? `<a class="btn ghost" href="#offers">Compare ${data.offers.length} offers</a>` : ''}
      </div>`;
  }

  function renderTrend() {
    if (!trend) return;
    if (trend.state === 'loading') {
      trendSub.textContent = 'A ZooWork agent is researching 6 months of price history…';
      trendBody.innerHTML = '<div class="skel-chart" aria-hidden="true"></div><p class="trend-foot">This usually takes 1–3 minutes. Store prices update as they’re verified.</p>';
      return;
    }
    if (trend.state === 'error') {
      trendSub.textContent = 'Last 6 months and the next 30 days';
      trendBody.innerHTML = `<div class="trend-empty"><div><strong>Price trend unavailable</strong><br>${esc(trend.reason)}</div></div>`;
      return;
    }
    const t = trend.data;
    const b = bestOffer();
    const saved = trend.cache ? ` · saved ${agoText(trend.cache.ageMs)}${trend.refreshing ? ', refreshing…' : ''}` : '';
    trendSub.textContent = `${fmtMonth(t.history[0].month)} – today, forecast to ${fmtDay(t.projection.date)} · ${t.confidence} confidence${trend.demo ? ' · sample data' : ''}${saved}`;
    const stat = (l, v, s) => `<div class="fact"><span class="l">${l}</span><span class="v">${v}</span>${s ? `<span class="s">${s}</span>` : ''}</div>`;
    const events = (t.events || []).map((e) => `<span class="event">🏷 ${esc(e.name)} · ${fmtDay(e.start)} · ~${e.discount}% off typical</span>`).join('');
    const sources = (t.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.name)}</a>`).join(', ');

    if (tview === 'table') {
      const rows = t.history.map((h) => `<tr><td>${fmtMonth(h.month)}</td><td class="r">${money(h.typical)}</td><td class="r">${money(h.low)}</td><td>${esc(h.source || '—')}</td></tr>`).join('');
      trendBody.innerHTML = `<table class="tbl"><thead><tr><th>Month</th><th class="r">Typical</th><th class="r">Lowest</th><th>Source</th></tr></thead><tbody>${rows}
        <tr><td>Today</td><td class="r">${money(t.current.price)}</td><td class="r">${b ? `${money(b.price)} (best verified)` : '—'}</td><td>${t.current.from === 'agent' ? 'ZooWork agent' : 'Recent months'}</td></tr>
        <tr class="fc"><td>Forecast ${fmtDay(t.projection.date)}</td><td class="r">~${money(t.projection.mid)}</td><td class="r">${money(t.projection.low)} – ${money(t.projection.high)}</td><td>Projection</td></tr></tbody></table>
        ${events ? `<div class="event-row">${events}</div>` : ''}
        <p class="trend-foot"><strong>How the forecast works:</strong> ${esc(t.projection.method)}${t.note ? ` ${esc(t.note)}` : ''}${sources ? `<br>Sources: ${sources}` : ''}</p>`;
      return;
    }

    trendBody.innerHTML = `
      <div class="legend">
        <span><i class="key-line"></i>Typical price</span>
        <span><i class="key-dot"></i>Lowest that month</span>
        <span><i class="key-dash"></i><i class="key-band"></i>30-day forecast &amp; range</span>
        ${b ? '<span><i class="key-best"></i>Best verified today</span>' : ''}
      </div>
      <div class="chart" id="chart"></div>
      <div class="trend-stats">
        ${stat('Typical now', money(t.current.price), t.msrp ? `MSRP ${money(t.msrp)}` : '')}
        ${stat('6-month range', `${money(t.stats.low6)}–${money(t.stats.high6)}`, '')}
        ${stat(`Forecast ${fmtDay(t.projection.date)}`, `~${money(t.projection.mid)}`, `${money(t.projection.low)} – ${money(t.projection.high)}`)}
        ${stat('Best today vs typical', b ? `${b.price <= t.current.price ? '−' : '+'}${Math.abs(Math.round((b.price / t.current.price - 1) * 100))}%` : '—', b ? `${money(b.price)} at ${esc(b.store)}` : '')}
      </div>
      ${events ? `<div class="event-row">${events}</div>` : ''}
      <p class="trend-foot">Forecast: ${esc(t.projection.method)}${sources ? ` Sources: ${sources}.` : ''}</p>`;
    window.TrendChart.render(document.getElementById('chart'), t, { bestToday: b ? { price: b.price } : null, tooltip });
  }

  function renderOffers() {
    if (!data && searchError) {
      compareTitle.textContent = 'Compare stores';
      compareSub.textContent = 'Store search failed';
      offersEl.className = 'offers list';
      offersEl.innerHTML = `<div class="trend-empty"><div><strong>Couldn’t load store prices</strong><br>${esc(searchError)}<br><button type="button" class="btn ghost" style="margin-top:10px" onclick="document.getElementById('searchBtn').click()">Try again</button></div></div>`;
      return;
    }
    if (!data) {
      compareTitle.textContent = 'Compare stores';
      compareSub.textContent = 'Searching major US stores…';
      offersEl.className = 'offers list';
      offersEl.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton-row"></div>').join('');
      return;
    }
    const verifiedMode = data.verification === 'verified';
    const ok = (o) => o.price != null && !o.suspect && !o.stale && o.inStock !== false && (!verifiedMode || o.verified === true);
    let list = data.offers.slice();
    if (newOnly.checked) list = list.filter((o) => o.condition === 'new');
    if (verifiedOnly.checked) list = list.filter((o) => o.verified === true);
    if (sortSel.value === 'savings') list.sort((a, b) => discount(b) - discount(a) || (a.price ?? 1e9) - (b.price ?? 1e9));
    else if (sortSel.value === 'relevance') list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => (ok(b) - ok(a)) || ((a.price ?? 1e9) - (b.price ?? 1e9)));

    const best = bestOffer();
    const stores = new Set(data.offers.map((o) => o.store)).size;
    compareTitle.textContent = `Compare ${stores} store${stores === 1 ? '' : 's'}`;
    const savedNote = data.cache ? (data.stale && btn.disabled ? ` · saved ${agoText(data.cache.ageMs)} — refreshing live…` : ` · from Moss, saved ${agoText(data.cache.ageMs)}`) : '';
    compareSub.textContent = (verifiedMode
      ? `${data.summary.verifiedCount} prices confirmed on the store page by ZooWork`
      : data.verification === 'pending' ? 'Prices from search results — ZooWork is confirming them now' : 'Prices from search results — confirm at the store') + savedNote;
    offersEl.className = `offers ${view}`;
    if (!list.length) { offersEl.innerHTML = '<p class="panel-sub" style="padding:12px 6px">No offers match these filters.</p>'; return; }

    offersEl.innerHTML = list.map((o) => {
      const tags = [];
      if (o.isBest) tags.push('<span class="tag best">Best price</span>');
      if (verifiedMode) tags.push(o.verified ? '<span class="tag ok">✓ Verified</span>' : `<span class="tag">${o.checked ? 'Not confirmed' : 'Not checked'}</span>`);
      else if (data.verification === 'pending') tags.push('<span class="tag pending">Checking…</span>');
      if (o.condition) tags.push(`<span class="tag">${esc(COND[o.condition] || o.condition)}</span>`);
      if (o.inStock === false) tags.push('<span class="tag">Out of stock</span>');
      const notes = [];
      if (o.verified && o.snippetPrice != null && Math.abs(o.snippetPrice - o.price) >= 0.01) notes.push(`Search result said ${money(o.snippetPrice)}`);
      if (verifiedMode && !o.verified && o.note) notes.push(o.note);
      if (o.stale) notes.push(`Price from ${new Date(o.asOf + 'T12:00').toLocaleDateString([], { month: 'short', year: 'numeric' })} — may be outdated`);
      else if (o.suspect) notes.push('Unusual price — may be an accessory or a different item');
      const priceTxt = o.price != null ? (o.listing ? 'from ' : '') + money(o.price) : 'See price';
      const delta = best && o.price != null && o !== best && ok(o) && o.price > best.price ? `+${money(o.price - best.price)} vs best` : '';
      const muted = !ok(o) && o.price != null;
      return `<a class="row${o.isBest ? ' is-best' : ''}${muted ? ' is-muted' : ''}" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">
        <span class="thumb">${imgHtml(o.image, o.title)}</span>
        <span class="row-main">
          <span class="row-top"><span class="store">${esc(o.store)}</span>${tags.join('')}</span>
          <p class="row-title" title="${esc(o.title)}">${esc(o.title)}</p>
          <p class="row-note">${esc(notes.join(' · '))}</p>
        </span>
        <span class="row-price"><span class="p${o.price == null ? ' none' : ''}">${priceTxt}</span>
          ${o.wasPrice ? `<span class="w"><s>${money(o.wasPrice)}</s><span class="off">−${discount(o)}%</span></span>` : ''}
          ${delta ? `<span class="delta">${delta}</span>` : ''}</span>
        <span class="row-cta">View <span aria-hidden="true">→</span></span>
      </a>`;
    }).join('');
  }

  // ---------- boot ----------
  renderChips();
  fetch('/api/health').then((r) => r.json()).then((h) => setMode(h.mode)).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get('scope') === 'web') document.querySelector('.scope [data-scope="web"]').click();
  if (params.get('q')) { input.value = params.get('q'); search(params.get('q')); }
  else input.focus();
})();
