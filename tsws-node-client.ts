// tsws-node-client.ts
import WebSocket from 'ws';

// Message protocol (same as server)
type Message =
  | { type: 'callProc'; id: number; side: 'server' | 'client'; name: string; args: any[] }
  | { type: 'returnProc'; id: number; result: any }
  | { type: 'errorProc'; id: number; error: string }
  | { type: 'startStreamer'; id: number; side: 'server' | 'client'; name: string; args: any[] }
  | { type: 'yieldStreamer'; id: number; value: any }
  | { type: 'endStreamer'; id: number }
  | { type: 'errorStreamer'; id: number; error: string };

// Type utilities
type AppendContext<Fn, Context> = Fn extends (...args: infer Args) => infer Return
  ? (...args: [...Args, Context]) => Return
  : never;

type ClientProcsImpl<Procs, Context> = {
  [K in keyof Procs]: AppendContext<Procs[K], Context>;
};

type ClientStreamersImpl<Streamers, Context> = {
  [K in keyof Streamers]: AppendContext<Streamers[K], Context>;
};

// Client implementation type
interface ClientImpl<Routes, Context> {
  procs: ClientProcsImpl<Routes['client']['procs'], Context>;
  streamers: ClientStreamersImpl<Routes['client']['streamers'], Context>;
}

// Server API type
type ServerProcs<Routes> = Routes['server']['procs'];
type ServerStreamers<Routes> = Routes['server']['streamers'];

class ClientConnection<Routes, Context> {
  private ws: WebSocket;
  private clientImpl: ClientImpl<Routes, Context>;
  private idCounter = 0;
  private procedureResolvers = new Map<number, { resolve: (result: any) => void; reject: (error: string) => void }>();
  private streamerQueues = new Map<number, { queue: any[]; done: boolean }>();

  constructor(ws: WebSocket, clientImpl: ClientImpl<Routes, Context>) {
    this.ws = ws;
    this.clientImpl = clientImpl;

    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', () => this.handleClose());
  }

  private handleMessage(data: WebSocket.Data) {
    const msg: Message = JSON.parse(data.toString());
    if (msg.type === 'callProc' && msg.side === 'client') {
      const proc = this.clientImpl.procs[msg.name as keyof Routes['client']['procs']];
      if (proc) {
        Promise.resolve(proc(...msg.args, {} as Context))
          .then((result) => this.send({ type: 'returnProc', id: msg.id, result }))
          .catch((error) => this.send({ type: 'errorProc', id: msg.id, error: (error as Error).message }));
      } else {
        this.send({ type: 'errorProc', id: msg.id, error: `Procedure '${msg.name}' not found` });
      }
    } else if (msg.type === 'startStreamer' && msg.side === 'client') {
      const streamer = this.clientImpl.streamers[msg.name as keyof Routes['client']['streamers']];
      if (streamer) {
        const generator = streamer(...msg.args, {} as Context);
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
      if (queue) queue.done = true;
    }
  }

  private send(message: Message) {
    this.ws.send(JSON.stringify(message));
  }

  callServerProc(name: string, args: any[]): Promise<any> {
    const id = this.idCounter++;
    this.send({ type: 'callProc', id, side: 'server', name, args });
    return new Promise((resolve, reject) => {
      this.procedureResolvers.set(id, { resolve, reject });
    });
  }

  startServerStreamer(name: string, args: any[]): AsyncGenerator<any, void, unknown> {
    const id = this.idCounter++;
    this.send({ type: 'startStreamer', id, side: 'server', name, args });
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
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    })();
  }

  private handleClose() {
    this.procedureResolvers.clear();
    this.streamerQueues.clear();
  }
}

export function makeTswsClient<Routes, Context>(
  clientImpl: ClientImpl<Routes, Context>,
  options: { url: string }
) {
  const ws = new WebSocket(options.url);
  const connection = new ClientConnection<Routes, Context>(ws, clientImpl);

  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', (error) => reject(error));
      }),
    server: {
      procs: new Proxy(
        {},
        {
          get: (_, name: string) => (...args: any[]) => connection.callServerProc(name, args),
        }
      ) as ServerProcs<Routes>,
      streamers: new Proxy(
        {},
        {
          get: (_, name: string) => (...args: any[]) => connection.startServerStreamer(name, args),
        }
      ) as ServerStreamers<Routes>,
    },
  };
}
