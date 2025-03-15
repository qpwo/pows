#!/usr/bin/env bash
set -euo pipefail

# Remove all generated files and node_modules
rm -rf pows/node_modules examples/node_modules
find pows -name "*.js" -type f -delete
find pows -name "*.js.map" -type f -delete
find pows -name "*.d.ts" -type f -delete
find pows -name "*.d.ts.map" -type f -delete
rm -rf examples/dist

# Build pows library
echo "📦 Building pows library..."
cd pows
npm install
npm run build

# Build examples
echo "🧪 Building examples..."
cd ../examples
npm install
npm run build
