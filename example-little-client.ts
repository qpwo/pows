// example-little-client.ts
import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-little-server'
const api = makeTswsClient<Routes>({
  procs: {},
  streamers: {},
  url: 'ws://localhost:8080',
})
async function main() {
  await api.connect()
  const { result } = await api.server.procs.uppercase({ s: 'foo' })
  console.log('Upper:', result)
  console.log('Done!')
  process.exit(0)
}
setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
void main()
