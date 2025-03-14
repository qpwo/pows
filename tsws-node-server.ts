import uWebSockets from 'uWebSockets.js';
import { WebSocket } from 'uWebSockets.js';

type Middleware<Context> = (ctx: Context, next: () => Promise<void>) => Promise<void>;

type ServerImpl<Routes> = {
  procs: Routes['server']['procs'];
  streamers: Routes['server']['streamers'];
};

type ServerOptions<Routes, Context> = {
  port: number;
  middleware?: Middleware<Context>[];
};

export function makeTswsServer<Routes, Context = {}>(
  serverImpl: ServerImpl<Routes>,
  options: ServerOptions<Routes, Context>,
) {
  const app = uWebSockets.App();

  app.ws('/*', {
    open: (ws) => {
      const context: any = { rawSocket: ws };
      const middlewareChain = options.middleware || [];
      let middlewareIndex = 0;
      const next = async () => {
        if (middlewareIndex < middlewareChain.length) {
          const middleware = middlewareChain[middlewareIndex++];
          await middleware(context, next);
        }
      };
      next().catch((err) => {
        console.error('Middleware error:', err);
        ws.end(1006, 'Middleware error');
      });
      ws.context = context;
      (ws as any).pendingClientCalls = new Map();
      (ws as any).activeStreams = new Set();
    },
    message: (ws, message, isBinary) => {
      const data = JSON.parse(Buffer.from(message).toString());
      if (data.type === 'call') {
        const { id, path, args } = data;
        const [side, type, name] = path;
        if (side !== 'server') return;

        const handler = type === 'procs' ? serverImpl.procs[name] : serverImpl.streamers[name];
        if (!handler) {
          ws.send(JSON.stringify({ type: 'response', id, error: 'Not found' }));
          return;
        }

        const ctx = ws.context;
        const runHandler = async () => {
          try {
            if (type === 'procs') {
              const result = await handler(...args, ctx);
              ws.send(JSON.stringify({ type: 'response', id, result }));
            } else {
              const generator = handler(...args, ctx) as AsyncGenerator;
              (ws as any).activeStreams.add(id);
              for await (const value of generator) {
                ws.send(JSON.stringify({ type: 'stream', id, value, done: false }));
              }
              ws.send(JSON.stringify({ type: 'stream', id, done: true }));
              (ws as any).activeStreams.delete(id);
            }
          } catch (error) {
            ws.send(JSON.stringify({
              type: type === 'procs' ? 'response' : 'stream',
              id,
              error: error instanceof Error ? error.message : 'Unknown error',
              done: type === 'streamers',
            }));
            if (type === 'streamers') {
              (ws as any).activeStreams.delete(id);
            }
          }
        };
        runHandler();
      } else if (data.type === 'response') {
        const pending = (ws as any).pendingClientCalls.get(data.id);
        if (pending) {
          pending(data.error ? new Error(data.error) : null, data.result);
          (ws as any).pendingClientCalls.delete(data.id);
        }
      }
    },
    close: (ws) => {
      (ws as any).activeStreams.forEach((id: string) => {
        ws.send(JSON.stringify({ type: 'stream', id, error: 'Connection closed', done: true }));
      });
      (ws as any).activeStreams.clear();
    },
  });

  return {
    start: () => new Promise<void>((resolve) => {
      app.listen(options.port, (token) => {
        if (token) resolve();
        else throw new Error('Failed to start server');
      });
    }),
  };
}
