// tsws-node-client.ts
import WebSocket from 'ws';

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

interface ClientOptions {
  url: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export function makeTswsClient
 < Routes extends {
    server: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
    };
    client: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>;
    };
  },
  Context = {}
>(
  clientImpl: {
    [K in keyof Routes['client']['procs']]?:
      (question: any) => ReturnType<Routes['client']['procs'][K]>;
  },
  options: ClientOptions
) {
  let ws: WebSocket | null = null;
  let connecting = false;
  let connected = false;
  let connectionPromise: Promise<void> | null = null;

  const pendingCalls = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void
  }>();

  const streamSubscribers = new Map<string, {
    next: (value: any) => void;
    complete: () => void;
    error: (err: Error) => void;
  }>();

  const connect = async (): Promise<void> => {
    if (connected || connecting) {
        if (connectionPromise) return connectionPromise;
    }

    connecting = true;
    connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        ws = new WebSocket(options.url);

        ws.on('open', () => {
          connected = true;
          connecting = false;
          resolve();
        });

        ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as Message;

            switch (message.type) {
              case 'call': {
                if (message.target !== 'client') break;

                const procedure = message.procedure;
                const params = message.params;

                if (procedure in clientImpl) {
                  Promise.resolve()
                    .then(() => clientImpl[procedure](...params))
                    .then((result) => {
                      ws?.send(JSON.stringify({
                        type: 'return',
                        id: message.id,
                        value: result,
                      }));
                    })
                    .catch((error) => {
                      ws?.send(JSON.stringify({
                        type: 'error',
                        id: message.id,
                        error: error instanceof Error ? error.message : String(error),
                      }));
                    });
                } else {
                  ws?.send(JSON.stringify({
                    type: 'error',
                    id: message.id,
                    error: `Procedure not found: ${procedure}`,
                  }));
                }
                break;
              }

              case 'return': {
                const pendingCall = pendingCalls.get(message.id);
                if (pendingCall) {
                  pendingCall.resolve(message.value);
                  pendingCalls.delete(message.id);
                }
                break;
              }

              case 'error': {
                const pendingCall = pendingCalls.get(message.id);
                if (pendingCall) {
                  pendingCall.reject(new Error(message.error));
                  pendingCalls.delete(message.id);
                }
                break;
              }

              case 'stream-next': {
                const subscriber = streamSubscribers.get(message.id);
                if (subscriber) {
                  subscriber.next(message.value);
                }
                break;
              }

              case 'stream-complete': {
                const subscriber = streamSubscribers.get(message.id);
                if (subscriber) {
                  subscriber.complete();
                  streamSubscribers.delete(message.id);
                }
                break;
              }

              case 'stream-error': {
                const subscriber = streamSubscribers.get(message.id);
                if (subscriber) {
                  subscriber.error(new Error(message.error));
                  streamSubscribers.delete(message.id);
                }
                break;
              }
            }
          } catch (error) {
            console.error('Error handling message:', error);
          }
        });

        ws.on('close', () => {
          connected = false;
          connecting = false;
          connectionPromise = null;

          // Reject all pending calls
          for (const { reject } of pendingCalls.values()) {
            reject(new Error('WebSocket connection closed'));
          }
          pendingCalls.clear();

          // Error all active streams
          for (const { error } of streamSubscribers.values()) {
            error(new Error('WebSocket connection closed'));
          }
          streamSubscribers.clear();

          // Attempt to reconnect if enabled
          if (options.reconnect) {
            setTimeout(() => {
              connect().catch(console.error);
            }, options.reconnectInterval || 1000);
          }
        });

        ws.on('error', (error) => {
          connecting = false;
          if (!connected) {
            connectionPromise = null;
            reject(error);
          }
        });
      } catch (error) {
        connecting = false;
        connectionPromise = null;
        reject(error);
      }
    });

    return connectionPromise;
  };

  const callServerProcedure = async (procedure: string, ...params: any[]): Promise<any> => {
    if (!connected) {
      throw new Error('Not connected to server');
    }

    const id = Math.random().toString(36).substring(2, 15);

    return new Promise((resolve, reject) => {
      pendingCalls.set(id, { resolve, reject });

      ws?.send(JSON.stringify({
        type: 'call',
        id,
        target: 'server',
        procedure,
        params,
      }));
    });
  };

  const createServerStreamProducer = (procedure: string, ...params: any[]): AsyncGenerator<any, void, unknown> => {
    if (!connected) {
      throw new Error('Not connected to server');
    }

    const id = Math.random().toString(36).substring(2, 15);

    // Create a queue for values
    let valueQueue: any[] = [];
    let resolveNext: ((value: IteratorResult<any, void>) => void) | null = null;
    let error: Error | null = null;
    let done = false;

    // Set up the subscriber
    streamSubscribers.set(id, {
      next: (value) => {
        if (resolveNext) {
          resolveNext({ value, done: false });
          resolveNext = null;
        } else {
          valueQueue.push(value);
        }
      },
      complete: () => {
        done = true;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
        }
      },
      error: (err) => {
        error = err;
        if (resolveNext) {
          resolveNext({ value: undefined, done: true });
          resolveNext = null;
        }
      },
    });

    // Send the call
    ws?.send(JSON.stringify({
      type: 'call',
      id,
      target: 'server',
      procedure,
      params,
    }));

    async function* generator(): AsyncGenerator<any, void, unknown> {
      try {
        while (!done && !error) {
          if (valueQueue.length > 0) {
            yield valueQueue.shift();
          } else {
            const result = await new Promise<IteratorResult<any, void>>((resolve) => {
              resolveNext = resolve;
            });

            if (result.done) {
              return;
            }

            yield result.value;
          }
        }

        if (error) {
          throw error;
        }
      } finally {
        streamSubscribers.delete(id);
      }
    }

    return generator();
  };

  // Create server proxies
  const serverProcs = {};
  const serverStreamers = {};

  // Proxy for server procedures
  const serverProcsProxy = new Proxy(serverProcs, {
    get: (_, procedure: string) => {
      return (...params: any[]) => callServerProcedure(procedure, ...params);
    },
  });

  // Proxy for server streamers
  const serverStreamersProxy = new Proxy(serverStreamers, {
    get: (_, procedure: string) => {
      return (...params: any[]) => createServerStreamProducer(procedure, ...params);
    },
  });

  return {
    connect,
    server: {
      procs: serverProcsProxy as any,
      streamers: serverStreamersProxy as any,
    },
  };
}
