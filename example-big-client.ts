
// example-big-client.ts
import { connectTo } from './tsws-node-client';
import type { Routes } from './example-big-server';

const api = connectTo<Routes, {}>({
  approve: async (question) => {
    return confirm(question);
  },
}, {
  url: 'ws://localhost:8080',
});

async function main() {
  console.log('Square(5):', await api.server.procs.square(5));
  console.log('Who am I?:', await api.server.procs.whoami());

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update);
  }
}

main()
