#!/usr/bin/env bash
# Start PriceScout and open it in your browser.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install it with:  brew install node   (or from https://nodejs.org)"
  exit 1
fi
# Install the Moss SDK (persistence layer) on first run or after an update.
if [ ! -d node_modules/@moss-dev/moss ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies (Moss SDK)…"
  npm install --no-audit --no-fund || echo "npm install failed — PriceScout will run with in-memory caching only."
fi
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)}"; PORT="${PORT:-3000}"
# Restart cleanly: stop a PriceScout that is already running on this port.
for pid in $(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null); do
  if ps -p "$pid" -o command= | grep -q "node server.js"; then
    echo "Stopping the PriceScout that was already running (pid $pid)…"
    kill "$pid"; sleep 1
  fi
done
( sleep 1.5; open "http://localhost:$PORT" 2>/dev/null || xdg-open "http://localhost:$PORT" 2>/dev/null ) &
exec node server.js
