import {
  ClientConfig,
  ProtocolMessage,
  RPCRequest,
  RPCResponse,
  StreamStart,
  StreamData,
  StreamEnd,
  StreamCancel,
  generateMessageId,
  serializeMessage,
  parseMessage,
  executeMiddleware,
  ClientProcedureHandlers
} from '@tsws/core';

// Use browser-specific AsyncLocalStorage polyfill
import { AsyncLocalStorage, runWithContext } from './async-storage';
const asyncLocalStorage = new AsyncLocalStorage<any>();

interface RPCPromise {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

interface StreamController {
  messageId: string;
  controller: {
    push: (value: any) => void;
    complete: (error?: Error) => void;
  };
}

export interface BrowserClient<Routes extends {
  server: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => any>;
  };
  client: {
    procs: Record<string, (...args: any[]) => any>;
  };
}, Context = unknown> {
  server: {
    procs: {
      [K in keyof Routes['server']['procs']]: Routes['server']['procs'][K];
    };
    streamers: {
      [K in keyof Routes['server']['streamers']]: Routes['server']['streamers'][K];
    };
  };
  client: {
    procs: ClientProcedureHandlers<Routes, Context>;
  };
  _internal: {
    ws: WebSocket;
    close: () => void;
    isConnected: () => boolean;
  };
}

