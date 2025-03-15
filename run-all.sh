#!/usr/bin/env bash
set -exo pipefail

between() {
  # trash dist || true
  # pkill -ife tsc || true
  # pkill -ife typia || true
  pkill -ife example- || true
  # pkill -ife build.mjs || true
  # sleep 5
}

trash dist || true
pnpm exec tsc


between

node dist/example-little-server.js & sleep 5
node dist/example-little-client.js

between

node dist/example-big-server.js & sleep 5
node dist/example-big-client.js

between

node dist/example-load-server.js & sleep 5
node dist/example-load-client.js

between

echo 'All tests passed!'
