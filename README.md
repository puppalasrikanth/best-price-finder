# PriceScout — every price, confirmed

**Powered by ZooWork & Tavily.** Pick a product and PriceScout shows prices and photos from major US stores as soon as Tavily answers, then ZooWork agents open each store page in parallel — cheapest offers first — to confirm price, photo and stock, updating each row live.

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

## Moss (disabled)

Moss persistence is switched off (`MOSS_ENABLED=false`, the default). Store confirmations are kept in memory for 30 minutes (`OFFER_CACHE_MINUTES`) so re-searching a product doesn't re-check pages that were just confirmed. The Moss code (`lib/store.js`) is kept; set `MOSS_ENABLED=true` to turn it back on later.

## How it works

1. **Type-ahead** (`/api/suggest`): after 3+ characters Tavily suggests matching products; saved in Moss.
2. **Instant results** (`/api/search`, Server-Sent Events): Tavily (`SEARCH_DEPTH=fast`) returns store pages with images and prices; the page renders the moment they're parsed (`preliminary` event). Picking a suggestion shows that product's name and photo instantly while Tavily runs.
3. **Recent confirmations**: pages confirmed in the last 30 minutes update instantly after the first render and are not re-checked; failed checks are always retried.
4. **Live confirmation**: the cheapest remaining pages (up to `ZOOWORK_MAX_PAGES`) each get their own ZooWork session, run on a pool of `ZOOWORK_CONCURRENCY` agents (default 3) in parallel. Each agent confirms price, main product photo, condition and stock; the page updates that row as each one finishes (`offer` events). Only confirmed, in-stock prices can win best price.
5. **Stop when not needed**: if the shopper leaves or starts another search, no new ZooWork checks are started.
6. **Images** stream through `/img`, which fetches each photo once from the store CDN, keeps it in `.cache/img` and serves it with a 7-day browser cache.

Files: `server.js` (HTTP, SSE, image cache), `lib/pipeline.js` (Tavily → parser → Moss → ZooWork pool), `lib/zoowork.js` (ZooWork client), `lib/store.js` (Moss), `lib/extract.js` (price parsing), `lib/suggest.js`, `public/`.

## Tests

```bash
npm test
```
