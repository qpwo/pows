#!/usr/bin/env bash
set -exo pipefail

pkill -ife little-server.ts || true
pkill -ife big-server.ts || true
pkill -ife load-server.ts || true

./run.mjs little-server.ts & sleep 1
./run.mjs little-client.ts
pkill -ife little-server.ts

./run.mjs big-server.ts & sleep 1
./run.mjs big-client.ts
pkill -ife big-server.ts

./run.mjs load-server.ts & sleep 1
./run.mjs load-client.ts
pkill -ife load-server.ts
