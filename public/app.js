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
  const checkBody = $('#checkBody');
  const checkSub = $('#checkSub');
  const offersEl = $('#offers');
  const compareTitle = $('#compareTitle');
  const compareSub = $('#compareSub');
  const newOnly = $('#newOnly');
  const verifiedOnly = $('#verifiedOnly');
  const sortSel = $('#sort');
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
  const STEPS = [
    { key: 'tavily', name: 'Find products', sub: 'Tavily' },
    { key: 'parser', name: 'Show prices & photos', sub: 'Instantly' },
    { key: 'zoowork', name: 'Confirm each store', sub: 'ZooWork agents' },
  ];

  let scope = 'stores';
  let data = null; // current search result (offers update live)
  let searchError = null;
  let hint = null; // product the shopper picked from suggestions — shown instantly while Tavily runs
  let view = 'list';
  let stream = null;
  let t0 = 0;
  let timer = null;
  const flashed = new Map(); // offer id -> time it last changed

  const money = (n) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const discount = (o) => (o.wasPrice && o.price ? Math.round((1 - o.price / o.wasPrice) * 100) : 0);
  const agoText = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  window.__ph = PLACEHOLDER;
  // Images stream through the server's on-disk cache (/img), so repeat views are instant.
  const imgSrc = (src) => (src ? `/img?u=${encodeURIComponent(src)}` : '');
  const imgHtml = (src, alt) => (src ? `<img src="${esc(imgSrc(src))}" alt="${esc(alt)}" loading="lazy" decoding="async" onerror="this.outerHTML=window.__ph">` : PLACEHOLDER);

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
    if (data) renderOffers(summarize());
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
    search(it.name, it.kind === 'product' ? it : null);
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
  progressToggle.addEventListener('click', () => {
    const open = progressDetails.hidden;
    progressDetails.hidden = !open;
    progressToggle.setAttribute('aria-expanded', String(open));
    progressToggle.textContent = open ? 'Hide details' : 'Details';
  });
  progressToggle.addEventListener('click', () => {
    const open = progressDetails.hidden;
    progressDetails.hidden = !open;
    progressToggle.setAttribute('aria-expanded', String(open));
    progressToggle.textContent = open ? 'Hide details' : 'Details';
  });

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
    li.innerHTML = `<span class="t">${((Date.now() - t0) / 1000).toFixed(1)}s</span><span class="s">${esc(sys)}</span>${esc(status)} · ${esc(detail)}`;
    progressLog.appendChild(li);
    progressDetails.scrollTop = progressDetails.scrollHeight;
  }
  function onStep(ev) {
    if (ev.system === 'store') {
      let chip = sites.get(ev.detail);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'site';
        chip.textContent = ev.detail;
        chip.title = 'Store page a ZooWork agent is opening';
        progressNow.appendChild(chip);
        sites.set(ev.detail, chip);
      }
      chip.dataset.status = ev.status;
      log('zoowork', ev.status, ev.detail);
      return;
    }
    const li = stepper.querySelector(`[data-step="${ev.system}"]`);
    if (li) {
      li.dataset.status = ev.status;
      li.querySelector('.dt').textContent = ev.detail || '';
      li.title = ev.detail || '';
    }
    log(ev.system, ev.status, ev.detail);
  }
  function endProgress(ok) {
    clearInterval(timer);
    progressEl.classList.add('is-done');
    btn.disabled = false; btn.textContent = 'Compare';
    progressTitle.textContent = ok ? `Done in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'Search stopped';
    for (const li of stepper.querySelectorAll('[data-status="pending"],[data-status="running"]')) li.dataset.status = ok ? 'done' : 'skipped';
    for (const chip of sites.values()) if (chip.dataset.status === 'running') chip.dataset.status = 'done';
  }

  // ---------- search ----------
  function search(q, picked = null) {
    hint = picked && picked.name === q ? picked : null;
    if (stream) stream.close();
    document.body.classList.add('has-results');
    btn.disabled = true; btn.textContent = 'Searching…';
    banner.hidden = true;
    empty.hidden = true;
    data = null;
    searchError = null;
    flashed.clear();
    results.hidden = false;
    resetProgress();
    renderAll();
    const params = new URLSearchParams({ q, scope });
    history.replaceState(null, '', '?' + params);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const es = new EventSource('/api/search?' + params);
    stream = es;
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; es.close(); if (stream === es) stream = null; endProgress(ok); renderAll(); };
    es.addEventListener('step', (e) => onStep(JSON.parse(e.data)));
    es.addEventListener('preliminary', (e) => {
      data = JSON.parse(e.data);
      setMode(data.mode);
      renderAll();
    });
    es.addEventListener('offer', (e) => {
      if (!data) return;
      const o = JSON.parse(e.data);
      const i = data.offers.findIndex((x) => x.id === o.id);
      if (i >= 0) data.offers[i] = o; else data.offers.push(o);
      flashed.set(o.id, Date.now());
      renderAll();
    });
    es.addEventListener('final', (e) => {
      const prev = data;
      data = JSON.parse(e.data);
      if (prev && prev.cache && !data.cache) data.refreshedFrom = prev.cache;
      recent.add(q);
      setMode(data.mode);
      if (data.mode === 'demo') {
        showBanner(`<strong>Demo mode.</strong> Showing sample results for “${esc(data.demoQuery)}”. Add <code>TAVILY_API_KEY</code> and <code>ZOOWORK_API_KEY</code> to <code>.env</code> and restart to search live.`);
      } else if (data.verification === 'failed') {
        showBanner(`<strong>Prices not confirmed.</strong> ${esc(data.verificationError || 'ZooWork couldn’t check the store pages')}. Showing prices from search results — confirm at the store.`);
      }
      finish(true);
    });
    es.addEventListener('error', (e) => {
      if (finished) return;
      if (data) {
        showBanner(e.data ? esc(JSON.parse(e.data).error) : 'Lost connection to the server before every store was checked.', 'error');
      } else {
        searchError = e.data ? JSON.parse(e.data).error : 'Lost connection to the server. Is it still running?';
        showBanner(`<strong>Store search failed.</strong> ${esc(searchError)}`, 'error');
      }
      finish(false);
    });
  }

  // ---------- best price (recomputed as confirmations arrive) ----------
  function summarize() {
    const offers = data.offers;
    const anyVerified = offers.some((o) => o.verified === true);
    const ok = (o) => o.price != null && !o.suspect && !o.stale && o.inStock !== false && (!anyVerified || o.verified === true);
    for (const o of offers) o.isBest = false;
    const pool = offers.filter(ok);
    const bestNew = pool.filter((o) => o.condition === 'new').sort((a, b) => a.price - b.price)[0] || null;
    const best = bestNew || pool.slice().sort((a, b) => a.price - b.price)[0] || null;
    if (best) best.isBest = true;
    const checks = offers.filter((o) => o.check && o.check !== 'skipped');
    const count = (k) => offers.filter((o) => o.check === k).length;
    const prices = pool.map((o) => o.price);
    return {
      ok, anyVerified, best, isNew: !!bestNew,
      low: prices.length ? Math.min(...prices) : null,
      high: prices.length ? Math.max(...prices) : null,
      stores: new Set(offers.map((o) => o.store)).size,
      total: checks.length,
      verified: count('verified'), cached: count('cached'), checking: count('checking'), queued: count('queued'), failed: count('failed'),
      pending: count('checking') + count('queued'),
    };
  }

  function verdict(s) {
    const b = s.best;
    if (!b) return s.pending ? { kind: 'pending', title: 'Confirming prices…', text: 'ZooWork agents are opening each store page.' } : { kind: 'neutral', title: 'No confirmed price yet', text: 'Open the stores below to check their current price.' };
    if (!b.verified) return s.pending
      ? { kind: 'pending', title: 'Best price so far', text: `From search results — ZooWork is confirming ${s.pending} store page${s.pending === 1 ? '' : 's'} now.` }
      : { kind: 'neutral', title: 'Unconfirmed price', text: 'We couldn’t confirm this on the store page — double-check before buying.' };
    const others = data.offers.filter((o) => s.ok(o) && o !== b && o.condition === b.condition).sort((x, y) => x.price - y.price);
    const next = others[0];
    const changed = b.snippetPrice != null && Math.abs(b.snippetPrice - b.price) >= 0.01 ? ` Search results said ${money(b.snippetPrice)}.` : '';
    const how = b.check === 'cached' ? `Confirmed by ZooWork on ${b.store}’s page ${b.savedAgoMs != null ? agoText(b.savedAgoMs) : 'recently'}.` : `Confirmed on ${b.store}’s page just now by ZooWork.`;
    return {
      kind: 'good',
      title: next ? `Lowest confirmed price — ${money(next.price - b.price)} less than ${next.store}` : 'Lowest confirmed price',
      text: `${how}${changed}${s.pending ? ` Still checking ${s.pending} more.` : ''}`,
    };
  }

  // ---------- render ----------
  function renderAll() {
    if (data && !data.offers.length && !stream) {
      results.hidden = true;
      empty.hidden = false;
      empty.innerHTML = `<h2>No offers found for “${esc(data.query)}”</h2><p>Try a more specific name or model number${scope === 'stores' ? ', or switch the search to <strong>Web</strong>' : ''}.</p>`;
      return;
    }
    results.hidden = false;
    const s = data ? summarize() : null;
    renderProduct(s);
    renderCheck(s);
    renderOffers(s);
  }

  function renderProduct(s) {
    if (!data) {
      productCard.innerHTML = searchError
        ? `<div class="product-top"><div class="product-img">${PLACEHOLDER}</div><div><p class="eyebrow">Store search failed</p><p class="product-name">${esc(input.value)}</p></div></div>`
        : `<div class="product-top"><div class="product-img${hint && hint.image ? '' : ' skel'}">${hint && hint.image ? imgHtml(hint.image, hint.name) : ''}</div><div style="flex:1">
            <p class="product-name">${esc(hint ? hint.name : input.value)}</p>
            <p class="eyebrow">Finding prices at 25+ US stores…</p>
            <div class="skel-line" style="width:45%;height:38px;margin-top:6px"></div></div></div>
          <div class="verdict" data-kind="pending"><span class="vi"></span><div><strong>Searching stores with Tavily…</strong><p>Prices and photos appear in a moment, then ZooWork confirms each store.</p></div></div>`;
      return;
    }
    const b = s.best;
    const v = verdict(s);
    const name = (b && b.title) || data.demoQuery || data.query;
    const vIcon = v.kind === 'good' ? '✓' : v.kind === 'warn' ? '!' : v.kind === 'pending' ? '' : 'i';
    const fact = (l, val, sub) => `<div class="fact"><span class="l">${l}</span><span class="v">${val}</span>${sub ? `<span class="s">${sub}</span>` : ''}</div>`;
    productCard.innerHTML = `
      <div class="product-top">
        <div class="product-img">${b ? imgHtml(b.image, name) : PLACEHOLDER}${b && b.imageVerified ? '<span class="img-ok" title="Photo confirmed on the store page">✓</span>' : ''}</div>
        <div>
          <p class="product-name" title="${esc(name)}">${esc(name)}</p>
          <p class="eyebrow">${b ? (b.verified ? (s.isNew ? 'Best confirmed price · new' : 'Best confirmed price') : 'Best price so far') : 'Searching stores…'}</p>
          <p class="hero-price${b && !b.verified ? ' pending' : ''}">${b ? money(b.price) : '—'}</p>
          ${b ? `<p class="hero-store">at <strong>${esc(b.store)}</strong> · ${esc(COND[b.condition] || 'New')}${b.wasPrice ? `<span class="hero-was">${money(b.wasPrice)}</span>` : ''}</p>` : ''}
        </div>
      </div>
      <div class="verdict" data-kind="${v.kind}"><span class="vi">${vIcon}</span><div><strong>${esc(v.title)}</strong><p>${esc(v.text)}</p></div></div>
      <div class="facts">
        ${fact('Stores compared', s.stores, `${data.offers.length} offers`)}
        ${fact('Price range', s.low != null ? `${money(s.low)}${s.high > s.low ? `–${money(s.high)}` : ''}` : '—', s.anyVerified ? 'confirmed prices' : 'from search results')}
        ${fact('Confirmed', `${s.verified + s.cached} of ${s.total}`, s.pending ? 'checking…' : '')}
      </div>
      <div class="cta-row">
        ${b ? `<a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">Buy at ${esc(b.store)} <span aria-hidden="true">→</span></a>` : ''}
        ${data.offers.length > 1 ? `<a class="btn ghost" href="#offers">Compare ${data.offers.length} offers</a>` : ''}
      </div>`;
  }

  function renderCheck(s) {
    if (!data) {
      checkSub.textContent = 'ZooWork agents confirm each price and photo on the store’s own page';
      checkBody.innerHTML = '<div class="skel-line" style="width:100%;height:10px"></div>' + Array.from({ length: 4 }, () => '<div class="skel-line" style="height:30px;margin-top:10px"></div>').join('');
      return;
    }
    const done = s.verified + s.cached + s.failed;
    const pct = s.total ? Math.round((done / s.total) * 100) : 100;
    checkSub.textContent = data.mode === 'demo' ? 'Demo mode — sample data, no live checks'
      : !s.total ? 'No store pages to check'
      : s.pending ? `Checking ${s.pending} of ${s.total} store pages in parallel…`
      : `${s.verified + s.cached} of ${s.total} store pages confirmed`;
    const rows = data.offers.filter((o) => o.check && o.check !== 'skipped');
    const statusTxt = { queued: 'In queue', checking: 'Checking…', verified: 'Confirmed', cached: 'Confirmed earlier', failed: 'Not confirmed' };
    checkBody.innerHTML = `
      <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Store pages checked">
        <span class="seg-ok" style="width:${s.total ? ((s.verified + s.cached) / s.total) * 100 : 0}%"></span><span class="seg-bad" style="width:${s.total ? (s.failed / s.total) * 100 : 0}%"></span>
      </div>
      <div class="meter-legend"><span><i class="dot ok"></i>${s.verified} confirmed now</span>${s.cached ? `<span><i class="dot earlier"></i>${s.cached} confirmed earlier</span>` : ''}<span><i class="dot run"></i>${s.checking} checking · ${s.queued} to go</span><span><i class="dot bad"></i>${s.failed} not confirmed</span></div>
      <ul class="check-list">${rows.map((o) => `
        <li data-check="${o.check}" class="${flashed.has(o.id) && Date.now() - flashed.get(o.id) < 1600 ? 'flash' : ''}">
          <span class="ck-ic" aria-hidden="true"></span>
          <span class="ck-store">${esc(o.store)}</span>
          <span class="ck-status" title="${esc(o.note || '')}">${statusTxt[o.check] || ''}${o.check === 'failed' && o.note ? ` — ${esc(o.note)}` : ''}</span>
          <span class="ck-price">${o.price != null ? money(o.price) : ''}</span>
        </li>`).join('') || '<li class="muted">Nothing to check</li>'}</ul>
      <p class="check-foot">Each store page is opened by its own ZooWork agent, cheapest offers first. Photos stream through a local image cache.</p>`;
  }

  function renderOffers(s) {
    if (!data && searchError) {
      compareTitle.textContent = 'Compare stores';
      compareSub.textContent = 'Store search failed';
      offersEl.className = 'offers list';
      offersEl.innerHTML = `<div class="empty-inline"><strong>Couldn’t load store prices</strong><br>${esc(searchError)}<br><button type="button" class="btn ghost" style="margin-top:10px" onclick="document.getElementById('searchBtn').click()">Try again</button></div>`;
      return;
    }
    if (!data) {
      compareTitle.textContent = 'Compare stores';
      compareSub.textContent = 'Finding products with Tavily…';
      offersEl.className = 'offers list';
      offersEl.innerHTML = Array.from({ length: 5 }, () => '<div class="skeleton-row"></div>').join('');
      return;
    }
    let list = data.offers.slice();
    if (newOnly.checked) list = list.filter((o) => o.condition === 'new');
    if (verifiedOnly.checked) list = list.filter((o) => o.verified === true);
    if (sortSel.value === 'savings') list.sort((a, b) => discount(b) - discount(a) || (a.price ?? 1e9) - (b.price ?? 1e9));
    else if (sortSel.value === 'relevance') list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => (s.ok(b) - s.ok(a)) || ((a.price ?? 1e9) - (b.price ?? 1e9)));

    const best = s.best;
    compareTitle.textContent = `Compare ${s.stores} store${s.stores === 1 ? '' : 's'}`;
    const saved = '';
    compareSub.textContent = (s.pending
      ? `Prices and photos from Tavily — ZooWork is confirming ${s.pending} now`
      : s.anyVerified ? `${s.verified + s.cached} prices confirmed on the store page` : 'Prices from search results — confirm at the store') + saved;
    offersEl.className = `offers ${view}`;
    if (!list.length) { offersEl.innerHTML = '<p class="panel-sub" style="padding:12px 6px">No offers match these filters.</p>'; return; }

    offersEl.innerHTML = list.map((o) => {
      const tags = [];
      if (o.isBest) tags.push('<span class="tag best">Best price</span>');
      if (o.check === 'verified') tags.push('<span class="tag ok">✓ Confirmed<span class="long"> by ZooWork</span></span>');
      else if (o.check === 'cached') tags.push(`<span class="tag ok">✓ Confirmed<span class="long"> ${o.savedAgoMs != null ? agoText(o.savedAgoMs) : 'earlier'}</span></span>`);
      else if (o.check === 'checking') tags.push('<span class="tag pending"><span class="mini-spin"></span><span class="long">ZooWork </span>checking…</span>');
      else if (o.check === 'queued') tags.push('<span class="tag">In queue</span>');
      else if (o.check === 'failed') tags.push('<span class="tag">Not confirmed</span>');
      if (o.condition) tags.push(`<span class="tag">${esc(COND[o.condition] || o.condition)}</span>`);
      if (o.inStock === false) tags.push('<span class="tag">Out of stock</span>');
      const notes = [];
      if (o.verified && o.snippetPrice != null && Math.abs(o.snippetPrice - o.price) >= 0.01) notes.push(`Price updated — search result said ${money(o.snippetPrice)}`);
      if (o.check === 'failed' && o.note) notes.push(o.note);
      if (o.stale) notes.push(`Price from ${new Date(o.asOf + 'T12:00').toLocaleDateString([], { month: 'short', year: 'numeric' })} — may be outdated`);
      else if (o.suspect && !o.verified) notes.push('Unusual price — may be an accessory or a different item');
      const priceTxt = o.price != null ? (o.listing ? 'from ' : '') + money(o.price) : 'See price';
      const delta = best && o.price != null && o !== best && s.ok(o) && o.price > best.price ? `+${money(o.price - best.price)} vs best` : '';
      const muted = !s.ok(o) && o.price != null;
      const fl = flashed.has(o.id) && Date.now() - flashed.get(o.id) < 1600 ? ' flash' : '';
      return `<a class="row${o.isBest ? ' is-best' : ''}${muted ? ' is-muted' : ''}${o.check === 'checking' ? ' is-checking' : ''}${fl}" data-id="${esc(o.id)}" href="${esc(o.url)}" target="_blank" rel="noopener noreferrer">
        <span class="thumb">${imgHtml(o.image, o.title)}${o.imageVerified ? '<span class="img-ok" title="Photo confirmed on the store page">✓</span>' : ''}</span>
        <span class="row-main">
          <span class="row-top"><span class="store">${esc(o.store)}</span>${tags.join('')}</span>
          <p class="row-title" title="${esc(o.title)}">${esc(o.title)}</p>
          <p class="row-note">${esc(notes.join(' · '))}</p>
        </span>
        <span class="row-price"><span class="p${o.price == null ? ' none' : ''}${o.verified ? '' : ' unconfirmed'}">${priceTxt}</span>
          ${o.wasPrice ? `<span class="w"><s>${money(o.wasPrice)}</s><span class="off">−${discount(o)}%</span></span>` : ''}
          ${delta ? `<span class="delta">${delta}</span>` : ''}</span>
        <span class="row-cta">View <span aria-hidden="true">→</span></span>
      </a>`;
    }).join('');
  }

  [newOnly, verifiedOnly, sortSel].forEach((c) => c.addEventListener('change', () => data && renderOffers(summarize())));

  // ---------- boot ----------
  renderChips();
  fetch('/api/health').then((r) => r.json()).then((h) => setMode(h.mode)).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get('scope') === 'web') document.querySelector('.scope [data-scope="web"]').click();
  if (params.get('q')) { input.value = params.get('q'); search(params.get('q')); }
  else input.focus();
})();
