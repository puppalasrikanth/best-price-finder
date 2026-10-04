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

Each new search runs two Tavily queries in parallel (all stores, and all stores except Amazon, so Amazon's search pages can't crowd out the rest): 2 credits with `SEARCH_DEPTH=fast` or `basic`, 4 with `advanced`. Repeat searches within `CACHE_MINUTES` (default 30) are free. The free Tavily plan includes 1,000 credits per month.

## Deploying publicly (Railway)

`railway.json` runs `node server.js` with a health check on `/api/health`. Set these variables on the service (never commit `.env`): `TAVILY_API_KEY`, `ZOOWORK_API_KEY`, `MOSS_PROJECT_ID`, `MOSS_PROJECT_KEY`, `NODE_ENV=production`, `SEARCH_DEPTH=fast`, `MOSS_ENABLED=false`. In production the server listens on `0.0.0.0:$PORT` and does not auto-import the catalog (it reads the Moss index you imported locally).

Protection for public traffic (all adjustable by env var):

| Limit | Default (production) |
|---|---|
| Searches per visitor | 6 / minute, 60 / hour (`SEARCH_PER_MINUTE`, `SEARCH_PER_HOUR`) |
| Type-ahead requests per visitor | 90 / minute (`SUGGEST_PER_MINUTE`) |
| Tavily searches per day (all visitors) | 400 (`TAVILY_DAILY_LIMIT`, 0 = no cap) |
| Tavily type-ahead fallbacks per day | 1,500 (`SUGGEST_TAVILY_DAILY_LIMIT`) |
| ZooWork store checks per day | 300 (`ZOOWORK_DAILY_LIMIT`) |
| Parallel ZooWork sessions (all visitors) | 6 (`ZOOWORK_GLOBAL_MAX`) |

The image proxy resolves DNS and refuses private, loopback and cloud-metadata addresses (every redirect hop is re-checked), and every response carries security headers (CSP, no framing, nosniff).

## Moss

**Product catalog for type-ahead (on).** Moss index `pricescout-products` holds product names for instant suggestions while typing:

- **Seed:** the ~100,000 most-reviewed products from [Amazon Reviews 2023](https://amazon-reviews-2023.github.io/) (McAuley Lab, UCSD) across Electronics, Cell Phones, Toys, Video Games, Appliances, Office and Musical Instruments. `scripts/import-catalog.js` streams each category's gzipped metadata once (very roughly 3–5 GB in total, nothing large kept on disk), keeps the top products by number of ratings, cleans the names and uploads each category as soon as it's done. It starts automatically in the background on first launch (`CATALOG_AUTO_IMPORT=false` to skip) and resumes if interrupted; run `node scripts/import-catalog.js --restart` to rebuild. Note the dataset ends in Sept 2023 — newer products come from learning.
- **Learning:** every product name Tavily returns (suggestions and search results) is added automatically.
- **Lookup:** every keystroke asks Moss (`/api/suggest?source=moss`, milliseconds) and, after a short pause, Tavily (`source=tavily`, which also reads every product listed on store search pages). The page merges both into one list of up to 10 unique products matching what's typed — Moss first, Tavily's extra products added as they arrive, color/condition variants shown once — and tags each with its source. Without `source`, the endpoint queries both in parallel and returns the merged list.
- Moss's free tier allows 10 indexes × 100,000 documents; the catalog uses one index (`CATALOG_SIZE`, default 100,000).

**Search persistence (off).** `MOSS_ENABLED=false`: store confirmations are kept in memory for 30 minutes (`OFFER_CACHE_MINUTES`). Set `MOSS_ENABLED=true` to persist them in Moss.

## How it works

1. **Type-ahead** (`/api/suggest`): from 2 characters the Moss product catalog suggests matching products instantly; from 3 characters Tavily's live store results are merged in, de-duplicated.
2. **Instant results** (`/api/search`, Server-Sent Events): Tavily (`SEARCH_DEPTH=fast`) returns store pages with images and prices. Store search pages ("Amazon.com : samsung galaxy") are split into one offer per named product, accessories are dropped, and the best `MAX_PRODUCTS` (default 10) are kept, spread across stores. The page renders the moment they're parsed (`preliminary` event). Picking a suggestion shows that product's name and photo instantly while Tavily runs.
3. **Recent confirmations**: pages confirmed in the last 30 minutes update instantly after the first render and are not re-checked; failed checks are always retried.
4. **Live confirmation**: the cheapest remaining pages (up to `ZOOWORK_MAX_PAGES`) each get their own ZooWork session, run on a pool of `ZOOWORK_CONCURRENCY` agents (default 5) in parallel; if a store page is blocked, the agent may search for the product on that store (up to 3 pages). Each agent confirms price, main product photo, condition and stock; the page updates that row as each one finishes (`offer` events). Only confirmed, in-stock prices can win best price.
5. **Stop when not needed**: if the shopper leaves or starts another search, no new ZooWork checks are started.
6. **Images** stream through `/img`, which fetches each photo once from the store CDN, keeps it in `.cache/img` and serves it with a 7-day browser cache.

Files: `server.js` (HTTP, SSE, image cache), `lib/pipeline.js` (Tavily → parser → Moss → ZooWork pool), `lib/zoowork.js` (ZooWork client), `lib/store.js` (Moss), `lib/extract.js` (price parsing), `lib/suggest.js`, `public/`.

## Tests

```bash
npm test
```
