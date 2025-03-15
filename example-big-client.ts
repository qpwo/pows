// example-big-client.ts
import { makePowsClient } from './pows-node-client'
import { Routes2 } from './example-big-server'

async function main() {
  const api = makePowsClient(Routes2, {
    procs: {
      // Implementation of the client's "approve" callback
      async approve({ question }, ctx) {
        console.log('Server->client callback. ws =', ctx.ws)
        console.log('Server asked:', question, '– automatically approving!')
        return { approved: true }
      },
    },
    streamers: {},
    url: 'ws://localhost:8081',
  })

  await api.connect()
  console.log('connected!')

  // Test error
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

  // Call square(5)
  console.log('Square(5):', await api.server.procs.square({ x: 5 }))

  // Who am I?
  console.log('Who am I?:', await api.server.procs.whoami({}))

  // Now run the big job
  for await (const update of api.server.streamers.doBigJob({})) {
    console.log('Job status:', update)
  }

  console.log('Done!')
  process.exit(0)
}

main()

setTimeout(() => {
  console.error('Timed out after 5 seconds')
  process.exit(1)
}, 5000)
