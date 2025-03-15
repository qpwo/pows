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

if (process.argv.at(-1)?.split('.')?.at(-2)?.endsWith('server')) {
  chatServer.start().then(() => console.log('Server started on 8080'))
}
