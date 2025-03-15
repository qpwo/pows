#!/usr/bin/env bash
set -exuo pipefail

gr=$(git rev-parse --show-toplevel)
cd "$gr"
# Remove all generated files and node_modules
rm -rf pows/node_modules examples/node_modules
find pows -name "*.js" -type f -delete
find pows -name "*.js.map" -type f -delete
find pows -name "*.d.ts" -type f -delete
find pows -name "*.d.ts.map" -type f -delete
rm -rf examples/dist

# Build pows library
echo "Building pows library..."
cd "$gr/pows"
pnpm install
pnpm run build

# Build examples
echo "Building examples..."
cd "$gr/examples"
pnpm install
ls dist || true
pnpm run build
ls dist || true

# Run tests
echo "Running tests..."
cd "$gr/examples"
bash run-all.sh
