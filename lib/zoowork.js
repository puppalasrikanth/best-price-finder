// ZooWork (ZooClaw Managed Agents) client — verifies candidate prices by having
// an agent open each store page. Mirrors the REST calls of @zoowork-ai/sdk:
//   POST /agents · POST /agents/:id/start · GET /agents/:id
//   POST /agents/:id/sessions · GET /agents/:id/sessions/:sid/events/stream (SSE)
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://clawapi.ecap.gsmo.ai/service/v1';
const ROLES = {
  verify: { label: 'pricescout', name: 'pricescout-price-verifier', what: 'price-verification' },
  trend: { label: 'pricescout-trend', name: 'pricescout-trend-analyst', what: 'price-trend' },
};
const STATE_FILE = path.join(__dirname, '..', '.zoowork-agent.json');

class ZooworkError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createClient({ apiKey, baseUrl = process.env.ZOOWORK_BASE_URL || DEFAULT_BASE }) {
  const base = baseUrl.replace(/\/+$/, '');
  const guardedFetch = async (u, init) => {
    try {
      return await fetch(u, init);
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw e;
      const cause = e.cause && (e.cause.code || e.cause.message);
      throw new ZooworkError(0, `Could not reach ZooWork at ${new URL(u).host}${cause ? ` (${cause})` : ''}`);
    }
  };
  const headers = (extra = {}) => ({ Authorization: `Bearer ${apiKey}`, ...extra });

  async function json(p, { method = 'GET', body, signal, timeoutMs = 30000 } = {}) {
    const res = await guardedFetch(base + p, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const msg = (data.error && (data.error.message || data.error)) || data.message || data.detail || text.slice(0, 200);
      throw new ZooworkError(res.status, `ZooWork ${method} ${p.split('?')[0]} → ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return data;
  }

  // Minimal SSE reader: yields { event, id, data }.
  async function* sse(p, signal) {
    const res = await guardedFetch(base + p, { headers: headers({ Accept: 'text/event-stream' }), signal });
    if (!res.ok) throw new ZooworkError(res.status, `ZooWork stream → ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        const msg = { event: 'message', id: undefined, data: '' };
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          const [k, ...rest] = line.split(':');
          const v = rest.join(':').replace(/^ /, '');
          if (k === 'event') msg.event = v;
          else if (k === 'id') msg.id = v;
          else if (k === 'data') msg.data += (msg.data ? '\n' : '') + v;
        }
        if (!msg.data) continue;
        try { msg.data = JSON.parse(msg.data); } catch {}
        yield msg;
      }
    }
  }

  return { json, sse };
}

// Normalizes both wire shapes (event_type/eventType) like the SDK's normalizeEvent.
function normalizeEvent(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    seq: typeof r.seq === 'number' ? r.seq : -1,
    type: r.event_type || r.eventType || r.type || '',
    payload: r.payload && typeof r.payload === 'object' ? r.payload : {},
  };
}

function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  const c = message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}

// One reusable agent per role: cached id → labelled agent → create.
async function ensureAgent(zw, emit, roleKey = 'verify') {
  const role = ROLES[roleKey];
  const state = readState();
  if (state.agentId && !state.agents) state.agents = { verify: state.agentId }; // migrate v1 cache
  const agents = state.agents || {};
  let agentId = agents[roleKey];
  if (agentId) {
    try {
      await zw.json(`/agents/${encodeURIComponent(agentId)}`);
    } catch (e) {
      if (e.status === 404) agentId = null;
      else throw e;
    }
  }
  if (!agentId) {
    const list = await zw.json(`/agents?label.app=${role.label}`).catch(() => ({ agents: [] }));
    const found = (list.agents || []).find((a) => a && a.agent_id && (!a.labels || !a.labels.app || a.labels.app === role.label));
    if (found) agentId = found.agent_id;
  }
  if (!agentId) {
    emit('running', `Creating ${role.what} agent (first run only)…`);
    const created = await zw.json('/agents', {
      method: 'POST',
      body: {
        resource: {
          name: role.name,
          labels: { app: role.label },
          userTimezone: 'America/Los_Angeles',
          onboarding: false,
        },
      },
      timeoutMs: 60000,
    });
    agentId = created.agent_id || (created.agent && created.agent.agent_id);
    if (!agentId) throw new ZooworkError(500, 'ZooWork did not return an agent_id');
  }
  const fresh = readState(); // another request may have written meanwhile
  writeState({ agents: { ...(fresh.agents || (fresh.agentId ? { verify: fresh.agentId } : {})), [roleKey]: agentId } });
  return agentId;
}

