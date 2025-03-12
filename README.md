# TSWS – TypeScript WebSockets

Type-safe RPC and bidirectional streaming over WebSockets for Node.js and browsers.
Extremely fast.

## Packages

- `tsws-node`: Node.js WebSocket server and client
- `tsws-browser`: Browser WebSocket client


## Minimal example

A minimal RPC server/client setup:

```ts
// server.ts
import { startServer } from 'tsws-node';
import type { TSWS } from 'tsws-node';

type Routes = {
  server: {
    greet(name: string): Promise<string>;
  };
  client: {};
};

type Context = {
  userId: number;
};

export type Api = TSWS<Routes, Context>;

startServer<Api>({
  host: '127.0.0.1',
  port: 8080,
  routes: {
    server: {
      async greet(name, ctx) {
        return `Hello, ${name}! (User ID: ${ctx.userId})`;
      },
    },
  },
  onConnect(ctx) {
    ctx.userId = 123; // Example: setting the userId in the context
  },
});

// ----------------------------------------

// client.ts:

import { connectTo } from 'tsws-browser';
import type { Api } from './server';

const api = connectTo<Api>({
  url: 'ws://127.0.0.1:8080',
  routes: {
    client: {},
  },
});

api.server.greet('World').then(console.log); // Logs: "Hello, World! (User ID: 123)"
```

## Larger example (RPC, streams, middleware)

A server and browser client showcasing async RPC, streams, middleware, and lifecycle hooks:

```ts
// server.ts
import { startServer } from 'tsws-node';

type Routes = {
  server: {
    square(x: number): Promise<number>;
    whoami(): Promise<{ name: string; userId: number }>;
    doBigJob(): AsyncGenerator<string>;
  };
  client: {
    approve(question: string): Promise<boolean>;
  };
};

type Context = {
  userName: string;
};

export type Api = TSWS<Routes, Context>;

startServer<Api>({
  host: '127.0.0.1',
  port: 8080,
  routes: {
    server: {
      async square(x) {
        return x * x;
      },

      async whoami(params, ctx) {
        return { name: ctx.userName, userId: 456 }; // Accessing context
      },

      async *doBigJob({ client }) {
        yield 'Starting...';
        await sleep();

        const ok = await client.approve('Continue with big job?');
        if (!ok) {
          yield 'Cancelled by user.';
          return;
        }

        yield 'Working...';
        await sleep();

        yield 'Done.';
      },
    },
  },
  middleware: [
    async (ctx, next) => {
      console.log(`Connected: ${ctx.connectionId}`);
      ctx.userName = 'Alice'; // Example: setting userName in middleware
      await next();
      console.log(`Disconnected: ${ctx.connectionId}`);
    },
  ],

  onConnect(ctx) {
    console.log(`Client connected: ${ctx.connectionId}`);
    // Now you can access ctx.userName that was set in middleware
  },

  onDisconnect(ctx) {
    console.log(`Client disconnected: ${ctx.connectionId}`);
  },
});

function sleep(ms = 1000) {
  return new Promise((res) => setTimeout(res, ms));
}

// ----------------------------------------

// client.ts (browser)
import { connectTo } from 'tsws-browser';
import type { Api } from './server';

const api = connectTo<Api>({
  url: 'ws://127.0.0.1:8080',
  routes: {
    client: {
      async approve(question) {
        return confirm(question);
      },
    },
  },
});

async function run() {
  console.log('Square(5):', await api.server.square(5));
  console.log('Who am I?:', await api.server.whoami()); // Call whoami to see context in action

  for await (const update of api.server.doBigJob()) {
    console.log('Job status:', update.status);
  }
}

run().catch(console.error);