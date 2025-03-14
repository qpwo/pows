# TSWS – TypeScript WebSockets

Type-safe bidirectional RPC and streaming over WebSockets for Node.js and browsers.

## Packages

- `tsws-node-server.ts`: Node.js uwebsockets.js-based server
- `tsws-node-client.ts`: node.js ws-based client
- `tsws-browser-client.ts`: Browser WebSocket client

## Minimal Example

```ts
// example-little-server.ts
import { startServer } from './tsws-node-server';

export interface Routes {
  server: {
    procs: {
      uppercase(s: string): string;
    };
    streamers: {}
  };
  client: {
    procs: {}
    streamers: {}
  }
};

startServer<Routes>({
  uppercase(s) {
    return s.toUpperCase();
  },
});

// ----------------------------------------

// example-little-client.ts:

import { connectTo } from './tsws-node-client';
import type { Routes } from './example-little-server';

const api = connectTo<Routes>({},{});

async function main() {
  const upper = await api.server.procs.uppercase('foo');
  console.log(upper);
}

main();
```

## Larger Example (RPC, streams, middleware)

```ts
// example-big-server.ts
import { startServer } from './tsws-node-server';
import type uWebSocket from 'uwebsockets.js';


export interface Routes {
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
    streamers: {}
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

// example-big-client.ts
import { connectTo } from './tsws-node-client';
import type { Routes } from './example-big-server';

const api = connectTo<Routes, {}>({
  approve: async (question) => {
    return confirm(question);
  },
}, {
  url: 'ws://localhost:8080',
});

async function main() {
  console.log('Square(5):', await api.server.procs.square(5));
  console.log('Who am I?:', await api.server.procs.whoami());

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update);
  }
}

main()
```
