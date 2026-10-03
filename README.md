# PriceScout — Best Price Portal

Search any product and compare prices across major US retailers (Amazon, Walmart, Target, Best Buy, eBay, Costco, B&H and more). Tavily finds the store pages, then a ZooWork agent opens each page to confirm the live price, condition and stock. Only verified prices can win "best price". A second ZooWork agent researches the last 6 months of price history, and PriceScout projects the next 30 days and tells shoppers whether to buy now or wait. A progress panel shows each system as it works.

## Run it

Requires Node.js 18 or newer (`node -v`). There are no npm packages to install.

1. In `.env`, set `TAVILY_API_KEY` (from https://app.tavily.com) and `ZOOWORK_API_KEY` (a `zwp_live_…` project key from https://platform.zoowork.ai)
2. Start the server:
   ```bash
   ./start.sh        # starts the server and opens http://localhost:3000
   # or
   npm start
   ```

Without a key the portal runs in **demo mode** using saved sample results, so you can try the UI first.

## Credits

Each new search uses 2 Tavily credits (`SEARCH_DEPTH=advanced`), or 1 credit with `SEARCH_DEPTH=basic`. Repeat searches within `CACHE_MINUTES` (default 30) are free. The free Tavily plan includes 1,000 credits per month.

## How it works

0. Two requests run in parallel: `/api/search` (store prices) and `/api/trend` (price history), each streamed as Server-Sent Events.
1. **Tavily** searches the retailer list and returns candidate pages (2 credits).
2. **Parser** reads snippet prices so preliminary results appear within seconds.
3. **ZooWork** reuses one agent (`pricescout-price-verifier`, id cached in `.zoowork-agent.json`), opens a session per search, visits up to `ZOOWORK_MAX_PAGES` store pages and returns verified prices. If ZooWork fails or times out, the page falls back to unverified prices with a warning.
4. **Trend**: a separate ZooWork agent (`pricescout-trend-analyst`) gathers monthly typical and lowest prices for the last 6 full months, upcoming sale events and sources. `lib/trend.js` drops outliers and projects 30 days ahead: weighted 6-month trend (damped, capped at ±8 %) + expected sale events weighted by confidence, with a band from the typical monthly swing (min ±3 %). Results are cached for `TREND_CACHE_HOURS` (default 12).
5. **Verdict**: great time to buy (at/near the 6-month low), consider waiting (forecast ≥5 % lower), good price (below the 6-month average) or above the usual price.


- `server.js` serves the UI and `GET /api/search?q=...&scope=stores|web` as a Server-Sent Events stream (`step`, `preliminary`, `final`, `error`)
- `lib/pipeline.js` runs Tavily → parser → ZooWork and merges the verified prices
- `lib/zoowork.js` is the ZooWork Managed Agents client
- `lib/tavily.js` calls the Tavily Search API (restricted to the retailer list in `lib/retailers.js` for "Major US stores")
- `lib/extract.js` reads prices, was-prices, condition and the best image from each result. It skips savings, protection-plan and financing amounts, requires model numbers to match, and flags outlier or outdated prices so they don't count as the best price.
- `public/` holds the web UI

Prices come from search snippets, so they can lag behind the store. The UI tells shoppers to confirm at the store.

## Tests

```bash
npm test
```
