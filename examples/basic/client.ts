import { connectTo } from '../../packages/browser/src';
import type { Routes } from './server';

const api = connectTo<Routes>();

async function main() {
  const upper = await api.server.procs.uppercase('foo');
  console.log(upper);  // Should output: FOO
}

main().catch(console.error);