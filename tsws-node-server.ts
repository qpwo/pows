// tsws-node-server.ts

import uWS, { WebSocket, TemplatedApp } from 'uWebSockets.js';

/**
 * The shape of the TSWS definition:
 * - server and client each declare "procs" (regular async functions) and "streamers" (async generators).
 */
export interface TSWSDefinition {
  server: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
  };
  client: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
  };
}

/**
 * Middleware signature: each middleware receives the context and a `next` function.
 * The context typically carries user info, or any other request-specific data you want.
 */
export type Middleware<Context> = (ctx: ServerContext<Context>, next: () => Promise<void>) => Promise<void>;

/**
 * Server context includes everything needed while handling a request.
 * You can store your raw socket, user info, etc. in here.
 */
export interface ServerContext<Context> {
  rawSocket: WebSocket;     // uWebSockets WebSocket
  connectionId: number;     // Unique ID for the connection
  server: TSWSInternalServer; // Reference to the internal server object (for calling client procs)
  extra: Context;           // Additional user-defined context
}

/**
 * Options for startServer
 */
export interface StartServerOptions<Routes extends TSWSDefinition, Context> {
  /**
   * Port for the WebSocket server
   */
  port?: number;
  /**
   * Middleware array
   */
  middleware?: Middleware<Context>[];
  /**
   * Called after the server starts
   */
  onStarted?: (app: TemplatedApp) => void;
}

/**
 * The server implementation. We'll store the methods for "server.procs" and "server.streamers".
 */
export type ServerImplementation<Routes extends TSWSDefinition, Context> = {
  [K in keyof Routes["server"]["procs"]]: (
    args: Parameters<Routes["server"]["procs"][K]>,
    ctx: ServerContext<Context>
  ) => Promise<ReturnType<Routes["server"]["procs"][K]>> | ReturnType<Routes["server"]["procs"][K]>;
} &
{
  [K in keyof Routes["server"]["streamers"]]: (
    args: Parameters<Routes["server"]["streamers"][K]>,
    ctx: ServerContext<Context>
  ) => ReturnType<Routes["server"]["streamers"][K]>;
};

/**
 * For replying to streaming requests, we store each generator in a map
 * so that we can send the `next()` results over time.
 */
interface ActiveStream {
  generator: AsyncGenerator<any, void, unknown>;
  context: ServerContext<any>;
}

/**
 * A minimal shape for TSWS messages.
 */
interface TSWSMessage {
  reqId?: number; // used to track request-response
  type: "proc" | "stream" | "next" | "complete" | "error" | "result" | "cancel";
  route: "server" | "client";
  name: string;
  args?: any[];
  value?: any;    // For results or stream `next` values
  error?: string; // For error messages
}

/**
 * Internal server object. We'll keep track of connections, streaming, etc.
 */
interface TSWSInternalServer {
  connections: Map<number, {
    ws: WebSocket;
    activeStreams: Map<number, ActiveStream>;
    nextClientReqId: number;
    inflightClientRequests: Map<number, (value: any) => void>;
    inflightClientRequestsReject: Map<number, (err: any) => void>;
  }>;
  nextConnectionId: number;
}

/**
 * The object returned by startServer. It allows the server code
 * to call `api.client.procs.whatever()` from the server side
 * (for a particular connection).
 */
export interface TSWSConnectionAPI<Routes extends TSWSDefinition> {
  /**
   * `client.procs` is for calling the connected client's RPC methods
   */
  client: {
    procs: Routes["client"]["procs"];
    streamers: Routes["client"]["streamers"];
  };
}

/**
 * The main function to start the server.
 *
 * @param serverImpl the implementation of the server's procs and streamers
 * @param options options including port, middleware, etc.
 * @returns a utility for shutting down or referencing the server
 */
export function startServer<
  Routes extends TSWSDefinition,
  Context = {}
