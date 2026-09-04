#!/usr/bin/env bash
# One-step local launcher for the LLM Brand Recommendation Experiment.
set -euo pipefail
cd "$(dirname "$0")"

echo "== LLM Brand Monitor: local quick start =="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 LTS and try again."
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required (found $(node -v))."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies for the first run..."
  npm ci
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. API keys are only needed for live runs."
fi

echo "Starting the local server at http://localhost:3000 ..."
npm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

URL="http://localhost:3000/analysis.html"
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:3000"; then
    break
  fi
  sleep 0.5
done

if command -v open >/dev/null 2>&1; then
  open "$URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"
else
  echo "Open this URL in your browser: $URL"
fi

echo "Server is running. Press Ctrl+C to stop."
wait "$SERVER_PID"
