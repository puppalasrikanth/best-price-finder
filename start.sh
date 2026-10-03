#!/usr/bin/env bash
# Start PriceScout and open it in your browser.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required. Install it with:  brew install node   (or from https://nodejs.org)"
  exit 1
fi
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)}"; PORT="${PORT:-3000}"
( sleep 1; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
exec node server.js
