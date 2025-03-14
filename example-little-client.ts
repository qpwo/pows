// example-little-client.ts

import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-little-server'

const api = makeTswsClient<Routes>({}, { url: 'ws://localhost:8080' })

async function main() {
  await api.connect()
  console.log('connected!')
  const upper = await api.server.procs.uppercase('foo')
  console.log('Upper:', upper)
  console.log('Done!')
  process.exit(0)
}

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
void main()
