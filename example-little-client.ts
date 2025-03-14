// example-little-client.ts

import { connectTo } from './tsws-node-client';
import type { Routes } from './example-little-server';

async function main() {
  const api = connectTo<Routes>({}, { url: 'ws://localhost:8080' });
  const upper = await api.server.procs.uppercase('foo');
  console.log('Upper:', upper);
}

main();
