// example-big-client.ts
import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-big-server'

const api = makeTswsClient<Routes, {}>(
  {
    approve: async question => {
      return confirm(question)
    },
  },
  {
    url: 'ws://localhost:8080',
  },
)

async function main() {
  await api.connect()
  console.log('connected!')
  console.log('Square(5):', await api.server.procs.square(5))
  console.log('Who am I?:', await api.server.procs.whoami())

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update)
  }
}

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
void main()
