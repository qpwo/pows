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
