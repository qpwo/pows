// example-big-client.ts
import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-big-server'

// We can define a small "client context" if we want, or just go with {}
type ClientContext = {
  /* your own extra data if needed */
}

const api = makeTswsClient<Routes, ClientContext>(
  {
    // The server calls this as "approve(question: string)".
    // Under the hood it’s actually passing (["question"], realCtx).
    async approve(question) {
      // We can see the raw ws by ignoring TS or by casting:
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      console.log('Server->client callback. ws =', this.ws)
      console.log('Server asked:', question, '– automatically approving!')
      return true
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
  console.log('All done!')
  process.exit(0)
}

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)

void main()
