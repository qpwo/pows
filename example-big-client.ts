// example-big-client.ts
import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-big-server'
type ClientContext = {
  // ws connection is always available
  // stuff can be added here
}
const api = makeTswsClient<Routes, ClientContext>({
  procs: {
    async approve({ question }, ctx) {
      console.log('Server->client callback. ws =', ctx.ws)
      console.log('Server asked:', question, '– automatically approving!')
      return { approved: true }
    },
  },
  streamers: {},
  url: 'ws://localhost:8080',
})
async function main() {
  await api.connect()
  console.log('connected!')

  const myMsg = 'I expect to get this back'
  try {
    await api.server.procs.errorTest({ msg: myMsg })
  } catch (e) {
    const err = e as Error
    if (err.message === myMsg) {
      console.log('Error test passed:', err.message)
    } else {
      console.error('Error test failed:', err)
      process.exit(1)
    }
  }

  console.log('Square(5):', await api.server.procs.square({ x: 5 }))
  console.log('Who am I?:', await api.server.procs.whoami({}))
  for await (const update of api.server.streamers.doBigJob({})) {
    console.log('Job status:', update)
  }
  console.log('Done!')
  process.exit(0)
}
setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
void main()
