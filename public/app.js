(() => {
  const $ = (s) => document.querySelector(s);
  const form = $('#searchForm');
  const input = $('#q');
  const btn = $('#searchBtn');
  const grid = $('#grid');
  const results = $('#results');
  const summaryEl = $('#summary');
  const countEl = $('#count');
  const banner = $('#banner');
  const empty = $('#empty');
  const newOnly = $('#newOnly');
  const sortSel = $('#sort');
  const chipsEl = $('#chips');
  const modePill = $('#modePill');
  const tpl = $('#cardTpl');

  const SUGGESTIONS = ['AirPods Pro 2', 'Nintendo Switch OLED', 'Dyson V15 Detect', 'Instant Pot Duo 6qt', 'Kindle Paperwhite', 'Samsung 65" QLED TV'];
  const PLACEHOLDER = '<svg class="ph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm1 2v8.6l3.3-3.3a1 1 0 0 1 1.4 0l2.3 2.3 3.3-3.3a1 1 0 0 1 1.4 0L19 13.6V7H5Zm4 2.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"/></svg>';
  const COND = { new: 'New', used: 'Used', refurbished: 'Refurbished', 'open-box': 'Open box', mixed: 'New & refurb' };

  let scope = 'stores';
  let data = null;
  let inflight = null;
  const progressEl = $('#progress');
  const progressList = $('#progressList');
  const storeList = $('#storeList');
  const progressTitle = $('#progressTitle');
  const progressTime = $('#progressTime');

  const money = (n) => (n == null ? '' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0 }));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const discount = (o) => (o.wasPrice && o.price ? Math.round((1 - o.price / o.wasPrice) * 100) : 0);

  // ---- recent searches (per-browser convenience only) ----
  const recent = {
    get() { try { return JSON.parse(localStorage.getItem('ps.recent') || '[]'); } catch { return []; } },
    add(q) {
      try {
        const list = [q, ...this.get().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6);
        localStorage.setItem('ps.recent', JSON.stringify(list));
      } catch {}
    },
    remove(q) { try { localStorage.setItem('ps.recent', JSON.stringify(this.get().filter((x) => x !== q))); } catch {} },
  };

  function renderChips() {
    const r = recent.get();
    const items = r.length ? r : SUGGESTIONS;
    chipsEl.innerHTML = (r.length ? '<span class="chip-label" style="font-size:13px;color:var(--muted);align-self:center">Recent:</span>' : '') +
      items.map((q) => `<button type="button" class="chip" data-q="${esc(q)}">${esc(q)}${r.length ? '<span class="x" data-remove="' + esc(q) + '" aria-label="Remove">×</span>' : ''}</button>`).join('');
  }
  chipsEl.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { e.stopPropagation(); recent.remove(rm.dataset.remove); return renderChips(); }
    const chip = e.target.closest('.chip');
    if (chip) { input.value = chip.dataset.q; search(chip.dataset.q); }
  });

  document.querySelectorAll('.segmented button').forEach((b) => b.addEventListener('click', () => {
    scope = b.dataset.scope;
    document.querySelectorAll('.segmented button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (input.value.trim().length >= 2 && data) search(input.value.trim());
  }));

  form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value.trim(); if (q.length >= 2) search(q); });
  newOnly.addEventListener('change', renderGrid);
  sortSel.addEventListener('change', renderGrid);

  function showBanner(html, kind = '') { banner.className = 'banner ' + kind; banner.innerHTML = html; banner.hidden = false; }

  function skeletons() {
    results.hidden = false; empty.hidden = true;
    summaryEl.innerHTML = '';
    countEl.textContent = 'Searching stores…';
    grid.innerHTML = Array.from({ length: 8 }, () => '<article class="card skeleton"><div class="card-media"></div><div class="line" style="width:40%"></div><div class="line"></div><div class="line" style="width:70%"></div><div class="line" style="width:35%;height:18px;margin-bottom:18px"></div></article>').join('');
  }

  // ---- progress panel ----
  const SYSTEMS = {
    cache: { name: 'Cache', icon: '⚡' },
    tavily: { name: 'Tavily search', icon: '🔎' },
    parser: { name: 'Price parser', icon: '🧮' },
    zoowork: { name: 'ZooWork agent', icon: '🤖' },
  };
  let progressStart = 0;
  let progressTimer = null;
  const stores = new Map();

  function resetProgress() {
    progressEl.hidden = false;
    progressEl.classList.remove('is-done');
    progressList.innerHTML = '';
    storeList.innerHTML = '';
    stores.clear();
    progressStart = Date.now();
    clearInterval(progressTimer);
    progressTimer = setInterval(() => { progressTime.textContent = `${Math.round((Date.now() - progressStart) / 1000)}s`; }, 500);
    progressTitle.textContent = 'Finding the best price…';
  }

  function stepRow(system) {
    let row = progressList.querySelector(`[data-system="${system}"]`);
    if (!row) {
      const meta = SYSTEMS[system] || { name: system, icon: '•' };
      row = document.createElement('li');
      row.dataset.system = system;
      row.innerHTML = `<span class="st"></span><span class="sys">${esc(meta.name)}</span><span class="det"></span>`;
      progressList.appendChild(row);
    }
    return row;
  }

  function onStep(ev) {
    if (ev.system === 'store') {
      let chip = stores.get(ev.detail);
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'store-chip';
        chip.textContent = ev.detail;
        storeList.appendChild(chip);
        stores.set(ev.detail, chip);
      }
      chip.dataset.status = ev.status;
      return;
    }
    const row = stepRow(ev.system);
    row.dataset.status = ev.status;
    row.querySelector('.det').textContent = ev.detail || '';
  }

  function endProgress(ok) {
    clearInterval(progressTimer);
    progressEl.classList.add('is-done');
    progressTitle.textContent = ok ? `Done in ${Math.round((Date.now() - progressStart) / 1000)}s` : 'Search stopped';
    for (const chip of stores.values()) if (chip.dataset.status === 'running') chip.dataset.status = 'done';
  }

  function search(q) {
    if (inflight) inflight.close();
    document.body.classList.add('has-results');
    btn.disabled = true; btn.textContent = 'Searching…';
    banner.hidden = true;
    data = null;
    skeletons();
    resetProgress();
    const params = new URLSearchParams({ q, scope });
    history.replaceState(null, '', '?' + params);
    const es = new EventSource('/api/search?' + params);
    inflight = es;
    const done = (ok) => {
      es.close();
      if (inflight === es) inflight = null;
      btn.disabled = false; btn.textContent = 'Compare prices';
      endProgress(ok);
    };
    es.addEventListener('step', (e) => onStep(JSON.parse(e.data)));
    es.addEventListener('preliminary', (e) => {
      data = JSON.parse(e.data);
      setMode(data.mode);
      render();
    });
    es.addEventListener('final', (e) => {
      data = JSON.parse(e.data);
      recent.add(q);
      setMode(data.mode);
      if (data.mode === 'demo') {
        showBanner(`<strong>Demo mode.</strong> Showing sample results for “${esc(data.demoQuery)}”. Add your Tavily key to <code>.env</code> as <code>TAVILY_API_KEY=tvly-…</code> and restart the server to search live.`);
      } else if (data.verification === 'failed') {
        showBanner(`<strong>Prices not verified.</strong> ZooWork couldn’t check the store pages (${esc(data.verificationError || 'unknown error')}). Showing prices from search snippets — confirm at the store.`);
      }
      render();
      done(true);
    });
    es.addEventListener('error', (e) => {
      if (e.data) {
        const msg = JSON.parse(e.data).error;
        if (!data) results.hidden = true;
        showBanner(esc(msg), 'error');
        done(false);
      } else if (es.readyState === EventSource.CLOSED || !data || data.verification === 'pending') {
        if (inflight === es) {
          showBanner('Lost connection to the server. Is it still running?', 'error');
          done(false);
        }
      }
    });
  }

  function setMode(mode) {
    modePill.hidden = false;
    modePill.textContent = mode === 'live' ? 'Live prices' : 'Demo mode';
    modePill.className = 'pill' + (mode === 'live' ? '' : ' demo');
  }

  function imgHtml(src, alt) {
    return src ? `<img src="${esc(src)}" alt="${esc(alt)}" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:${esc(JSON.stringify(PLACEHOLDER))}}))">` : PLACEHOLDER;
  }

  function render() {
    const { offers, summary } = data;
    if (!offers.length) {
      results.hidden = true; empty.hidden = false;
      empty.innerHTML = `<h2>No offers found for “${esc(data.query)}”</h2><p>Try a more specific name or model number${scope === 'stores' ? ', or switch to <strong>Whole web</strong>' : ''}.</p>`;
      return;
    }
    results.hidden = false; empty.hidden = true;

    const b = summary.bestNew || summary.bestAny;
    const bestHtml = b ? `
      <div class="best">
        <a class="best-img" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">${imgHtml(b.image, b.title)}</a>
        <div>
          <p class="eyebrow">${summary.bestNew ? (data.verification === 'verified' ? 'Best verified new price' : 'Best new price') : 'Lowest price found'}${data.verification === 'pending' ? ' · verifying…' : ''}</p>
          <p class="best-price">${money(b.price)}</p>
          <p class="best-title">at <span class="best-store">${esc(b.store)}</span> · ${esc(b.title)}</p>
          <a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener noreferrer">Go to ${esc(b.store)} <span aria-hidden="true">→</span></a>
        </div>
      </div>` : `<div class="best"><div></div><div><p class="eyebrow">No clear price</p><p class="best-title">We found products but couldn’t read a reliable price. Check the stores below.</p></div></div>`;

    const spread = summary.low != null && summary.high != null && summary.high > summary.low ? summary.high - summary.low : null;
    summaryEl.innerHTML = bestHtml + `
      <div class="stats">
        <div class="stat"><p class="stat-label">Price range</p><p class="stat-value">${summary.low != null ? money(summary.low) + (spread ? '–' + money(summary.high) : '') : '—'}</p>${spread ? `<p class="stat-sub">${money(spread)} difference across stores</p>` : ''}</div>
        <div class="stat"><p class="stat-label">Stores compared</p><p class="stat-value">${summary.stores}</p><p class="stat-sub">${summary.pricedCount} with a price</p></div>
        <div class="stat"><p class="stat-label">Lowest any condition</p><p class="stat-value">${summary.bestAny ? money(summary.bestAny.price) : (b ? money(b.price) : '—')}</p>${summary.bestAny ? `<p class="stat-sub">${esc(COND[summary.bestAny.condition] || '')} · ${esc(summary.bestAny.store)}</p>` : ''}</div>
        <div class="stat"><p class="stat-label">Price check</p><p class="stat-value">${verificationLabel()}</p><p class="stat-sub">${data.cached ? 'Cached · ' : ''}${new Date(data.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p></div>
      </div>`;
    renderGrid();
  }

  function verificationLabel() {
    const v = data.verification;
    if (v === 'verified') return `✓ ${data.summary.verifiedCount} verified`;
    if (v === 'pending') return 'Verifying…';
    if (v === 'failed') return 'Unverified';
    return data.mode === 'demo' ? 'Demo' : 'Snippets only';
  }

  function renderGrid() {
    if (!data) return;
    let list = data.offers.slice();
    if (newOnly.checked) list = list.filter((o) => o.condition === 'new');
    const ok = (o) => o.price != null && !o.suspect && !o.stale && o.inStock !== false && (data.verification !== 'verified' || o.verified === true);
    if (sortSel.value === 'savings') list.sort((a, b) => discount(b) - discount(a) || (a.price ?? 1e9) - (b.price ?? 1e9));
    else if (sortSel.value === 'relevance') list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => (ok(b) - ok(a)) || ((a.price ?? 1e9) - (b.price ?? 1e9)));

    countEl.innerHTML = `<strong>${list.length}</strong> offer${list.length === 1 ? '' : 's'} for “${esc(data.demoQuery || data.query)}”`;
    grid.innerHTML = '';
    for (const o of list) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.querySelectorAll('a').forEach((a) => (a.href = o.url));
      const media = node.querySelector('.card-media');
      media.innerHTML = imgHtml(o.image, o.title) + (o.isBest ? '<span class="ribbon">Best price</span>' : '');
      node.querySelector('.store').textContent = o.store;
      node.querySelector('.cond').textContent = o.condition ? COND[o.condition] || '' : '';
      node.querySelector('.card-title a').textContent = o.title;
      node.querySelector('.card-title a').title = o.title;
      const price = node.querySelector('.price');
      if (o.price != null) {
        price.textContent = (o.listing ? 'from ' : '') + money(o.price) + (o.priceHigh && o.priceHigh > o.price ? ' – ' + money(o.priceHigh) : '');
      } else {
        price.textContent = 'See price at store';
        price.classList.add('none');
      }
      if (o.wasPrice) {
        node.querySelector('.was').textContent = money(o.wasPrice);
        node.querySelector('.off').textContent = `-${discount(o)}%`;
      }
      const notes = [];
      const badge = node.querySelector('.verify');
      if (data.verification === 'verified') {
        if (o.verified) { badge.textContent = '✓ Verified'; badge.dataset.kind = 'ok'; }
        else { badge.textContent = o.checked ? 'Not confirmed' : 'Not checked'; badge.dataset.kind = 'no'; }
      } else if (data.verification === 'pending') { badge.textContent = 'Checking…'; badge.dataset.kind = 'pending'; }
      else badge.remove();
      if (o.verified && o.snippetPrice != null && Math.abs(o.snippetPrice - o.price) >= 0.01) notes.push(`Search snippet said ${money(o.snippetPrice)}`);
      if (o.inStock === false) notes.push('Out of stock');
      if (data.verification === 'verified' && !o.verified && o.note) notes.push(o.note);
      if (o.stale) notes.push(`Price as of ${new Date(o.asOf + 'T00:00').toLocaleDateString([], { month: 'short', year: 'numeric' })} — may be outdated`);
      else if (o.suspect) notes.push('Unusual price — may be an accessory or a different item');
      node.querySelector('.note').textContent = notes.join(' · ');
      if (o.isBest) node.classList.add('is-best');
      if (o.suspect || o.stale || o.inStock === false || (data.verification === 'verified' && !o.verified)) node.classList.add('is-muted');
      grid.appendChild(node);
    }
  }

  // Boot
  renderChips();
  fetch('/api/health').then((r) => r.json()).then((h) => setMode(h.mode)).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get('scope') === 'web') document.querySelector('[data-scope="web"]').click();
  if (params.get('q')) { input.value = params.get('q'); search(params.get('q')); }
  else input.focus();
})();
