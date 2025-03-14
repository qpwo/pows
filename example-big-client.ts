// example-big-client.ts
import { connectTo } from './tsws-node-client'
import type { Routes } from './example-big-server'

const api = connectTo<Routes, {}>(
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
  setTimeout(() => {
    console.error('timed out after 10 seconds')
    process.exit(1)
  }, 10000)
  await sleep()
  console.log('Square(5):', await api.server.procs.square(5))
  console.log('Who am I?:', await api.server.procs.whoami())

  for await (const update of api.server.streamers.doBigJob()) {
    console.log('Job status:', update)
  }
}

async function sleep({ ms = 1000 } = {}) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

main()
