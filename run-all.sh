#!/usr/bin/env bash
set -exo pipefail

./build.mjs example-little-server.ts & sleep 2
./build.mjs example-little-client.ts
kill $!
./build.mjs example-big-server.ts & sleep 2
./build.mjs example-big-client.ts
kill $!
./build.mjs example-load-server.ts & sleep 2
./build.mjs example-load-client.ts
kill $!

echo 'All tests passed!'
