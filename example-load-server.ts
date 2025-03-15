// example-load-server.ts
import { makeTswsServer } from './tsws-node-server'
import { createAssert as ca } from 'typia'

/**
 * We define a single "Routes" object, describing both server and client routes.
 * Each route is a tuple [ inputAssert, outputAssert ] for procs,
 * or [ inputAssert, chunkAssert ] for streamers.
 */
export const Routes = {
  server: {
    procs: {
      // addOne({ value: number }): Promise<{ result: number }>
      addOne: [ca<{ value: number }>(), ca<{ result: number }>()],

      // double({ value: number }): Promise<{ result: number }>
      double: [ca<{ value: number }>(), ca<{ result: number }>()],

      // callClientProcA({}): Promise<{ fromClient: any }>
      callClientProcA: [ca<{}>(), ca<{ fromClient: any }>()],

      // callClientProcB({}): Promise<{ fromClient: any }>
      callClientProcB: [ca<{}>(), ca<{ fromClient: any }>()],
    },
    streamers: {
      // countUp({ start: number; end: number }): yields number
      countUp: [ca<{ start: number; end: number }>(), ca<number>()],

      // randomNumbers({ count: number }): yields number
      randomNumbers: [ca<{ count: number }>(), ca<number>()],

      // callClientStreamerX({}): yields any
      callClientStreamerX: [ca<{}>(), ca<any>()],

      // callClientStreamerY({}): yields any
      callClientStreamerY: [ca<{}>(), ca<any>()],
    },
  },
  client: {
    procs: {
      // clientProcA({ ping: string }): Promise<{ pong: string }>
      clientProcA: [ca<{ ping: string }>(), ca<{ pong: string }>()],

      // clientProcB({ question: string }): Promise<{ answer: string }>
      clientProcB: [ca<{ question: string }>(), ca<{ answer: string }>()],
    },
    streamers: {
      // clientStreamerX({ hello: string }): yields string
      clientStreamerX: [ca<{ hello: string }>(), ca<string>()],

      // clientStreamerY({ data: number[] }): yields number
      clientStreamerY: [ca<{ data: number[] }>(), ca<number>()],
    },
  },
} as const

/**
 * If you want a custom server context, declare here.
 */
type ServerCtx = {
  // Additional fields if needed
}

const api = makeTswsServer(Routes, {
  procs: {
    async addOne({ value }) {
      return { result: value + 1 }
    },
    async double({ value }) {
      return { result: value * 2 }
    },

    // These call back to the client's procs
    async callClientProcA(_args, ctx) {
      const fromClient = await ctx.clientProcs.clientProcA({ ping: 'Hello from server' })
      return { fromClient }
    },
    async callClientProcB(_args, ctx) {
      const fromClient = await ctx.clientProcs.clientProcB({ question: 'Are we good?' })
      return { fromClient }
    },
  },

  streamers: {
    async *countUp({ start, end }) {
      // Yield integers from start to end, no sleep
      for (let i = start; i <= end; i++) {
        yield i
      }
    },
    async *randomNumbers({ count }) {
      // Yield 'count' random numbers
      for (let i = 0; i < count; i++) {
        yield Math.random()
      }
    },

    // These call back to the client's streamers
    async *callClientStreamerX(_args, ctx) {
      const clientGen = ctx.clientStreamers.clientStreamerX({ hello: 'Hi from server' })
      for await (const chunk of clientGen) {
        yield chunk
      }
    },
    async *callClientStreamerY(_args, ctx) {
      const clientGen = ctx.clientStreamers.clientStreamerY({ data: [1, 2, 3] })
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
