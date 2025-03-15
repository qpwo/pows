#!/usr/bin/env bash
set -exo pipefail

trash dist || true
pnpm exec tsc
node dist/little-server.js & sleep 2
node dist/little-client.js
kill $!
node dist/big-server.js & sleep 2
node dist/big-client.js
kill $!
node dist/load-server.js & sleep 2
node dist/load-client.js
kill $!

echo 'All tests passed!'
