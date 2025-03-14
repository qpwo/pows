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

  const myMsg = 'You should have got an error'
  try {
    await api.server.procs.errorTest({})
    throw new Error(myMsg)
  } catch (err_) {
    const err = err_ as Error
    if (err.message !== myMsg) {
      console.log("Got error yay", err.message)
    } else {
      console.error('Error not thrown as expected:', err.message)
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
