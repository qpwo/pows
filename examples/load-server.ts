// load-server.ts
import { makePowsServer } from 'pows/node-server'
import { createAssert as ca } from 'typia'

/**
 * We define a single "Routes3" object, describing both server and client routes.
 * Each route is a tuple [ inputAssert, outputAssert ] or
 * [ inputAssert, chunkAssert ] for streamers.
 */
export const Routes3 = {
  server: {
    procs: {
      addOne: [ca<number>(), ca<number>()],
      double: [ca<number>(), ca<number>()],
      callClientProcA: [ca<{}>(), ca<any>()],
      callClientProcB: [ca<{}>(), ca<any>()],
    },
    streamers: {
      countUp: [ca<{ start: number; end: number }>(), ca<number>()],
      randomNumbers: [ca<number>(), ca<number>()],
      callClientStreamerX: [ca<{}>(), ca<any>()],
      callClientStreamerY: [ca<{}>(), ca<any>()],
    },
  },
  client: {
    procs: {
      clientProcA: [ca<string>(), ca<string>()],
      clientProcB: [ca<string>(), ca<string>()],
    },
    streamers: {
      clientStreamerX: [ca<string>(), ca<string>()],
      clientStreamerY: [ca<number[]>(), ca<number>()],
    },
  },
} as const

/**
 * If you want a custom server context, declare here.
 */
type ServerCtx = {
  // Additional fields if needed
}

const api = makePowsServer<typeof Routes3, ServerCtx>(Routes3, {
  procs: {
    async addOne(value) {
      return value + 1
    },
    async double(value) {
      return value * 2
    },

    // These call back to the client's procs
    async callClientProcA(_args, ctx) {
      const fromClient = await ctx.clientProcs.clientProcA('Hello from server')
      return fromClient
    },
    async callClientProcB(_args, ctx) {
      const fromClient = await ctx.clientProcs.clientProcB('Are we good?')
      return fromClient
    },
  },

  streamers: {
    async *countUp({ start, end }) {
      // Yield integers from start to end, no sleep
      for (let i = start; i <= end; i++) {
        yield i
      }
    },
    async *randomNumbers(count) {
      // Yield 'count' random numbers
      for (let i = 0; i < count; i++) {
        yield Math.random()
      }
    },

    // These call back to the client's streamers
    async *callClientStreamerX(_args, ctx) {
      const clientGen = ctx.clientStreamers.clientStreamerX('Hi from server')
      for await (const chunk of clientGen) {
        yield chunk
      }
    },
    async *callClientStreamerY(_args, ctx) {
      const clientGen = ctx.clientStreamers.clientStreamerY([1, 2, 3])
      for await (const chunk of clientGen) {
        yield chunk
      }
    },
  },

  port: 8082,
  onConnection() {
    console.log('New connection established on server.')
  },
})

if (process.argv.at(-1)?.split('.')?.at(-2)?.endsWith('server')) {
  console.log('Starting load server on port 8080...')
  api.start().then(() => {
    console.log('Load server started!')
  })
}
