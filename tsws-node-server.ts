// tsws-node-server.ts
import * as uWS from 'uWebSockets.js';

// Message types for the protocol
type MessageType = 'call' | 'return' | 'error' | 'stream-next' | 'stream-complete' | 'stream-error';

interface BaseMessage {
  type: MessageType;
  id: string;
}

interface CallMessage extends BaseMessage {
  type: 'call';
  target: 'server' | 'client';
  procedure: string;
  params: any[];
}

interface ReturnMessage extends BaseMessage {
  type: 'return';
  value: any;
}

interface ErrorMessage extends BaseMessage {
  type: 'error';
  error: string;
}

interface StreamNextMessage extends BaseMessage {
  type: 'stream-next';
  value: any;
}

interface StreamCompleteMessage extends BaseMessage {
  type: 'stream-complete';
}

interface StreamErrorMessage extends BaseMessage {
  type: 'stream-error';
  error: string;
}

type Message = CallMessage | ReturnMessage | ErrorMessage | StreamNextMessage | StreamCompleteMessage | StreamErrorMessage;

interface ServerOptions {
  port?: number;
  host?: string;
  middleware?: MiddlewareFunction<any>[];
}

type MiddlewareFunction<Context> = (context: Context, next: () => Promise<void>) => Promise<void>;

interface DefaultContext {
  rawSocket: uWS.WebSocket;
}

export function makeTswsServer<
  Routes extends {
    server: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
    };
    client: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
    };
  },
  Context extends DefaultContext = DefaultContext
>(
  serverImpl: {
    [K in keyof (Routes['server']['procs'] & Routes['server']['streamers'])]?:
      (params: any[], ctx?: Context) => any;
  },
  options: ServerOptions = {}
) {
  let app = uWS.App();
  const port = options.port || 8080;
  const host = options.host || '0.0.0.0';
  const middleware = options.middleware || [];

  // Track connected clients
  const clients = new Map<uWS.WebSocket, {
    context: Context;
    pendingCalls: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void }>;
    activeStreams: Map<string, { controller: AbortController }>;
  }>();

  // Current active client connection for client.procs calls
  let currentClientWs: uWS.WebSocket | null = null;

  // Apply middleware chain
  const applyMiddleware = async (context: Context): Promise<void> => {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index < middleware.length) {
        const currentMiddleware = middleware[index];
        index++;
        await currentMiddleware(context, next);
      }
    };

    await next();
  };

  // Handle incoming messages
  const handleMessage = async (ws: uWS.WebSocket, data: string, context: Context) => {
    try {
      const message = JSON.parse(data) as Message;
      const client = clients.get(ws);

      if (!client) return;

      // Set current client for potential nested calls
      currentClientWs = ws;

      switch (message.type) {
        case 'call': {
          if (message.target !== 'server') break;

          try {
            const procedure = message.procedure;
            const params = message.params;

            if (procedure in serverImpl) {
              const result = await serverImpl[procedure](params, context);

              // Check if result is an AsyncGenerator (streamer)
              if (result && typeof result[Symbol.asyncIterator] === 'function') {
                const controller = new AbortController();
                const signal = controller.signal;

                client.activeStreams.set(message.id, { controller });

                try {
                  for await (const value of result) {
                    if (signal.aborted) break;

                    ws.send(JSON.stringify({
                      type: 'stream-next',
                      id: message.id,
                      value,
                    }));
                  }

                  ws.send(JSON.stringify({
                    type: 'stream-complete',
                    id: message.id,
                  }));
                } catch (error) {
                  ws.send(JSON.stringify({
                    type: 'stream-error',
                    id: message.id,
                    error: error instanceof Error ? error.message : String(error),
                  }));
                } finally {
                  client.activeStreams.delete(message.id);
                }
              } else {
                // Regular procedure call
                ws.send(JSON.stringify({
                  type: 'return',
                  id: message.id,
                  value: result,
                }));
              }
            } else {
              throw new Error(`Procedure not found: ${procedure}`);
            }
          } catch (error) {
            ws.send(JSON.stringify({
              type: 'error',
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            }));
          }
          break;
        }

        case 'return': {
          const pendingCall = client.pendingCalls.get(message.id);
          if (pendingCall) {
            pendingCall.resolve(message.value);
            client.pendingCalls.delete(message.id);
          }
          break;
        }

        case 'error': {
          const pendingCall = client.pendingCalls.get(message.id);
          if (pendingCall) {
            pendingCall.reject(new Error(message.error));
            client.pendingCalls.delete(message.id);
          }
          break;
        }
      }

      // Reset current client
      currentClientWs = null;
    } catch (error) {
      console.error('Error handling message:', error);
    }
  };

  // Call a client procedure
  const callClientProcedure = async (
    ws: uWS.WebSocket,
    procedure: string,
    params: any[]
  ): Promise<any> => {
    const client = clients.get(ws);
    if (!client) {
      throw new Error('Client not connected');
    }

    const id = Math.random().toString(36).substring(2, 15);

    return new Promise((resolve, reject) => {
      client.pendingCalls.set(id, { resolve, reject });

      ws.send(JSON.stringify({
        type: 'call',
        id,
        target: 'client',
        procedure,
        params,
      }));
    });
  };

  // Create client proxy
  const clientProxy = {
    procs: new Proxy({} as any, {
      get: (_, procedure: string) => {
        return async (...params: any[]) => {
          if (!currentClientWs) {
            throw new Error('Cannot call client procedure: no active client context');
          }
          return callClientProcedure(currentClientWs, procedure, params);
        };
      },
    }),
    streamers: {} // Client streamers not implemented in server
  };

  const server = {
    async start() {
      return new Promise<void>((resolve, reject) => {
        app.ws('/*', {
          // Set up WebSocket handler
          open: (ws) => {
            const context = { rawSocket: ws } as Context;
            clients.set(ws, {
              context,
              pendingCalls: new Map(),
              activeStreams: new Map(),
            });
          },
          message: async (ws, message, isBinary) => {
            if (isBinary) return;

            const client = clients.get(ws);
            if (!client) return;

            const messageText = Buffer.from(message).toString();

            try {
              // Apply middleware
              await applyMiddleware(client.context);
              // Handle the message
              await handleMessage(ws, messageText, client.context);
            } catch (error) {
              console.error('Error processing message:', error);
            }
          },
          close: (ws) => {
            const client = clients.get(ws);
            if (client) {
              // Abort any active streams
              for (const { controller } of client.activeStreams.values()) {
                controller.abort();
              }

              // Reject any pending calls
              for (const { reject } of client.pendingCalls.values()) {
                reject(new Error('WebSocket connection closed'));
              }

              clients.delete(ws);
            }
          },
        });

        app.listen(port, host, (listenSocket) => {
          if (listenSocket) {
            resolve();
          } else {
            reject(new Error(`Failed to listen on ${host}:${port}`));
          }
        });
      });
    },

    client: clientProxy,
  };

  return server;
}
