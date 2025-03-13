declare module 'uWebSockets.js' {
  interface TemplatedApp {
    listen(host: string, port: number, cb: (listenSocket: any) => void): TemplatedApp;
    ws(pattern: string, behavior: WebSocketBehavior): TemplatedApp;
  }

  interface WebSocketBehavior {
    compression?: number;
    maxPayloadLength?: number;
    idleTimeout?: number;
    open?: (ws: WebSocket) => void;
    message?: (ws: WebSocket, message: ArrayBuffer, isBinary: boolean) => void;
    drain?: (ws: WebSocket) => void;
    close?: (ws: WebSocket, code: number, message: ArrayBuffer) => void;
    ping?: (ws: WebSocket, message: ArrayBuffer) => void;
    pong?: (ws: WebSocket, message: ArrayBuffer) => void;
  }

  interface WebSocket {
    send(message: string | ArrayBuffer, isBinary?: boolean, compress?: boolean): boolean;
    end(code?: number, message?: string | ArrayBuffer): void;
    close(): void;
    getBufferedAmount(): number;
    subscribe(topic: string): boolean;
    unsubscribe(topic: string): boolean;
    publish(topic: string, message: string | ArrayBuffer, isBinary?: boolean, compress?: boolean): boolean;
    cork(cb: () => void): void;
    upgradeReq: {
      url: string;
      method: string;
      headers: {
        [key: string]: string;
      };
      connection: {
        remoteAddress: string;
      };
      cookies: {
        [key: string]: string;
      };
    };
  }

  export function App(options?: any): TemplatedApp;
  export function SSLApp(options?: any): TemplatedApp;
}

declare module 'uwebsockets.js' {
  export * from 'uWebSockets.js';
}