>(
  serverImpl: Partial<ServerImplementation<Routes, Context>>,
  options: StartServerOptions<Routes, Context> = {}
) {

  const port = options.port ?? 8080;

  // Wrap the user server implementation so that even if a method isn't provided,
  // we have a default "not implemented" fallback.
  const serverProcs: Required<ServerImplementation<Routes, Context>>["server"] = {} as any;
  const serverStreamers: Required<ServerImplementation<Routes, Context>>["server"] = {} as any;

  // Fill in the `serverImpl` with no-ops for missing keys (so we don't crash).
  // But we can simply store them as they come in, if needed.

  // For type-safety, we do a small fallback approach:
  const sProcs: Record<string, any> = serverImpl as any;
  const sStreamers: Record<string, any> = serverImpl as any;

  // We'll store them as separate objects, or just use `serverImpl` directly with checks
  // For simplicity, let's assume the user has provided only what's needed:
  // (If a method doesn't exist, we return an error at runtime.)

  const internalServer: TSWSInternalServer = {
    connections: new Map(),
    nextConnectionId: 1
  };

  // Setup uWebSockets server
  const app = uWS.App({});

  app.ws("/*", {
    open: (ws) => {
      const connectionId = internalServer.nextConnectionId++;
      internalServer.connections.set(connectionId, {
        ws,
        activeStreams: new Map(),
        nextClientReqId: 1,
        inflightClientRequests: new Map(),
        inflightClientRequestsReject: new Map(),
      });
      // Attach the connectionId to the ws
      // In normal uWebSockets usage, you'd store it in `ws.userData`,
      // but let's store it so we can retrieve it in "message" and "close" events.
      (ws as any).connectionId = connectionId;
    },

    message: async (ws, message, isBinary) => {
      // Convert message from ArrayBuffer to string (assuming JSON).
      let msgString: string;
      if (message instanceof ArrayBuffer) {
        msgString = Buffer.from(message).toString("utf-8");
      } else {
        msgString = Buffer.from(message).toString("utf-8");
      }

      let data: TSWSMessage;
      try {
        data = JSON.parse(msgString);
      } catch (err) {
        console.error("Invalid JSON message:", err);
        return;
      }

      const connectionId = (ws as any).connectionId;
      const connState = internalServer.connections.get(connectionId);
      if (!connState) {
        return;
      }

      // Distinguish request vs. response
      switch (data.type) {
        case "proc":
        case "stream": {
          // The client is calling a server method or streamer
          // 1. Construct context
          const ctx: ServerContext<Context> = {
            rawSocket: ws,
            connectionId,
            server: internalServer,
            extra: {} as Context, // Will fill in with middleware
          };

          // 2. Run the middleware chain
          let index = 0;
          const middlewares = options.middleware || [];

          // final function to call the actual route
          const routeCall = async () => {
            const { route, name, args } = data;
            if (route !== "server") {
              // ignoring calls to "client" here, the user might have messed up
              return;
            }

            // Identify if it's procs or streamers
            if (data.type === "proc") {
              // It's a normal procedure
              if (typeof sProcs[name] !== "function") {
                // No such server method
                return sendError(ws, data.reqId, `Server procedure '${name}' not found`);
              }
              try {
                // Call the server method
                const result = await sProcs[name](args, ctx);
                sendResult(ws, data.reqId, result);
              } catch (err: any) {
                sendError(ws, data.reqId, err?.message ?? String(err));
              }
            } else if (data.type === "stream") {
              // It's a streamer
              if (typeof sStreamers[name] !== "function") {
                return sendError(ws, data.reqId, `Server streamer '${name}' not found`);
              }
              try {
                const generator = sStreamers[name](args, ctx);
                // Store the generator in activeStreams
                connState.activeStreams.set(data.reqId!, {
                  generator,
                  context: ctx,
                });
                // Start reading the first chunk
                pumpStream(ws, connectionId, data.reqId!, generator);
              } catch (err: any) {
                sendError(ws, data.reqId, err?.message ?? String(err));
              }
            }
          };

          // run next middleware
          const runNext = async () => {
            const fn = middlewares[index++];
            if (fn) {
              await fn(ctx, runNext);
            } else {
              await routeCall();
            }
          };

          try {
            await runNext();
          } catch (err) {
            sendError(ws, data.reqId, (err as any)?.message ?? String(err));
          }

          break;
        }

        case "next":
        case "complete":
        case "error":
        case "cancel":
        case "result": {
          // The client is replying to a *server-initiated* call or stream.
          // We'll see if we have a promise or generator waiting
          // for this response in "inflightClientRequests" or something similar.
          handleClientResponse(internalServer, connectionId, data);
          break;
        }

        default:
          console.warn("Unknown message type:", data.type);
          break;
      }
    },

    close: (ws, code, message) => {
      const connectionId = (ws as any).connectionId;
      internalServer.connections.delete(connectionId);
    }
  });

  app.listen(port, (token) => {
    if (token) {
      console.log(`TSWS server listening on port ${port}`);
      options.onStarted?.(app);
    } else {
      console.error(`Failed to listen on port ${port}`);
    }
  });

  /**
   * We'll create a small utility object that we could return if we want.
   * For advanced usage, you might want to shut down or broadcast, etc.
   */
  return {
    /**
     * Not strictly needed for minimal usage, but might be useful if you want
     * to call external APIs or maintain the server lifecycle.
     */
    app,
  };
}

