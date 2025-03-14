// tsws-node-client.ts

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { TSWSDefinition } from './tsws-node-server'; // reuse the type definitions

/**
 * Options for connectTo
 */
export interface TSWSClientOptions {
  url: string;           // e.g. "ws://localhost:8080"
}

/**
 * A minimal shape for TSWS messages (same shape as on the server).
 */
interface TSWSMessage {
  reqId?: number;
  type: "proc" | "stream" | "next" | "complete" | "error" | "result" | "cancel";
  route: "server" | "client";
  name: string;
  args?: any[];
  value?: any;
  error?: string;
}

/**
 * Returns an object that has the typed API calls to `server.procs` and `server.streamers`.
 * Also, the user supplies an implementation of `client.procs` / `client.streamers` so the server
 * can call back to the client.
 */
export function connectTo<Routes extends TSWSDefinition, ClientContext = {}>(
  clientImpl: Partial<Routes["client"]["procs"]> & Partial<Routes["client"]["streamers"]>,
  options: TSWSClientOptions
) {
  // Create a WebSocket connection
  const ws = new WebSocket(options.url);

  // Keep track of requests we send to the server
  let nextRequestId = 1;
  const inflightRequests = new Map<number, {
    resolve: (val: any) => void;
    reject: (err: any) => void;
  }>();

  // Keep track of active streaming requests
  interface StreamHandler {
    pushNext: (val: any) => void;
    pushError: (err: any) => void;
    pushComplete: () => void;
  }
  const inflightStreams = new Map<number, StreamHandler>();

  // For calls from the server -> client, we also need an emitter or direct handling
  const serverToClientEmitter = new EventEmitter();

  // When we receive a message, we decode it and act accordingly
  ws.on('message', (data) => {
    let msgString: string;
    if (typeof data === 'string') {
      msgString = data;
    } else {
      // data might be Buffer or ArrayBuffer
      msgString = data.toString();
    }
    let message: TSWSMessage;
    try {
      message = JSON.parse(msgString);
    } catch (err) {
      console.error("Invalid JSON from server:", err);
      return;
    }

    handleServerMessage(message);
  });

  /**
   * Handle messages initiated by the server:
   * - server calling client procs or streamers
   * - responses to client calls
   */
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

  /**
   * Send a normal (proc) request to the server
   */
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

  /**
   * Send a streaming request to the server, returning an async iterator.
   */
  function callServerStream(name: string, args: any[]): AsyncGenerator<any, void, unknown> {
    const reqId = nextRequestId++;

    // We will create an async generator that yields incoming "next" values
    // until we get "complete" or an error.
    let pullQueue: ((val: IteratorResult<any>) => void)[] = [];
    let pushQueue: any[] = [];
    let isDone = false;
    let errorSignal: any = null;

    // create push methods
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
      // flush any waiting pulls
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

    // Send request
    ws.send(JSON.stringify({
      reqId,
      type: 'stream',
      route: 'server',
      name,
      args,
    }));

    // Return the async generator
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
        // optional: let server know we are cancelling?
        return Promise.reject(e);
      },
      return(): Promise<IteratorResult<any>> {
        // optional: send a cancel message
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

  /**
   * Send a "result" message (server called client, and we are replying).
   */
  function sendResult(reqId: number, value: any) {
    ws.send(JSON.stringify({
      reqId,
      type: "result",
      value,
    }));
  }

  /**
   * Send an "error" message.
   */
  function sendError(reqId: number, error: string) {
    ws.send(JSON.stringify({
      reqId,
      type: "error",
      error,
    }));
  }

  /**
   * Streams from client side (server calls a client streamer).
   */
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

  // Build the final returned API
  const api = {
    server: {
      procs: {} as Routes["server"]["procs"],
      streamers: {} as Routes["server"]["streamers"],
    },
  };

  // Populate the methods in `server.procs`
  // We rely on the TypeScript signature from user’s `Routes`.
  // Implementation: just calls `callServerProc(name, args)`.
  api.server.procs = new Proxy({}, {
    get(_target, prop: string) {
      return (...args: any[]) => {
        return callServerProc(prop, args);
      };
    }
  }) as Routes["server"]["procs"];

  // Populate the methods in `server.streamers`
  // Implementation: `callServerStream(name, args)`.
  api.server.streamers = new Proxy({}, {
    get(_target, prop: string) {
      return (...args: any[]) => {
        return callServerStream(prop, args);
      };
    }
  }) as Routes["server"]["streamers"];

  return api;
}
