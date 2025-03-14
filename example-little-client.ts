// example-little-client.ts

import { connectTo } from './tsws-node-client'
import type { Routes } from './example-little-server'

async function main() {
  const api = connectTo<Routes>({}, { url: 'ws://localhost:8080' })
  await sleep()
  const upper = await api.server.procs.uppercase('foo')
  console.log('Upper:', upper)
  console.log('it works!')
  process.exit(0)
}
async function sleep({ ms = 1000 } = {}) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
main()
