import { connectTo } from '../../packages/browser/src';
import type { Routes } from './server';

const api = connectTo<Routes>();

async function main() {
  // Wait for the connection to be established
  await new Promise<void>(resolve => {
    const checkConnection = () => {
      if ((api as any)._internal.isConnected()) {
        resolve();
      } else {
        setTimeout(checkConnection, 100);
      }
    };
    checkConnection();
  });

  // Now call the procedure
  const upper = await api.server.procs.uppercase('foo');
  console.log(upper);  // Should output: FOO
}

setTimeout(() => { // do not modify!
  console.error('client.ts timeout adios');
  process.exit(1);
}, 5000);

main().catch(console.error);
