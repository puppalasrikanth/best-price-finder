# PriceScout — every price, confirmed

**Powered by ZooWork, Tavily and Moss.** Pick a product and PriceScout shows prices and photos from major US stores within seconds (Tavily), then ZooWork agents open each store page in parallel to confirm the price, photo and stock — updating each row live. Every confirmation and photo is saved (Moss + a local image cache), so repeat searches load almost instantly.

## Run it

Requires Node.js 20 or newer (`node -v`). `start.sh` installs the one dependency (the Moss SDK) on first run.

1. In `.env`, set `MOSS_PROJECT_ID` / `MOSS_PROJECT_KEY` (from https://moss.dev), `TAVILY_API_KEY` (from https://app.tavily.com) and `ZOOWORK_API_KEY` (a `zwp_live_…` project key from https://platform.zoowork.ai)
2. Start the server:
   ```bash
   ./start.sh        # starts the server and opens http://localhost:3000
   # or
   npm start
   ```

Without a key the portal runs in **demo mode** using saved sample results, so you can try the UI first.

## Credits

Each new search uses 2 Tavily credits (`SEARCH_DEPTH=advanced`), or 1 credit with `SEARCH_DEPTH=basic`. Repeat searches within `CACHE_MINUTES` (default 30) are free. The free Tavily plan includes 1,000 credits per month.

## Persistence (Moss)

Every Tavily and ZooWork result (store prices, verified offers, price history, suggestions) is saved to a Moss index (`MOSS_INDEX`, default `pricescout-cache`). On startup the index is downloaded into the server process (`loadIndex` with auto-refresh and an on-disk cache in `.cache/`), so lookups are local and take a few milliseconds.

- **Exact or similar searches** — a lookup matches the same query or a differently worded one for the same product (semantic + keyword search). Model numbers must match exactly, so "AirPods Pro 2" never reuses "AirPods Pro 3" results.
- **Fresh** results (prices < 30 min, price history < 12 h, suggestions < 7 days) are served instantly with no API calls.
- **Older** results (prices < 48 h, history < 14 days) appear instantly as a preview while live data refreshes; the live result then replaces them and is saved.
- Writes are batched in the background, so saving never slows a response. Without Moss credentials, or if Moss is unreachable, the portal keeps working with an in-memory cache.
- `GET /api/health` reports Moss status and hit/miss counts.

## How it works

1. **Type-ahead** (`/api/suggest`): after 3+ characters Tavily suggests matching products; saved in Moss.
2. **Instant results** (`/api/search`, Server-Sent Events): Tavily returns store pages with images and prices; the parser cleans them and the page renders immediately (`preliminary` event).
3. **Saved confirmations**: each store page's last confirmation is looked up in Moss (`OFFER_CACHE_HOURS`, default 6) and applied instantly — those pages are not re-checked.
4. **Live confirmation**: every remaining page (up to `ZOOWORK_MAX_PAGES`) gets its own ZooWork session, run on a pool of `ZOOWORK_CONCURRENCY` agents (default 3) in parallel. Each agent confirms price, main product photo, condition and stock; the page updates that row as each one finishes (`offer` events). Only confirmed, in-stock prices can win best price.
5. **Persist**: each confirmation is saved to Moss; the whole result is saved too, so the same search is instant for 30 minutes and shown as an instant preview for up to 48 hours while refreshing.
6. **Images** stream through `/img`, which fetches each photo once from the store CDN, keeps it in `.cache/img` and serves it with a 7-day browser cache.

Files: `server.js` (HTTP, SSE, image cache), `lib/pipeline.js` (Tavily → parser → Moss → ZooWork pool), `lib/zoowork.js` (ZooWork client), `lib/store.js` (Moss), `lib/extract.js` (price parsing), `lib/suggest.js`, `public/`.

## Tests

```bash
npm test
```
