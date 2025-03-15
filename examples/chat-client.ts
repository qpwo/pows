import { makePowsClient } from 'pows/node-client'
import { ChatRoutes } from './chat-server'
import { spawn } from 'child_process'

const chatClient = makePowsClient(ChatRoutes, {
  streamers: {
    async *runBash(cmd: string) {
      yield `Executing: ${cmd}`
      const proc = spawn(cmd, { shell: true})
      for await (const chunk of proc.stdout) {
        yield chunk.toString()
      }
      for await (const chunk of proc.stderr) {
        yield chunk.toString()
      }
      yield `Finished: ${cmd}`
    },
  },
  procs: {},
  url: 'ws://localhost:8080',
})

const api = chatClient.server

async function main() {
  await chatClient.connect()
  console.log('Connected!')

  // Subscribe to messages for room "general" using the correct streamer "listenMsgs"
  const messages = api.streamers.listenMsgs('general')
  ;(async () => {
    for await (const msg of messages) {
      console.log(msg)
    }
  })()

  // Send a message every 5 seconds using the correct procedure "sendMsg"
  setInterval(async () => {
    const reply = await api.procs.sendMsg(`Hello at ${new Date().toLocaleTimeString()}`)
    console.log(`Sent message id: ${reply.msgId}`)
  }, 5000)
}

void main()
