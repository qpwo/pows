// tsws-node-server.ts
import uWS, { WebSocket as uWebSocket } from 'uWebSockets.js';

// Message protocol
type Message =
  | { type: 'callProc'; id: number; side: 'server' | 'client'; name: string; args: any[] }
  | { type: 'returnProc'; id: number; result: any }
  | { type: 'errorProc'; id: number; error: string }
  | { type: 'startStreamer'; id: number; side: 'server' | 'client'; name: string; args: any[] }
  | { type: 'yieldStreamer'; id: number; value: any }
  | { type: 'endStreamer'; id: number }
  | { type: 'errorStreamer'; id: number; error: string };

// Type utilities to append Context to procedure and streamer signatures
type AppendContext<Fn, Context> = Fn extends (...args: infer Args) => infer Return
  ? (...args: [...Args, Context]) => Return
  : never;

type ServerProcsImpl<Procs, Context> = {
  [K in keyof Procs]: AppendContext<Procs[K], Context>;
};

type ServerStreamersImpl<Streamers, Context> = {
  [K in keyof Streamers]: AppendContext<Streamers[K], Context>;
};

// Server implementation type
interface ServerImpl<Routes, Context> {
  procs: ServerProcsImpl<Routes['server']['procs'], Context>;
  streamers: ServerStreamersImpl<Routes['server']['streamers'], Context>;
}

// Client API type for calling client procedures and streamers
type ClientProcs<Routes> = Routes['client']['procs'];
type ClientStreamers<Routes> = Routes['client']['streamers'];

class ServerConnection<Routes, Context> {
  private ws: uWebSocket;
  private ctx: Context & { client?: { procs: ClientProcs<Routes>; streamers: ClientStreamers<Routes> } };
  private serverImpl: ServerImpl<Routes, Context>;
  private idCounter = 0;
  private procedureResolvers = new Map<number, { resolve: (result: any) => void; reject: (error: string) => void }>();
  private streamerQueues = new Map<number, { queue: any[]; done: boolean }>();

  constructor(ws: uWebSocket, ctx: Context, serverImpl: ServerImpl<Routes, Context>) {
    this.ws = ws;
    this.ctx = ctx;
    this.serverImpl = serverImpl;

    // Define client API
    this.ctx.client = {
      procs: new Proxy(
        {},
        {
          get: (_, name: string) => (...args: any[]) => this.callClientProc(name, args),
        }
      ) as ClientProcs<Routes>,
      streamers: new Proxy(
        {},
        {
          get: (_, name: string) => (...args: any[]) => this.startClientStreamer(name, args),
        }
      ) as ClientStreamers<Routes>,
    };

    this.ws.subscribe('message', (message) => this.handleMessage(message));
    this.ws.subscribe('close', () => this.handleClose());
  }

  private handleMessage(message: Buffer) {
    const msg: Message = JSON.parse(message.toString());
    if (msg.type === 'callProc' && msg.side === 'server') {
      const proc = this.serverImpl.procs[msg.name as keyof Routes['server']['procs']];
      if (proc) {
        Promise.resolve(proc(...msg.args, this.ctx))
          .then((result) => this.send({ type: 'returnProc', id: msg.id, result }))
          .catch((error) => this.send({ type: 'errorProc', id: msg.id, error: (error as Error).message }));
      } else {
        this.send({ type: 'errorProc', id: msg.id, error: `Procedure '${msg.name}' not found` });
      }
    } else if (msg.type === 'startStreamer' && msg.side === 'server') {
      const streamer = this.serverImpl.streamers[msg.name as keyof Routes['server']['streamers']];
      if (streamer) {
        const generator = streamer(...msg.args, this.ctx);
        (async () => {
          try {
            for await (const value of generator) {
              this.send({ type: 'yieldStreamer', id: msg.id, value });
            }
            this.send({ type: 'endStreamer', id: msg.id });
          } catch (error) {
            this.send({ type: 'errorStreamer', id: msg.id, error: (error as Error).message });
          }
        })();
      } else {
        this.send({ type: 'errorStreamer', id: msg.id, error: `Streamer '${msg.name}' not found` });
      }
    } else if (msg.type === 'returnProc') {
      const resolver = this.procedureResolvers.get(msg.id);
      if (resolver) {
        resolver.resolve(msg.result);
        this.procedureResolvers.delete(msg.id);
      }
    } else if (msg.type === 'errorProc') {
      const resolver = this.procedureResolvers.get(msg.id);
      if (resolver) {
        resolver.reject(new Error(msg.error));
        this.procedureResolvers.delete(msg.id);
      }
    } else if (msg.type === 'yieldStreamer') {
      const queue = this.streamerQueues.get(msg.id);
      if (queue) queue.queue.push(msg.value);
    } else if (msg.type === 'endStreamer') {
      const queue = this.streamerQueues.get(msg.id);
      if (queue) queue.done = true;
    } else if (msg.type === 'errorStreamer') {
      const queue = this.streamerQueues.get(msg.id);
      if (queue) {
        queue.done = true;
        // Error handling could be improved
      }
    }
  }

  private send(message: Message) {
    this.ws.send(JSON.stringify(message));
  }

  private callClientProc(name: string, args: any[]): Promise<any> {
    const id = this.idCounter++;
    this.send({ type: 'callProc', id, side: 'client', name, args });
    return new Promise((resolve, reject) => {
      this.procedureResolvers.set(id, { resolve, reject });
    });
  }

  private startClientStreamer(name: string, args: any[]): AsyncGenerator<any, void, unknown> {
    const id = this.idCounter++;
    this.send({ type: 'startStreamer', id, side: 'client', name, args });
    const queue: any[] = [];
    let done = false;
    this.streamerQueues.set(id, { queue, done });
    return (async function* () {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift();
        } else if (done) {
          return;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10)); // Simple polling
        }
      }
    })();
  }

  private handleClose() {
    this.procedureResolvers.clear();
    this.streamerQueues.clear();
  }
}

export function makeTswsServer<Routes, Context>(
  serverImpl: ServerImpl<Routes, Context>,
  options: {
    port: number;
    middleware?: ((ctx: Context, next: () => Promise<void>) => Promise<void>)[];
  }
) {
  const app = uWS.App();

  app.ws('/*', {
    upgrade: (res, req, context) => {
      const initialCtx: any = { rawSocket: res, upgradeReq: req };
      runMiddleware(initialCtx, options.middleware || []).then((ctx) => {
        res.upgrade(
          { ctx },
          req.getHeader('sec-websocket-key'),
          req.getHeader('sec-websocket-protocol'),
          req.getHeader('sec-websocket-extensions'),
          context
        );
      });
    },
    open: (ws) => {
      const ctx = (ws as any).ctx;
      const connection = new ServerConnection<Routes, Context>(ws, ctx, serverImpl);
      (ws as any).connection = connection;
    },
    message: (ws, message, isBinary) => {
      (ws as any).connection.handleMessage(message);
    },
    close: (ws, code, message) => {
      (ws as any).connection.handleClose();
    },
  });

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        app.listen(options.port, (listenSocket) => {
          if (listenSocket) resolve();
          else reject(new Error('Failed to listen'));
        });
      }),
  };
}

async function runMiddleware<Context>(ctx: Context, middlewares: ((ctx: Context, next: () => Promise<void>) => Promise<void>)[]): Promise<void> {
  if (middlewares.length === 0) return;
  const [first, ...rest] = middlewares;
  await first(ctx, () => runMiddleware(ctx, rest));
}