async function ensureRunning(zw, agentId, emit, timeoutMs = 90000) {
  const agent = await zw.json(`/agents/${encodeURIComponent(agentId)}`);
  if (agent.status && agent.status.desired_state === 'running') return;
  emit('running', 'Starting agent…');
  await zw.json(`/agents/${encodeURIComponent(agentId)}/start`, { method: 'POST', timeoutMs: 60000 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await zw.json(`/agents/${encodeURIComponent(agentId)}`);
    if (a.status && a.status.desired_state === 'running') return;
    if (Date.now() > deadline) throw new ZooworkError(408, `Agent did not start within ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function buildPrompt(query, candidates) {
  const list = candidates.map((c, i) => ({
    n: i + 1,
    store: c.store,
    url: c.url,
    title: c.title,
    search_snippet_price: c.price,
  }));
  return [
    `You are a retail price checker. A shopper wants the best current US price for: "${query}".`,
    'Below are candidate store pages found by a web search. Their snippet prices may be stale or wrong.',
    'For EACH candidate: open the URL (use your web browsing / fetch tools), find the price for the exact product the shopper asked for',
    '(same model, generation and capacity — NOT accessories, bundles, cases or a different generation), and record:',
    '- price: the current selling price in USD for one unit (number, no $). Ignore monthly payments, protection plans, shipping, "save $X" and coupons.',
    '- was_price: list/strikethrough price if shown, else null',
    '- condition: "new" | "refurbished" | "used" | "open-box"',
    '- in_stock: true/false, or null if unclear',
    '- verified: true only if you saw the price on the live page; false if the page failed to load, is a different product, or shows no price',
    '- title: the exact product name on the page',
    '- note: short reason if not verified',
    'If a candidate is a search/category page, use the lowest price of a listing that is the exact product, and give that listing\'s URL in "url".',
    'Work quickly: one visit per URL, no extra searching beyond these pages.',
    '',
    'Candidates (JSON):',
    JSON.stringify(list, null, 1),
    '',
    'Reply with ONLY a JSON code block in this exact shape, nothing else:',
    '```json',
    '{"offers":[{"n":1,"url":"...","verified":true,"price":123.45,"was_price":null,"condition":"new","in_stock":true,"title":"...","note":""}]}',
    '```',
  ].join('\n');
}

function parseVerdict(text) {
  return parseJsonBlock(text, (j) => Array.isArray(j.offers));
}

function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Runs one agent session and returns the last assistant message.
// emit(status, detail) for the role's step; onUrl(host, status) for pages the agent opens.
async function runAgentTask({ apiKey, role, prompt, metadata, emit = () => {}, onUrl = () => {}, timeoutMs = 240000 }) {
  const zw = createClient({ apiKey });
  emit('running', 'Connecting to ZooWork…');
  const agentId = await ensureAgent(zw, emit, role);
  await ensureRunning(zw, agentId, emit);

  const session = await zw.json(`/agents/${encodeURIComponent(agentId)}/sessions`, {
    method: 'POST',
    body: { initial_events: [{ type: 'user.message', content: prompt }], metadata },
    timeoutMs: 60000,
  });
  const sessionId = session.session_id || (session.session && session.session.session_id);
  if (!sessionId) throw new ZooworkError(500, 'ZooWork did not return a session_id');
  emit('running', 'Agent is working…');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let finalText = '';
  let outcome = null;
  try {
    for await (const msg of zw.sse(`/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/events/stream`, ctrl.signal)) {
      if (msg.event === 'event_delta') continue;
      const ev = normalizeEvent(msg.data);
      if (ev.type === 'agent.tool') {
        const args = ev.payload.args || {};
        const url = args.url || args.uri || args.href || (Array.isArray(args.urls) && args.urls[0]) || '';
        const host = hostLabel(url);
        const q = args.query || args.q || '';
        if (ev.payload.phase === 'end') {
          if (host) onUrl(host, ev.payload.isError ? 'error' : 'done');
        } else if (host) {
          onUrl(host, 'running');
        } else if (q) {
          emit('running', `Searching: “${String(q).slice(0, 70)}”`);
        } else {
          emit('running', `Agent using ${ev.payload.toolName || 'a tool'}…`);
        }
      } else if (ev.type === 'agent.assistant') {
        const t = messageText(ev.payload.message);
        if (t) finalText = t; // last assistant message wins
      } else if (ev.type === 'chat.final' && !finalText) {
        finalText = messageText(ev.payload.message) || ev.payload.text || '';
      } else if (ev.type === 'agent.error' || ev.type === 'chat.error') {
        emit('running', `Agent reported an error: ${String(ev.payload.message || ev.payload.error || '').slice(0, 120)}`);
      } else if (ev.type === 'run.finished') {
        outcome = ev.payload.status || 'succeeded';
        break;
      }
    }
  } catch (e) {
    if (ctrl.signal.aborted) throw new ZooworkError(504, `ZooWork timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
  if (outcome && outcome !== 'succeeded') throw new ZooworkError(502, `ZooWork run ${outcome}`);
  return { text: finalText, agentId, sessionId };
}

// Price verification: one session that opens each candidate page.
async function verifyOffers({ apiKey, query, candidates, emit = () => {}, timeoutMs = 240000 }) {
  if (!candidates.length) return { offers: [] };
  const step = (status, detail) => emit('zoowork', status, detail);
  const { text, sessionId, agentId } = await runAgentTask({
    apiKey,
    role: 'verify',
    prompt: buildPrompt(query, candidates),
    metadata: { app: 'pricescout', task: 'verify', query },
    timeoutMs,
    emit: (status, detail) => step(status, detail === 'Agent is working…' ? `Agent checking ${candidates.length} store pages…` : detail),
    onUrl: (host, status) => emit('store', status, host),
  });
  const verdict = parseVerdict(text);
  if (!verdict) throw new ZooworkError(502, 'ZooWork agent did not return the expected JSON');
  return { offers: verdict.offers, sessionId, agentId };
}

// Generic JSON extraction from an agent reply.
function parseJsonBlock(text, check = () => true) {
  const blocks = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const str = String(text);
  const tries = blocks.length ? blocks.reverse() : [str.slice(str.indexOf('{'), str.lastIndexOf('}') + 1)];
  for (const t of tries) {
    try {
      const j = JSON.parse(t);
      if (j && check(j)) return j;
    } catch {}
  }
  return null;
}

module.exports = { verifyOffers, runAgentTask, parseVerdict, parseJsonBlock, buildPrompt, normalizeEvent, ZooworkError };
