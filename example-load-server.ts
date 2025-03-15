// example-load-server.ts
import { makeTswsServer } from './tsws-node-server'
import { createAssert as ca } from 'typia'

/**
 * We define a single "Routes" object, describing both server and client routes.
 * Each route is a tuple [ inputAssert, outputAssert ] for procs,
 * or [ inputAssert, chunkAssert ] for streamers.
 *
 * Wherever an object had a single property, we've replaced it with just the
 * property's type. Multi-property objects or zero-property objects remain as-is.
 */
export const Routes = {
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

const api = makeTswsServer<typeof Routes, ServerCtx>(Routes, {
  procs: {
    async addOne(value) {
      // Now we receive `value` as a number directly and return a number.
      return value + 1
    },
    async double(value) {
      return value * 2
    },

    // These call back to the client's procs
    async callClientProcA(_args, ctx) {
      // We call the client's procA with a string (since its signature is now (ping: string) => string).
      const fromClient = await ctx.clientProcs.clientProcA('Hello from server')
      // Our route says we return `any`, so we can just return the string.
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
    async *randomNumbers(count: number) {
      // Yield 'count' random numbers
      for (let i = 0; i < count; i++) {
        yield Math.random()
      }
    },

    // These call back to the client's streamers
    async *callClientStreamerX(_args, ctx) {
      // The client streamer X now takes a string input
      const clientGen = ctx.clientStreamers.clientStreamerX('Hi from server')
      for await (const chunk of clientGen) {
        yield chunk
      }
    },
    async *callClientStreamerY(_args, ctx) {
      // The client streamer Y now takes an array of numbers as input
      const clientGen = ctx.clientStreamers.clientStreamerY([1, 2, 3])
      for await (const chunk of clientGen) {
        yield chunk
      }
    },
  },

  port: 8080,
  onConnection() {
    console.log('New connection established on server.')
  },
})

console.log('Starting load server on port 8080...')
api.start().then(() => {
  console.log('Load server started!')
})