/**
 * Send a "result" message (RPC success).
 */
function sendResult(ws: WebSocket, reqId: number | undefined, value: any) {
  if (!reqId) return;
  ws.send(JSON.stringify({
    reqId,
    type: "result",
    value,
  }));
}

/**
 * Send an "error" message (RPC error).
 */
function sendError(ws: WebSocket, reqId: number | undefined, error: string) {
  if (!reqId) return;
  ws.send(JSON.stringify({
    reqId,
    type: "error",
    error,
  }));
}

/**
 * Send a "next" message for streaming.
 */
function sendNext(ws: WebSocket, reqId: number, value: any) {
  ws.send(JSON.stringify({
    reqId,
    type: "next",
    value,
  }));
}

/**
 * Send a "complete" message for streaming.
 */
function sendComplete(ws: WebSocket, reqId: number) {
  ws.send(JSON.stringify({
    reqId,
    type: "complete",
  }));
}

/**
 * Pull from the generator and send the values to the client.
 */
async function pumpStream(ws: WebSocket, connectionId: number, reqId: number, generator: AsyncGenerator<any, void, unknown>) {
  try {
    while (true) {
      const { value, done } = await generator.next();
      if (done) {
        // stream is completed
        sendComplete(ws, reqId);
        break;
      }
      sendNext(ws, reqId, value);
    }
  } catch (err: any) {
    sendError(ws, reqId, err?.message ?? String(err));
  }
}

/**
 * Handle client responses to server-initiated calls or streams.
 */
function handleClientResponse(
  internalServer: TSWSInternalServer,
  connectionId: number,
  msg: TSWSMessage
) {
  const conn = internalServer.connections.get(connectionId);
  if (!conn) return;

  // if this is a response to a server->client request
  const { reqId, type, value, error } = msg;

  if (!reqId) return;

  // Check inflight requests
  const resolver = conn.inflightClientRequests.get(reqId);
  const rejecter = conn.inflightClientRequestsReject.get(reqId);
  if (resolver || rejecter) {
    switch (type) {
      case "result":
        conn.inflightClientRequests.delete(reqId);
        conn.inflightClientRequestsReject.delete(reqId);
        resolver?.(value);
        break;
      case "error":
        conn.inflightClientRequests.delete(reqId);
        conn.inflightClientRequestsReject.delete(reqId);
        rejecter?.(new Error(error || "Unknown error"));
        break;
      case "next":
      case "complete":
      case "cancel":
        // For streaming responses from the client, you'd handle it similarly
        // if you want the server to do streaming. Typically, you'd store a generator
        // or an AsyncIterator for "client->server" streams.
        // This example focuses on server->client calls.
        break;
      default:
        break;
    }
  }
}
