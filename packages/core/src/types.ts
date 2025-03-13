export type Middleware<Context> = (
  ctx: Context,
  next: () => Promise<void>
) => Promise<void>;

export type MiddlewareStack<Context> = Array<Middleware<Context>>;

export type RPCFunction<P, R, Context = unknown> = 
  (params: P, ctx: Context) => R | Promise<R>;

export type StreamFunction<P, R, Context = unknown> = 
  (params: P, ctx: Context) => AsyncGenerator<R, void, unknown>;

export interface ServerConfig<Context = unknown> {
  middleware?: MiddlewareStack<Context>;
  port?: number;
  host?: string;
}

export interface ClientConfig {
  url?: string;
  middleware?: MiddlewareStack<any>;
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
}

export type ExtractRoutes<T> = T;

// Explicit function signatures for the handlers
export type ProcedureHandlers<Routes extends { 
  server: { 
    procs: { [key: string]: (...args: any[]) => any } 
  } 
}, Context> = {
  [K in keyof Routes['server']['procs']]: RPCFunction<
    Parameters<Routes['server']['procs'][K]>[0],
    ReturnType<Routes['server']['procs'][K]> extends Promise<infer U> ? U : ReturnType<Routes['server']['procs'][K]>,
    Context
  >;
};

export type StreamHandlers<Routes extends { 
  server: { 
    streamers: { [key: string]: (...args: any[]) => any } 
  } 
}, Context> = {
  [K in keyof Routes['server']['streamers']]: StreamFunction<
    Parameters<Routes['server']['streamers'][K]>[0],
    ReturnType<Routes['server']['streamers'][K]> extends AsyncGenerator<infer U, any, any> ? U : never,
    Context
  >;
};

export type ClientProcedureHandlers<Routes extends { 
  client: { 
    procs: { [key: string]: (...args: any[]) => any } 
  } 
}, Context> = {
  [K in keyof Routes['client']['procs']]: RPCFunction<
    Parameters<Routes['client']['procs'][K]>[0],
    ReturnType<Routes['client']['procs'][K]> extends Promise<infer U> ? U : ReturnType<Routes['client']['procs'][K]>,
    Context
  >;
};

export type ServerHandlers<Routes extends { 
  server: { 
    procs: { [key: string]: (...args: any[]) => any };
    streamers: { [key: string]: (...args: any[]) => any }; 
  }
}, Context> =
  ProcedureHandlers<Routes, Context> & 
  StreamHandlers<Routes, Context>;

export interface MessageBase {
  id: string;
  type: string;
}

export interface RPCRequest extends MessageBase {
  type: 'rpc-request';
  procedure: string;
  params: any;
}

export interface RPCResponse extends MessageBase {
  type: 'rpc-response';
  result?: any;
  error?: {
    message: string;
    code?: number;
    data?: any;
  };
}

export interface StreamStart extends MessageBase {
  type: 'stream-start';
  procedure: string;
  params: any;
}

export interface StreamData extends MessageBase {
  type: 'stream-data';
  data: any;
}

export interface StreamEnd extends MessageBase {
  type: 'stream-end';
  error?: {
    message: string;
    code?: number;
    data?: any;
  };
}

export interface StreamCancel extends MessageBase {
  type: 'stream-cancel';
}

export type ProtocolMessage = 
  | RPCRequest 
  | RPCResponse 
  | StreamStart 
  | StreamData 
  | StreamEnd 
  | StreamCancel;