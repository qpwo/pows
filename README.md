# TSWS – TypeScript WebSockets

Type-safe bidirectional RPC and streaming over WebSockets for Node.js and browsers.
Powered by uWebSocket.js.

## Packages

- `@tsws/node`: Node.js WebSocket server and client
- `@tsws/browser`: Browser WebSocket client

## Features

- Type-safe API: Full TypeScript support with interfaces for defining routes
- Bidirectional RPC: Both server and client can call procedures on each other
- Streaming support: Stream data with AsyncGenerators
- Context and middleware: Add custom context and middleware to handle authentication, etc.

## Installation

```bash
# Server (Node.js)
pnpm install @tsws/node

# Browser client
pnpm install @tsws/browser
```

## Minimal Example

```ts
// server.ts
import { startServer } from '@tsws/node';

interface Routes {
  server: {
    procs: {
      uppercase(s: string): string;
    };
    streamers: {};
  };
  client: {
    procs: {};
    streamers: {};
  };
};

startServer<Routes>({
  uppercase(s) {
    return s.toUpperCase();
  },
});

// ----------------------------------------

// client.ts:

import { connectTo } from '@tsws/browser';
import type { Routes } from './server';

const api = connectTo<Routes>();

async function main() {
  const upper = await api.server.procs.uppercase('foo');
  console.log(upper);
}

main();
```

## Larger Example (RPC, streams, middleware)

A server with a browser client showcasing async RPC, streams, middleware, and lifecycle hooks:

```ts
// server.ts
import { startServer } from '@tsws/node';
import type uWebSocket from 'uwebsockets.js';


interface Routes {
  server: {
    procs: {
      square(x: number): Promise<number>;
      whoami(): Promise<{ name: string; userId: number | null }>;
    };
    streamers: {
      doBigJob(): AsyncGenerator<string, void, unknown>;
    };
  };
  client: {
    procs: {
      approve(question: string): Promise<boolean>;
    };
    streamers: {};
  };
}

type ServerContext = {
  userName: string;
  userId: number | null;
  uws: uWebSocket;
};



var api = startServer<Routes, ServerContext>({
  square: async (x) => {
    return x * x;
  },

  whoami: async (params, ctx) => {
    return { name: ctx.userName, userId: ctx.userId };
  },

  doBigJob: async function*() {
    yield 'Starting...';
    await sleep();

    const ok = await api.client.procs.approve('Continue with big job?');
    if (!ok) {
      yield 'Cancelled by user.';
      return;
    }

    yield 'Working...';
    await sleep();

    yield 'Done.';
  },
}, {
  middleware: [
    async (ctx, next) => {
      ctx.uws = ctx.rawSocket as uWebSocket;
      const req = ctx.uws.upgradeReq; // Use uWebSocket's request object directly
      // Note: In a real application, use a robust cookie parsing library.
      const userId = req.headers.cookie?.match(/userId=(\d+)/)?.[1];
      ctx.userId = userId ? parseInt(userId, 10) : null;
      ctx.userName = 'Alice';
      await next();
    },
  ],
});

function sleep(ms = 1000) {
  return new Promise((res) => setTimeout(res, ms));
}



// ----------------------------------------

// client.ts (browser)
import { connectTo } from '@tsws/browser';
import type { Routes } from './server';

const api = connectTo<Routes, {}>({
  approve: async (question) => {
    return confirm(question);
  },
}, {
  url: 'ws://localhost:8080',
});

async function run() {
  console.log('Square(5):', await api.server.procs.square(5));
  console.log('Who am I?:', await api.server.procs.whoami());

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update);
  }

  const approved = await api.client.procs.confirm('Nothing wrong with self-calls!')
}

run()
```

## API Reference

### Server API

#### startServer

```ts
function startServer<Routes, Context>(
  handlers: ServerHandlers<Routes, Context>,
  config?: ServerConfig<Context>
): ServerImplementation<Routes, Context>;
```

##### Parameters:

- `handlers`: An object containing handler functions for procedures and streamers
- `config`: Optional configuration object with the following properties:
  - `middleware`: Array of middleware functions
  - `port`: Server port (default: 8080)
  - `host`: Server host (default: 'localhost')

### Client API

#### connectTo

```ts
function connectTo<Routes, Context>(
  handlers?: ClientProcedureHandlers<Routes, Context>,
  config?: ClientConfig
): BrowserClient<Routes, Context>;
```

##### Parameters:

- `handlers`: An object containing handler functions for client procedures
- `config`: Optional configuration object with the following properties:
  - `url`: WebSocket server URL (default: 'ws://localhost:8080')
  - `middleware`: Array of middleware functions
  - `reconnect`: Whether to automatically reconnect (default: true)
  - `reconnectDelay`: Base delay in milliseconds between reconnect attempts (default: 1000)
  - `maxReconnectAttempts`: Maximum number of reconnect attempts (default: 10)

## Development

### Building the packages

```bash
pnpm run build
```

### Running tests

```bash
pnpm test
```

### Running examples

```bash
# Basic example
pnpm run example:basic:server
pnpm run example:basic:client

# Advanced example
pnpm run example:advanced:server
pnpm run example:advanced:client
```

## License

MIT
