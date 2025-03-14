// example-big-server.ts
import { makeTswsServer } from './tsws-node-server'

export interface Routes {
  server: {
    procs: {
      square(x: number): Promise<number>
      whoami(): Promise<{ name: string; userId: number | null }>
    }
    streamers: {
      doBigJob(): AsyncGenerator<string, void, unknown>
    }
  }
  client: {
    procs: {
      approve(question: string): Promise<boolean>
    }
    streamers: {}
  }
}

type ServerContext = {
  userName: string
  userId: number
}

var api = makeTswsServer<Routes, ServerContext>(
  {
    square: async x => {
      return x * x
    },

    whoami: async (_, ctx) => {
      return { name: ctx.userName, userId: ctx.userId }
    },

    doBigJob: async function* (_, ctx) {
      yield 'Starting...'
      await sleep()

      const ok = await ctx.procs.approve('Continue with big job?')
      if (!ok) {
        yield 'Cancelled by user.'
        return
      }

      yield 'Working...'
      await sleep()

      yield 'Done.'
    },
  },
  {
    async onConnection(ctx) {
      console.log('Got request on connection:', ctx.ws)
      if (!ctx.userId) {
        const cookie = ctx.req.headers.cookie?.match(/userId=(\d+)/)?.[1]
        if (cookie) {
          ctx.userId = parseInt(cookie, 10)
        } else {
          ctx.userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
        }
      }
      if (!ctx.userName) {
        ctx.userName = 'Alice'
      }
    },
  },
)

function sleep(ms = 1000) {
  return new Promise(res => setTimeout(res, ms))
}

console.log('starting api')
api.start().then(() => console.log('started!'))
