// example-little-server.ts

import { startServer } from './tsws-node-server';

export interface Routes {
  server: {
    procs: {
      uppercase(s: string): string;
    };
    streamers: {};
  };
  client: {
    procs: {};
    streamers: {};
  };
}

startServer<Routes>({
  // serverImpl
  uppercase([s]) {
    return s.toUpperCase();
  }
}, {
  port: 8080,
});
