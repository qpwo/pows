// little-client.ts
import { makePowsClient } from 'pows/node-client'
import { Routes } from './little-server' // same Routes object

async function main() {
  const api = makePowsClient(Routes, {
    procs: {},
    streamers: {},
    url: 'ws://localhost:8080',
  })

  await api.connect()
  const { result } = await api.server.procs.uppercase({ s: 'foo' })
  console.log('Upper:', result)
  console.log('Done!')
  process.exit(0)
}

main()

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
