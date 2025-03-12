# TSWS – TypeScript WebSockets

Type-safe bidirectional RPC and streaming over WebSockets for Node.js and browsers.
Powered by uWebSocket.js.

## Packages

- `@tsws/node`: Node.js WebSocket server and client
- `@tsws/browser`: Browser WebSocket client

## Minimal Example

```ts
// server.ts
import { startServer } from '@tsws/node';

interface Routes {
  server: {
    procs: {
      uppercase(s: string): string;
    };
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
