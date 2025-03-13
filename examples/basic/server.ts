import { startServer } from '../../packages/node/src';

export interface Routes {
  server: {
    procs: {
      uppercase(s: string): string;
    };
    streamers: {};
  };
  client: {
    procs: {};
  };
}

startServer<Routes>({
  uppercase(s, ctx) {
    return s.toUpperCase();
  }
});