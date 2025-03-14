import WebSocket from 'ws';

type ClientImpl<Routes> = {
  procs: Routes['client']['procs'];
};

type ClientOptions = {
  url: string;
};

export function makeTswsClient<Routes, Context = {}>(
  clientImpl: ClientImpl<Routes>,
  options: ClientOptions,
) {
  const ws = new WebSocket(options.url);
  const pendingCalls = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const pendingStreams = new Map<string, any>();

  function createAsyncGenerator() {
    const queue: any[] = [];
    let pendingResolve: ((v: any) => void) | null = null;
    let pendingReject: ((e: Error) => void) | null = null;
    let done = false;

    return {
      pushValue(value: any) {
        if (pendingResolve) {
          pendingResolve({ value, done: false });
          pendingResolve = null;
          pendingReject = null;
        } else queue.push({ value });
      },
      pushError(error: Error) {
        if (pendingReject) {
          pendingReject(error);
          pendingResolve = null;
          pendingReject = null;
        } else queue.push({ error });
      },
      complete() {
        done = true;
        if (pendingResolve) pendingResolve({ value: undefined, done: true });
      },
      async next() {
        if (queue.length > 0) {
          const item = queue.shift();
          if ('error' in item) throw item.error;
          return { value: item.value, done: false };
        } else if (done) return { value: undefined, done: true };
        else return new Promise((resolve, reject) => {
          pendingResolve = (v) => resolve(v);
          pendingReject = (e) => reject(e);
        });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    switch (message.type) {
      case 'response': {
        const pending = pendingCalls.get(message.id);
        if (pending) {
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result);
          pendingCalls.delete(message.id);
        }
        break;
      }
      case 'call': {
        const { id, path, args } = message;
        const [side, type, name] = path;
        if (side === 'client' && type === 'procs') {
          const proc = (clientImpl.procs as any)[name];
          if (proc) {
            Promise.resolve(proc(...args))
              .then((result) => ws.send(JSON.stringify({ type: 'response', id, result })))
              .catch((error) => ws.send(JSON.stringify({ type: 'response', id, error: error.message })));
          } else {
            ws.send(JSON.stringify({ type: 'response', id, error: 'Not found' }));
          }
        }
        break;
      }
      case 'stream': {
        const stream = pendingStreams.get(message.id);
        if (stream) {
          if (message.error) stream.pushError(new Error(message.error));
          else if (message.done) stream.complete();
          else stream.pushValue(message.value);
        }
        break;
      }
    }
  });

  const client = {
    server: {
      procs: new Proxy({}, {
        get: (_, prop: string) => (...args: any[]) => {
          const id = generateId();
          ws.send(JSON.stringify({ type: 'call', id, path: ['server', 'procs', prop], args }));
          return new Promise((resolve, reject) => pendingCalls.set(id, { resolve, reject }));
        },
      }),
      streamers: new Proxy({}, {
        get: (_, prop: string) => (...args: any[]) => {
          const id = generateId();
          ws.send(JSON.stringify({ type: 'call', id, path: ['server', 'streamers', prop], args }));
          const generator = createAsyncGenerator();
          pendingStreams.set(id, generator);
          return generator;
        },
      }),
    },
    connect: () => new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
      if (ws.readyState === WebSocket.OPEN) resolve();
    }),
  };

  return client;
}

function generateId() {
  return Math.random().toString(36).substring(2, 15);
}
