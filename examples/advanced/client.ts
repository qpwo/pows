import { connectTo } from '../../packages/browser/src';
import type { Routes } from './server';

// Simple confirm implementation for both browser and Node environments
const confirmPrompt = (question: string): boolean => {
  // Use browser's confirm if available
  if (typeof window !== 'undefined' && window.confirm) {
    return window.confirm(question);
  }
  
  // Simple fallback for Node.js (used in example)
  console.log(`${question} (Y/n)`);
  // Always return true in Node.js for simplicity in this example
  return true;
};

const api = connectTo<Routes>({
  approve: async (question) => {
    return confirmPrompt(question);
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