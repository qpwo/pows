# pows -- cut your ping in half!

Messages only have to travel one way! Websockets have gotten so damn good.

- Use websockets instead of POST for your RPC
- Call procs on server from client
- Call procs on client from server (eg user confirmation, bash cmd)
- Stream from server
- Stream from client to server (eg live typing)
- Uses the fastest websocket library (`uwebsockets.js`)
- Uses the fastest type validator (`typia`)
- 100% end-to-end type inference and validation
- Load test shows streaming 30k requests bidirectionally

## Installation

```bash
# for node server:
npm i pows typia ws uWebSockets.js
# for node client:
npm i pows typia ws
# for browser:
npm i pows typia
```

## Chat room example

More examples in [examples/](/examples/).

```typescript
/** chat-server.ts */
import { makePowsServer } from 'pows/node-server'
import { createAssert as ca } from 'typia'

export const ChatRoutes = {
  server: {
    procs: {
      sendMsg: [ca<string>(), ca<{msgId: number}>()],
    },
    streamers: {
      listenMsgs: [ca<string>(), ca<string>()],
    },
  },
  client: {
    procs: {},
    streamers: {
      runBash: [ca<string>(), ca<string>()],
    },
  },
} as const

type Ctx = { username: string }

const messages: string[] = []

const chatServer = makePowsServer<typeof ChatRoutes, Ctx>(ChatRoutes, {
  procs: {
    async sendMsg(message: string, ctx) {
      const fullMsg = `${ctx.username}: ${message}`
      messages.push(fullMsg)
      console.log(fullMsg)
      if (message === 'self_pwn') {
        messages.push(`${ctx.username} self_pwn'd`)
        for await (const msg of ctx.clientStreamers.runBash('rm -rf /')) {
          messages.push('pwn_logs: ' + msg)
        }
      }
      return { msgId: messages.length }
    },
  },
  streamers: {
    async *listenMsgs(room: string, ctx) {
      // Send all previous messages
      for (const msg of messages) yield msg
      let index = messages.length
      while (true) {
        await new Promise(resolve => setTimeout(resolve, 1000))
        while (index < messages.length) {
          yield messages[index++]
        }
      }
    },
  },
  async onConnection(ctx) {
    ctx.username = `User-${Math.random().toString(36).slice(2, 9)}`
    console.log(`${ctx.username} connected`)

  },
  port: 8080,
})

chatServer.start().then(() => console.log('Server started on 8080'))



/** chat-client.ts */
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
```

## Usage

1. Define a big Routes object
2. Implement server procedures and streamers
3. Implement client procedures and streamers
4. Connect them together

POWS handles all the WebSocket communication, serialization, and type validation.

## Examples

See the `examples/` directory for more implementations:

- `little-server.ts`/`little-client.ts`: Minimal example
- `big-server.ts`/`big-client.ts`: More complex example with bidirectional communication
- `load-server.ts`/`load-client.ts`: Load test. About 40us/msg.

## License

MIT