class WebSocketClient<Routes extends {
  server: {
    procs: Record<string, (...args: any[]) => any>;
    streamers: Record<string, (...args: any[]) => any>;
  };
  client: {
    procs: Record<string, (...args: any[]) => any>;
  };
}, Context = unknown> {
  private ws: WebSocket | null = null;
  private config: Required<ClientConfig>;
  private pendingRPCs: Map<string, RPCPromise> = new Map();
  private activeStreams: Map<string, StreamController> = new Map();
  private reconnectAttempts = 0;
  private handlers: ClientProcedureHandlers<Routes, Context>;
  private clientApi: BrowserClient<Routes, Context>;
  private clientId: string;

  constructor(
    handlers: ClientProcedureHandlers<Routes, Context> = {} as any,
    config: ClientConfig = {}
  ) {
    this.handlers = handlers;
    this.clientId = generateMessageId();
    
    // Set default config
    this.config = {
      url: 'ws://localhost:8080',
      middleware: [],
      reconnect: true,
      reconnectDelay: 1000,
      maxReconnectAttempts: 10,
      ...config
    };
    
    this.clientApi = this.createClientApi();
    
    // Connect to the server
    this.connect();
  }

  private connect() {
    try {
      this.ws = new WebSocket(this.config.url);
      
      this.ws.onopen = this.onOpen.bind(this);
      this.ws.onmessage = this.onMessage.bind(this);
      this.ws.onclose = this.onClose.bind(this);
      this.ws.onerror = this.onError.bind(this);
    } catch (error) {
      console.error('Failed to create WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  private onOpen() {
    console.log('Connected to server');
    this.reconnectAttempts = 0;
  }

  private async onMessage(event: MessageEvent) {
    try {
      const message = parseMessage(event.data as string);
      
      // Create a context for this message
      const context = {
        clientId: this.clientId,
        ws: this.ws
      } as unknown as Context;
      
      // Process the message with the context
      await runWithContext(context, async () => {
        await this.handleMessage(message);
      });
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  private onClose(event: CloseEvent) {
    console.log(`Connection closed: ${event.code} ${event.reason}`);
    
    // Reject all pending RPCs
    for (const [id, { reject }] of this.pendingRPCs.entries()) {
      reject(new Error('Connection closed'));
      this.pendingRPCs.delete(id);
    }
    
    // Close all active streams
    for (const [id, { controller }] of this.activeStreams.entries()) {
      controller.complete(new Error('Connection closed'));
      this.activeStreams.delete(id);
    }
    
    this.scheduleReconnect();
  }

  private onError(error: Event) {
    console.error('WebSocket error:', error);
  }

  private scheduleReconnect() {
    if (!this.config.reconnect) {
      return;
    }
    
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached');
      return;
    }
    
    this.reconnectAttempts++;
    
    const delay = this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    
    setTimeout(() => {
      this.connect();
    }, delay);
  }

  private async handleMessage(message: ProtocolMessage) {
    switch (message.type) {
      case 'rpc-request':
        await this.handleRPCRequest(message);
        break;
        
      case 'rpc-response':
        this.handleRPCResponse(message);
        break;
        
      case 'stream-data':
        this.handleStreamData(message);
        break;
        
      case 'stream-end':
        this.handleStreamEnd(message);
        break;
        
      default:
        console.warn('Unhandled message type:', message.type);
    }
  }

  private async handleRPCRequest(request: RPCRequest) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('Cannot handle RPC request: not connected');
      return;
    }
    
    const response: RPCResponse = {
      id: request.id,
      type: 'rpc-response'
    };
    
    try {
      // Get the handler for this procedure
      const handler = (this.handlers as any)[request.procedure];
      
      if (!handler || typeof handler !== 'function') {
        throw new Error(`Unknown procedure: ${request.procedure}`);
      }
      
      // Create context and run middleware
      const ctx = asyncLocalStorage.getStore() as Context;
      
      if (this.config.middleware && this.config.middleware.length > 0) {
        await executeMiddleware(this.config.middleware, ctx);
      }
      
      // Call the handler with the parameters and context
      const result = await handler(request.params, ctx);
      
      // Send the response
      response.result = result;
      this.ws.send(serializeMessage(response));
    } catch (error: any) {
      // Send error response
      response.error = {
        message: error.message || 'Unknown error',
        code: error.code
      };
      
      this.ws.send(serializeMessage(response));
    }
  }

  private handleRPCResponse(response: RPCResponse) {
    const pending = this.pendingRPCs.get(response.id);
    
    if (!pending) {
      console.warn('Received response for unknown RPC:', response.id);
      return;
    }
    
    this.pendingRPCs.delete(response.id);
    
    if (response.error) {
      pending.reject(new Error(response.error.message));
    } else {
      pending.resolve(response.result);
    }
  }

  private handleStreamData(message: StreamData) {
    const stream = this.activeStreams.get(message.id);
    
    if (!stream) {
      console.warn('Received data for unknown stream:', message.id);
      return;
    }
    
    stream.controller.push(message.data);
  }

  private handleStreamEnd(message: StreamEnd) {
    const stream = this.activeStreams.get(message.id);
    
    if (!stream) {
      console.warn('Received end for unknown stream:', message.id);
      return;
    }
    
    this.activeStreams.delete(message.id);
    
    if (message.error) {
      stream.controller.complete(new Error(message.error.message));
    } else {
      stream.controller.complete();
    }
  }

  private sendMessage(message: ProtocolMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to server');
    }
    
    this.ws.send(serializeMessage(message));
  }

  private callRPC<T>(procedure: string, params: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to server'));
        return;
      }
      
      const messageId = generateMessageId();
      
      // Create the request message
      const request: RPCRequest = {
        id: messageId,
        type: 'rpc-request',
        procedure,
        params
      };
      
      // Register the promise
      this.pendingRPCs.set(messageId, { resolve, reject });
      
      // Send the request
      this.sendMessage(request);
      
      // Set up a timeout to reject the promise if no response is received
      setTimeout(() => {
        const pending = this.pendingRPCs.get(messageId);
        
        if (pending) {
          this.pendingRPCs.delete(messageId);
          pending.reject(new Error('RPC request timed out'));
        }
      }, 30000); // 30 second timeout
    });
  }

  private createStream<T>(procedure: string, params: any): AsyncGenerator<T, void, unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to server');
    }
    
    const messageId = generateMessageId();
    
    // Create the request message
    const request: StreamStart = {
      id: messageId,
      type: 'stream-start',
      procedure,
      params
    };
    
    // Create a generator that will yield stream data
    const generator = this.createStreamGenerator<T>(messageId);
    
    // Send the request
    this.sendMessage(request);
    
    return generator;
  }

  private createStreamGenerator<T>(messageId: string): AsyncGenerator<T, void, unknown> {
    const self = this;
    let buffer: T[] = [];
    let error: Error | null = null;
    let done = false;
    let resolveNext: ((value: IteratorResult<T, void>) => void) | null = null;
    
    // Create a controller that the message handlers will use
    const controller = {
      push: (value: T) => {
        if (resolveNext) {
          resolveNext({ value, done: false });
          resolveNext = null;
        } else {
          buffer.push(value);
        }
      },
      complete: (err?: Error) => {
        error = err || null;
        done = true;
        
        if (resolveNext) {
          if (error) {
            // This will be caught by the generator's next() call
            throw error;
          } else {
            resolveNext({ value: undefined, done: true });
          }
          resolveNext = null;
        }
      }
    };
    
    // Register the stream
    this.activeStreams.set(messageId, {
      messageId,
      controller
    });
    
    // Create and return the generator
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      
      async next(): Promise<IteratorResult<T, void>> {
        // If there's data in the buffer, return it
        if (buffer.length > 0) {
          return { value: buffer.shift()!, done: false };
        }
        
        // If the stream is done, return done
        if (done) {
          return { value: undefined, done: true };
        }
        
        // Otherwise, wait for more data
        return new Promise((resolve, reject) => {
          if (error) {
            reject(error);
          } else {
            resolveNext = resolve;
          }
        });
      },
      
      async return(): Promise<IteratorResult<T, void>> {
        // Cancel the stream
        try {
          if (!done && self.ws && self.ws.readyState === WebSocket.OPEN) {
            const cancelMessage: StreamCancel = {
              id: messageId,
              type: 'stream-cancel'
            };
            
            self.sendMessage(cancelMessage);
          }
        } catch (e) {
          // Ignore errors when canceling
        }
        
        // Clean up
        self.activeStreams.delete(messageId);
        done = true;
        
        return { value: undefined, done: true };
      },
      
      async throw(err: any): Promise<IteratorResult<T, void>> {
        // Cancel the stream
        try {
          if (!done && self.ws && self.ws.readyState === WebSocket.OPEN) {
            const cancelMessage: StreamCancel = {
              id: messageId,
              type: 'stream-cancel'
            };
            
            self.sendMessage(cancelMessage);
          }
        } catch (e) {
          // Ignore errors when canceling
        }
        
        // Clean up
        self.activeStreams.delete(messageId);
        done = true;
        error = err;
        
        throw err;
      }
    } as AsyncGenerator<T, void, unknown>;
  }

  private createClientApi(): BrowserClient<Routes, Context> {
    const self = this;
    
    const api: any = {
      server: {
        procs: {},
        streamers: {}
      },
      client: {
        procs: this.handlers
      },
      _internal: {
        get ws() {
          return self.ws;
        },
        close: () => {
          if (self.ws) {
            self.ws.close();
          }
        },
        isConnected: () => {
          return self.ws !== null && self.ws.readyState === WebSocket.OPEN;
        }
      }
    };
    
    // Create RPC proxy functions for each server procedure
    const serverProcs = Object.keys(({} as Routes['server']['procs'])) as Array<keyof Routes['server']['procs']>;
    for (const procedure of serverProcs) {
      api.server.procs[procedure] = async (...args: any[]) => {
        return this.callRPC(procedure as string, args.length === 1 ? args[0] : args);
      };
    }
    
    // Create stream proxy functions for each server streamer
    const serverStreamers = Object.keys(({} as Routes['server']['streamers'])) as Array<keyof Routes['server']['streamers']>;
    for (const procedure of serverStreamers) {
      api.server.streamers[procedure] = async function*(...args: any[]) {
        const stream = self.createStream(procedure as string, args.length === 1 ? args[0] : args);
        yield* stream;
      };
    }
    
    return api as BrowserClient<Routes, Context>;
  }

  public getClientApi(): BrowserClient<Routes, Context> {
    return this.clientApi;
  }
}

/**
 * Connect to a WebSocket server
 */
export function connectTo<
  Routes extends {
    server: {
      procs: Record<string, (...args: any[]) => any>;
      streamers: Record<string, (...args: any[]) => any>;
    };
    client: {
      procs: Record<string, (...args: any[]) => any>;
    };
  },
  Context = unknown
>(
  handlers: ClientProcedureHandlers<Routes, Context> = {} as any,
  config: ClientConfig = {}
): BrowserClient<Routes, Context> {
  const client = new WebSocketClient<Routes, Context>(handlers, config);
  return client.getClientApi();
}