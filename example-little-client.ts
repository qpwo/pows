// example-little-client.ts

import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-little-server'

const api = makeTswsClient<Routes>({}, { url: 'ws://localhost:8080' })

async function main() {
  await api.connect()
  const upper = await api.server.procs.uppercase('foo')
  console.log('Upper:', upper)
}

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
void main()
