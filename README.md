# supersock - good api

Type-safe bidirectional RPC and streaming over WebSockets for Node.js and browsers.

## Packages

- `ss-node-server.ts`: Node.js uwebsockets.js-based server
- `ss-node-client.ts`: node.js ws-based client
- `ss-browser-client.ts`: Browser WebSocket client (no ws required)

## Install

```sh
# Node server:
npm i supersock uNetworking/uWebSockets.js#v20.51.0
# Node client:
npm i supersock ws @types/ws
# Browser client:
npm i supersock
# Everything:
npm i supersock ws @types/ws uNetworking/uWebSockets.js#v20.51.0
```
