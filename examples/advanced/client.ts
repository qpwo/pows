import { connectTo } from '../../packages/browser/src';
import type { Routes } from './server';

const api = connectTo<Routes>({
  approve: async (question) => {
    return confirm(question);
  },
}, {
  url: 'ws://localhost:8080',
});

async function run() {
  console.log('Square(5):', await api.server.procs.square(5));
  console.log('Who am I?:', await api.server.procs.whoami());

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update);
  }
}

run().catch(console.error);