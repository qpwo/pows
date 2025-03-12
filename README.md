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
import { createServer } from 'tsws-node';
import type { TSWS } from 'tsws-node';

export type Api = TSWS<{
  greet(name: string): Promise<string>;
}>;

createServer<Api>({
  host: '127.0.0.1',
  port: 8080,
  async greet(name) {
    return `Hello, ${name}!`;
  },
});

// ----------------------------------------

// client.ts:

import { connect } from 'tsws-browser';
import type { Api } from './server';

const api = connect<Api>({ url: 'ws://127.0.0.1:8080' });

api.greet('World').then(console.log); // Logs: "Hello, World!"
```

## Larger example (RPC, streams, middleware)

A server and browser client showcasing async RPC, streams, middleware, and lifecycle hooks:

```ts
// server.ts
import { createServer, ClientMethod } from 'tsws-node';

export type Api = TSWS<{
  square(x: number): Promise<number>;
  whoami(): Promise<{ name: string }>;
  doBigJob(): AsyncGenerator<{ status: string }>;

  approve: ClientMethod<(question: string) => Promise<boolean>>;
}>;

createServer<Api>({
  host: '127.0.0.1',
  port: 8080,

  async square(x) {
    return x * x;
  },

  async whoami() {
    return { name: 'TSWS Server' };
  },

  async *doBigJob({ client }) {
    yield { status: 'Starting...' };
    await sleep();

    const ok = await client.approve('Continue with big job?');
    if (!ok) {
      yield { status: 'Cancelled by user.' };
      return;
    }

    yield { status: 'Working...' };
    await sleep();

    yield { status: 'Done.' };
  },

  middleware: [
    async (ctx, next) => {
      console.log(`Connected: ${ctx.connectionId}`);
      await next();
      console.log(`Disconnected: ${ctx.connectionId}`);
    },
  ],

  onConnect(ctx) {
    console.log(`Client connected: ${ctx.connectionId}`);
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
import { connect } from 'tsws-browser';
import type { Api } from './server';

const api = connect<Api>({
  url: 'ws://127.0.0.1:8080',

  approve: async (question) => confirm(question),
});

async function run() {
  console.log('Square(5):', await api.square(5));

  for await (const update of api.doBigJob()) {
    console.log('Job status:', update.status);
  }
}

run().catch(console.error);
```
