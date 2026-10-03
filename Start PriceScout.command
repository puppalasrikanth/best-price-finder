#!/bin/bash
# Double-click to start PriceScout (opens http://localhost:3000)
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin:$PATH"
exec ./start.sh
