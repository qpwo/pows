#!/usr/bin/env bash
set -exo pipefail

between() {
  # trash dist || true
  # pkill -ife tsc || true
  # pkill -ife typia || true
  pkill -ife 'node dist/' || true
  # pkill -ife run.mjs || true
  # sleep 5
}

trash dist || true
pnpm exec tsc


between

node dist/little-server.js & sleep 5
node dist/little-client.js

between

node dist/big-server.js & sleep 5
node dist/big-client.js

between

node dist/load-server.js & sleep 5
node dist/load-client.js

between

echo 'All tests passed!'
