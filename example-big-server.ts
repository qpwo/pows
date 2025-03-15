// example-big-server.ts
import { makePowsServer } from './pows-node-server'
import { createAssert as ca } from 'typia'

type Empty = Record<string, never>

/**
 * "Big" routes example. The server has 3 procs and 1 streamer; the client
 * has 1 proc for callbacks. Each route is [ inAssert, outAssert ] or
 * [ inAssert, chunkAssert ] for streamers.
 */
export const Routes2 = {
  server: {
    procs: {
      square: [ca<{ x: number }>(), ca<{ result: number }>()],
      whoami: [ca<Empty>(), ca<{ name: string; userId: number }>()],
      errorTest: [ca<{ msg: string }>(), ca<Empty>()],
    },
    streamers: {
      doBigJob: [ca<Empty>(), ca<string>()],
    },
  },
  client: {
    procs: {
      approve: [ca<{ question: string }>(), ca<{ approved: boolean }>()],
    },
    streamers: {},
  },
} as const

/**
 * Our server can store some context for each connection:
 */
type ServerContext = {
  username?: string
  userId?: number
}

/**
 * Implement the server logic:
 */
const api = makePowsServer<typeof Routes2, ServerContext>(Routes2, {
  procs: {
    async square({ x }, ctx) {
      return { result: x * x }
    },
    async whoami(_args, ctx) {
      if (!ctx.username) throw new Error('No username')
      if (!ctx.userId) throw new Error('No userId')
      return { name: ctx.username, userId: ctx.userId }
    },
    async errorTest({ msg }) {
      throw new Error(msg)
    },
  },
  streamers: {
    async *doBigJob(_args, ctx) {
      yield 'Starting...'
      await sleep()
      // call the client’s "approve" proc
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
    console.log('New connection arrived.')
    // For demonstration, we'll assign some defaults:
    ctx.username = 'Alice'
    ctx.userId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
  },
  port: 8081,
})

function sleep(ms = 1000) {
  return new Promise(res => setTimeout(res, ms))
}

/**
 * Only start the server if this file is run directly.
 */
if (require.main === module) {
  console.log('starting api')
  api.start().then(() => console.log('started!'))
}
