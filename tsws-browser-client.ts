// tsws-browser-client.ts

import { TSWSDefinition } from './tsws-node-server'; // reuse the type definitions

interface TSWSMessage {
  reqId?: number;
  type: "proc" | "stream" | "next" | "complete" | "error" | "result" | "cancel";
  route: "server" | "client";
  name: string;
  args?: any[];
  value?: any;
  error?: string;
}

export interface TSWSBrowserClientOptions {
  url: string; // e.g. "ws://localhost:8080"
}

/**
 * This is almost identical to the node client, just using the browser's WebSocket.
 */
export function connectToBrowser<Routes extends TSWSDefinition>(
  clientImpl: Partial<Routes["client"]["procs"]> & Partial<Routes["client"]["streamers"]>,
  options: TSWSBrowserClientOptions
) {
  const ws = new WebSocket(options.url);

  // same approach: track inflight requests
  let nextRequestId = 1;
  const inflightRequests = new Map<number, {
    resolve: (val: any) => void;
    reject: (err: any) => void;
  }>();

  interface StreamHandler {
    pushNext: (val: any) => void;
    pushError: (err: any) => void;
    pushComplete: () => void;
  }
  const inflightStreams = new Map<number, StreamHandler>();

  ws.onmessage = (event) => {
    let msgString = event.data;
    if (typeof msgString !== 'string') {
      // in browsers, it's typically string already, but let's just ensure
      msgString = String(msgString);
    }
    let message: TSWSMessage;
    try {
      message = JSON.parse(msgString);
    } catch (err) {
      console.error("Invalid JSON from server:", err);
      return;
    }
    handleServerMessage(message);
  };

  function handleServerMessage(msg: TSWSMessage) {
    const { reqId, type, name, args, route, value, error } = msg;
    if (type === "result" || type === "error" || type === "next" || type === "complete") {
      // It's a response to a client->server call
      const inflight = inflightRequests.get(reqId!);
      const inflightStream = inflightStreams.get(reqId!);
      switch (type) {
        case "result":
          if (inflight) {
            inflight.resolve(value);
            inflightRequests.delete(reqId!);
          }
          break;
        case "error":
          if (inflight) {
            inflight.reject(new Error(error || 'Unknown error'));
            inflightRequests.delete(reqId!);
          }
          break;
        case "next":
          if (inflightStream) {
            inflightStream.pushNext(value);
          }
          break;
        case "complete":
          if (inflightStream) {
            inflightStream.pushComplete();
            inflightStreams.delete(reqId!);
          }
          break;
      }
      return;
    }

    if (type === "proc" || type === "stream") {
      // The server is calling a client procedure or streaming function
      if (route !== "client") {
        // Not for us?
        return;
      }
      const impl = (clientImpl as any)[name];
      if (typeof impl !== 'function') {
        // No such method
        sendError(reqId!, `Client function '${name}' not implemented`);
        return;
      }
      if (type === 'proc') {
        // handle normal procedure
        Promise.resolve()
          .then(() => impl(...(args || [])))
          .then((result: any) => {
            sendResult(reqId!, result);
          })
          .catch((err: any) => {
            sendError(reqId!, err?.message ?? String(err));
          });
      } else {
        // handle streaming
        let generator: AsyncGenerator<any, void, unknown>;
        try {
          generator = impl(...(args || []));
        } catch (err: any) {
          sendError(reqId!, err?.message ?? String(err));
          return;
        }
        pumpStream(reqId!, generator);
      }
    }
  }

  function callServerProc(name: string, args: any[]): Promise<any> {
    const reqId = nextRequestId++;
    return new Promise((resolve, reject) => {
      inflightRequests.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({
        reqId,
        type: 'proc',
        route: 'server',
        name,
        args,
      }));
    });
  }

  function callServerStream(name: string, args: any[]): AsyncGenerator<any, void, unknown> {
    const reqId = nextRequestId++;

    let pullQueue: ((val: IteratorResult<any>) => void)[] = [];
    let pushQueue: any[] = [];
    let isDone = false;
    let errorSignal: any = null;

    function pushNext(val: any) {
      if (isDone) return;
      if (pullQueue.length > 0) {
        const resolve = pullQueue.shift()!;
        resolve({ value: val, done: false });
      } else {
        pushQueue.push(val);
      }
    }
    function pushComplete() {
      isDone = true;
      while (pullQueue.length > 0) {
        const resolve = pullQueue.shift()!;
        resolve({ value: undefined, done: true });
      }
    }
    function pushError(err: any) {
      if (isDone) return;
      isDone = true;
      errorSignal = err;
      while (pullQueue.length > 0) {
        const reject = pullQueue.shift() as unknown as (val: any) => void;
        reject(err);
      }
    }

    inflightStreams.set(reqId, { pushNext, pushError, pushComplete });

    ws.send(JSON.stringify({
      reqId,
      type: 'stream',
      route: 'server',
      name,
      args,
    }));

    return {
      next(): Promise<IteratorResult<any>> {
        if (errorSignal) {
          return Promise.reject(errorSignal);
        }
        if (pushQueue.length > 0) {
          const val = pushQueue.shift();
          return Promise.resolve({ value: val, done: false });
        }
        if (isDone) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<any>>((resolve, reject) => {
          pullQueue.push((res) => {
            if (errorSignal) {
              reject(errorSignal);
            } else {
              resolve(res);
            }
          });
        });
      },
      throw(e: any): Promise<IteratorResult<any>> {
        return Promise.reject(e);
      },
      return(): Promise<IteratorResult<any>> {
        ws.send(JSON.stringify({
          reqId,
          type: 'cancel',
        }));
        isDone = true;
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }

  function sendResult(reqId: number, value: any) {
    ws.send(JSON.stringify({
      reqId,
      type: "result",
      value,
    }));
  }

  function sendError(reqId: number, error: string) {
    ws.send(JSON.stringify({
      reqId,
      type: "error",
      error,
    }));
  }

  async function pumpStream(reqId: number, generator: AsyncGenerator<any, void, unknown>) {
    try {
      while (true) {
        const { value, done } = await generator.next();
        if (done) {
          ws.send(JSON.stringify({ reqId, type: 'complete' }));
          break;
        }
        ws.send(JSON.stringify({ reqId, type: 'next', value }));
      }
    } catch (err: any) {
      sendError(reqId, err?.message ?? String(err));
    }
  }

  const api = {
    server: {
      procs: {} as Routes["server"]["procs"],
      streamers: {} as Routes["server"]["streamers"],
    },
  };

  api.server.procs = new Proxy({}, {
    get(_target, prop: string) {
      return (...args: any[]) => {
        return callServerProc(prop, args);
      };
    }
  }) as Routes["server"]["procs"];

  api.server.streamers = new Proxy({}, {
    get(_target, prop: string) {
      return (...args: any[]) => {
        return callServerStream(prop, args);
      };
    }
  }) as Routes["server"]["streamers"];

  return api;
}
