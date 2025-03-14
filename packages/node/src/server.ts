import uWS from 'uWebSockets.js';
import {
  ProtocolMessage,
  ServerHandlers,
  ServerConfig,
  executeMiddleware,
  parseMessage,
  serializeMessage,
  generateMessageId,
  RPCRequest,
  RPCResponse,
  StreamStart,
  StreamData,
  StreamEnd,
  StreamCancel,
  ClientProcedureHandlers,
  asyncLocalStorage,
  runWithContext
} from '@tsws/core';

interface ServerImplementation<Routes extends {
  server: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => any>;
  };
  client: {
    procs: Record<string, (...args: any[]) => any>;
  };
}, Context> {
  client: {
    procs: {
      [K in keyof Routes['client']['procs']]: (
        params: Parameters<Routes['client']['procs'][K]>[0],
        clientOrId?: string | WebSocketClient
      ) => ReturnType<Routes['client']['procs'][K]>;
    };
  };
}

interface WebSocketClient {
  id: string;
  send: (message: ProtocolMessage) => void;
  close: () => void;
}

class WebSocketServer<Routes extends {
  server: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => any>;
  };
  client: {
    procs: Record<string, (...args: any[]) => any>;
  };
}, Context extends Record<string, any>> {
  private app: uWS.TemplatedApp;
  private clients: Map<string, WebSocketClient> = new Map();
  private handlers: ServerHandlers<Routes, Context>;
  private config: ServerConfig<Context>;
  private activeStreams: Map<string, AsyncGenerator<any, void, unknown>> = new Map();
  private pendingResponses: Map<string, { resolve: (result: any) => void, reject: (error: Error) => void }> = new Map();
  private api: ServerImplementation<Routes, Context>;

  constructor(handlers: ServerHandlers<Routes, Context>, config: ServerConfig<Context> = {}) {
    this.handlers = handlers;
    this.config = {
      port: 8080,
      host: 'localhost',
      ...config
    };

    this.app = uWS.App();

    this.setupWebSocketServer();

    this.api = this.createClientApi();
  }

  private setupWebSocketServer() {
    this.app.ws('/*', {
      maxPayloadLength: 16 * 1024 * 1024,
      idleTimeout: 60,

      open: (ws) => {
        const clientId = generateMessageId();
        const client: WebSocketClient = {
          id: clientId,
          send: (message: ProtocolMessage) => {
            ws.send(serializeMessage(message));
          },
          close: () => {
            ws.close();
          }
        };

        this.clients.set(clientId, client);

        // Store client reference in WebSocket for later use
        (ws as any).clientId = clientId;
      },

      message: async (ws, message, isBinary) => {
        if (isBinary) {
          // We don't support binary messages in this implementation
          return;
        }

        const clientId = (ws as any).clientId;
        const client = this.clients.get(clientId);

        if (!client) {
          // Client not found, possibly disconnected
          return;
        }

        try {
          const data = Buffer.from(message).toString();
          const parsedMessage = parseMessage(data);

          await this.handleMessage(parsedMessage, client, ws);
        } catch (error) {
          console.error('Error handling message:', error);
        }
      },

      close: (ws, code, message) => {
        const clientId = (ws as any).clientId;

        // Clean up any active streams for this client
        for (const [streamId, generator] of this.activeStreams.entries()) {
          if (streamId.startsWith(clientId)) {
            generator.return();
            this.activeStreams.delete(streamId);
          }
        }

        // Reject any pending responses for this client
        for (const [messageId, { reject }] of this.pendingResponses.entries()) {
          if (messageId.startsWith(`${clientId}:`)) {
            reject(new Error('Client disconnected'));
            this.pendingResponses.delete(messageId);
          }
        }

        this.clients.delete(clientId);
      }
    });
  }

  private async handleMessage(
    message: ProtocolMessage,
    client: WebSocketClient,
    rawSocket: uWS.WebSocket
  ) {
    const baseContext = {
      clientId: client.id,
      client,
      rawSocket
    } as unknown as Context;

    // Run the handler in the context of the AsyncLocalStorage
    await runWithContext(baseContext, async () => {
      // Handle different message types
      switch (message.type) {
        case 'rpc-request':
          await this.handleRPCRequest(message, client, baseContext);
          break;

        case 'stream-start':
          await this.handleStreamStart(message, client, baseContext);
          break;

        case 'stream-cancel':
          await this.handleStreamCancel(message);
          break;

        case 'rpc-response':
          this.handleRPCResponse(message);
          break;

        default:
          // Unhandled message type
          console.warn('Unhandled message type:', message.type);
      }
    });
  }

  private async handleRPCRequest(
    request: RPCRequest,
    client: WebSocketClient,
    baseContext: Context
  ) {
    const response: RPCResponse = {
      id: request.id,
      type: 'rpc-response'
    };

    try {
      // Create context and run middleware
      const ctx = { ...baseContext };

      if (this.config.middleware) {
        await executeMiddleware(this.config.middleware, ctx);
      }

      // Extract procedure name parts (procs.procName)
      const [category, procName] = request.procedure.split('.');

      // Get the handler for this procedure
      const handler = category === 'procs' && this.handlers.procs
        ? (this.handlers.procs as any)[procName]
        : (this.handlers as any)[request.procedure];

      if (!handler || typeof handler !== 'function') {
        throw new Error(`Unknown procedure: ${request.procedure}`);
      }

      // Call the handler with the parameters and context
      const result = await handler(request.params, ctx);

      // Send the response
      response.result = result;
      client.send(response);
    } catch (error: any) {
      // Send error response
      response.error = {
        message: error.message || 'Unknown error',
        code: error.code
      };

      client.send(response);
    }
  }

  private handleRPCResponse(response: RPCResponse) {
    const key = `${asyncLocalStorage.getStore()?.clientId}:${response.id}`;
    const pending = this.pendingResponses.get(key);

    if (pending) {
      this.pendingResponses.delete(key);

      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    }
  }

  private async handleStreamStart(
    request: StreamStart,
    client: WebSocketClient,
    baseContext: Context
  ) {
    try {
      // Create context and run middleware
      const ctx = { ...baseContext };

      if (this.config.middleware) {
        await executeMiddleware(this.config.middleware, ctx);
      }

      // Extract procedure name parts (streamers.streamerName)
      const [category, procName] = request.procedure.split('.');

      // Get the handler for this procedure
      const handler = category === 'streamers' && this.handlers.streamers
        ? (this.handlers.streamers as any)[procName]
        : (this.handlers as any)[request.procedure];

      if (!handler || typeof handler !== 'function') {
        throw new Error(`Unknown stream procedure: ${request.procedure}`);
      }

      // Call the handler with the parameters and context
      const generator = handler(request.params, ctx);

      if (!generator || typeof generator.next !== 'function') {
        throw new Error(`Handler for ${request.procedure} did not return an AsyncGenerator`);
      }

      // Store the generator with a unique stream ID (clientId + messageId)
      const streamId = `${client.id}:${request.id}`;
      this.activeStreams.set(streamId, generator);

      // Process the stream
      this.processStream(request.id, generator, client);
    } catch (error: any) {
      // Send error response
      const endMessage: StreamEnd = {
        id: request.id,
        type: 'stream-end',
        error: {
          message: error.message || 'Unknown error',
          code: error.code
        }
      };

      client.send(endMessage);
    }
  }

  private async processStream(
    messageId: string,
    generator: AsyncGenerator<any, void, unknown>,
    client: WebSocketClient
  ) {
    const streamId = `${client.id}:${messageId}`;

    try {
      // Process all stream values without creating new message objects for each iteration
      let result;

      // Reuse data message object for better performance
      const dataMessage: StreamData = {
        id: messageId,
        type: 'stream-data',
        data: undefined
      };

      while (!(result = await generator.next()).done) {
        // Update data in the reused message
        dataMessage.data = result.value;

        // Send the data
        client.send(dataMessage);
      }

      // Stream completed successfully
      client.send({
        id: messageId,
        type: 'stream-end'
      });

    } catch (error: any) {
      // Stream threw an error, send error message
      client.send({
        id: messageId,
        type: 'stream-end',
        error: {
          message: error?.message || 'Unknown error',
          code: error?.code
        }
      });
    } finally {
      // Always clean up the stream
      this.activeStreams.delete(streamId);
    }
  }

  private async handleStreamCancel(request: StreamCancel) {
    // Find the stream associated with this message ID
    for (const [streamId, generator] of this.activeStreams.entries()) {
      if (streamId.endsWith(`:${request.id}`)) {
        // Cancel the stream
        await generator.return();
        this.activeStreams.delete(streamId);
        break;
      }
    }
  }

  private createClientApi(): ServerImplementation<Routes, Context> {
    const api: any = {
      client: {
        procs: {}
      }
    };

    // Get client procedures from Routes type
    const clientProcs = Object.keys(({} as Routes['client']['procs'])) as Array<keyof Routes['client']['procs']>;

    // Create RPC proxy functions for each client procedure
    for (const procedure of clientProcs) {
      api.client.procs[procedure] = async (params: any, clientOrId?: string | WebSocketClient) => {
        // Use the context client if available, otherwise use the provided client or client ID
        let client: WebSocketClient | undefined;

        if (!clientOrId) {
          // Try to get client from the current context
          const context = asyncLocalStorage.getStore() as Context | undefined;

          if (context?.client) {
            client = context.client as unknown as WebSocketClient;
          } else if (context?.clientId) {
            client = this.clients.get(context.clientId);
          }

          if (!client) {
            throw new Error('No client found in context and no client provided');
          }
        } else if (typeof clientOrId === 'string') {
          client = this.clients.get(clientOrId);

          if (!client) {
            throw new Error(`Client not found: ${clientOrId}`);
          }
        } else {
          client = clientOrId as WebSocketClient;
        }

        // Generate a unique message ID
        const messageId = generateMessageId();

        // Create the request message
        const request: RPCRequest = {
          id: messageId,
          type: 'rpc-request',
          procedure: procedure as string,
          params
        };

        return new Promise((resolve, reject) => {
          // Register a callback for this message ID
          const key = `${client!.id}:${messageId}`;
          this.pendingResponses.set(key, { resolve, reject });

          // Send the request
          client!.send(request);

          // Set up a timeout to reject the promise if no response is received
          setTimeout(() => {
            if (this.pendingResponses.has(key)) {
              this.pendingResponses.delete(key);
              reject(new Error('RPC request timed out'));
            }
          }, 30000); // 30 second timeout
        });
      };
    }

    return api as ServerImplementation<Routes, Context>;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = this.config.host || 'localhost';
      const port = this.config.port || 8080;
      this.app.listen(host, port, (listenSocket) => {
        if (listenSocket) {
          console.log(`Server listening on ${host}:${port}`);
          resolve();
        } else {
          reject(new Error(`Failed to listen on ${host}:${port}`));
        }
      });
    });
  }

  public getApi(): ServerImplementation<Routes, Context> {
    return this.api;
  }
}

/**
 * Start a WebSocket server with the given handlers and configuration
 */
export function startServer<
  Routes extends {
    server: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => any>;
    };
    client: {
      procs: Record<string, (...args: any[]) => any>;
    };
  },
  Context extends Record<string, any> = Record<string, any>
>(handlers: ServerHandlers<Routes, Context>, config: ServerConfig<Context> = {}): ServerImplementation<Routes, Context> {
  const server = new WebSocketServer<Routes, Context>(handlers, config);

  // Start the server
  server.start().catch(error => {
    console.error('Failed to start server:', error);
  });

  return server.getApi();
}
