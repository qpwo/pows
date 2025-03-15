
cd $(git rev-parse --show-toplevel)/pows

mkdir -p browser-client node-client node-server

echo "export * from '../dist/browser-client.js';" | tee browser-client/index.js
echo "export * from '../dist/node-client.js';" | tee node-client/index.js
echo "export * from '../dist/node-server.js';" | tee node-server/index.js

# Create matching index.d.ts files for TypeScript
echo "export * from '../dist/browser-client';" | tee browser-client/index.d.ts
echo "export * from '../dist/node-client';" | tee node-client/index.d.ts
echo "export * from '../dist/node-server';" | tee node-server/index.d.ts
