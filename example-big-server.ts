// example-big-server.ts
import { makeTswsServer, type RoutesConstraint } from './tsws-node-server'
type Empty = Record<string, never>
export interface Routes {
  server: {
    procs: {
      square(_: { x: number }): Promise<{ result: number }>
      whoami(_: Empty): Promise<{ name: string; userId: number }>
      errorTest(_: {msg: string}): Promise<void>
    }
    streamers: {
      doBigJob(_: Empty): AsyncGenerator<string, void, unknown>
    }
  }
  client: {
    procs: {
      approve(_: { question: string }): Promise<{ approved: boolean }>
    }
    streamers: {}
  }
}
const __: RoutesConstraint = null as unknown as Routes
type ServerContext = {
  // ws connection is always available
  username: string
  userId: number
}
var api = makeTswsServer<Routes, ServerContext>({
  procs: {
    async square({ x }) {
      return { result: x * x }
    },
    async whoami(_, ctx) {
      return {
        name: ctx.username ?? throwErr('No username'),
        userId: ctx.userId ?? throwErr('No userId'),
      }
    },
    async errorTest({msg}) {
      throwErr(msg)
    },
  },
  streamers: {
    async *doBigJob(_, ctx) {
      yield 'Starting...'
      await sleep()
      const { approved } = await ctx.clientProcs.approve({ question: 'Continue with big job?' })
      if (!approved) {
        yield 'Cancelled by user.'
        return
      }
      yield 'Working...'
      await sleep()
      yield 'Done.'
    },
  },
  async onConnection(ctx) {
    console.log('New connection:', ctx.ws)
    if (!ctx.userId) {
      ctx.userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    }
    if (!ctx.username) {
      ctx.username = 'Alice'
    }
  },
})
function throwErr(msg: string) {
  throw new Error(msg)
}
function sleep(ms = 1000) {
  return new Promise(res => setTimeout(res, ms))
}
console.log('starting api')
api.start().then(() => console.log('started!'))
