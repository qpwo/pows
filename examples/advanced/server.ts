import { startServer } from '../../packages/node/src';
import type { WebSocket as uWebSocket } from 'uWebSockets.js';

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
  };
}

export type ServerContext = {
  userName: string;
  userId: number | null;
  uws: uWebSocket;
  rawSocket: any;
  clientId: string;
};

var api = startServer<Routes, ServerContext>({
  square: async (x, ctx) => {
    return x * x;
  },

  whoami: async (params, ctx) => {
    return { name: ctx.userName, userId: ctx.userId };
  },

  doBigJob: async function*(params, ctx) {
    yield 'Starting...';
    await sleep();

    // Find the client object by ID
    const clientId = ctx.clientId;
    const ok = await api.client.procs.approve('Continue with big job?', ctx.clientId);
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
      const userId = req.headers.cookie?.match(/userId=(\\d+)/)?.[1];
      ctx.userId = userId ? parseInt(userId, 10) : null;
      ctx.userName = 'Alice';
      await next();
    },
  ],
});

function sleep(ms = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log('Server started on ws://localhost:8080');