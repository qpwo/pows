// example-load-server.ts
import { makeTswsServer, type RoutesConstraint } from './tsws-node-server'

// We define our Routes interface with:
// - 2 "normal" server procs (addOne, double)
// - 2 "normal" server streamers (countUp, randomNumbers)
// - 2 client procs (clientProcA, clientProcB)
// - 2 client streamers (clientStreamerX, clientStreamerY)
// - 4 additional server endpoints that invoke each of the 4 client things:
//   callClientProcA, callClientProcB, callClientStreamerX, callClientStreamerY
export interface Routes {
  server: {
    procs: {
      addOne(args: { value: number }): Promise<{ result: number }>
      double(args: { value: number }): Promise<{ result: number }>

      callClientProcA(args: {}): Promise<{ fromClient: any }>
      callClientProcB(args: {}): Promise<{ fromClient: any }>
    }
    streamers: {
      countUp(args: { start: number; end: number }): AsyncGenerator<number, void, unknown>
      randomNumbers(args: { count: number }): AsyncGenerator<number, void, unknown>

      callClientStreamerX(args: {}): AsyncGenerator<any, void, unknown>
      callClientStreamerY(args: {}): AsyncGenerator<any, void, unknown>
    }
  }
  client: {
    procs: {
      clientProcA(args: { ping: string }): Promise<{ pong: string }>
      clientProcB(args: { question: string }): Promise<{ answer: string }>
    }
    streamers: {
      clientStreamerX(args: { hello: string }): AsyncGenerator<string, void, unknown>
      clientStreamerY(args: { data: number[] }): AsyncGenerator<number, void, unknown>
    }
  }
}

const __: RoutesConstraint = null as unknown as Routes

type ServerCtx = {
  // Additional context fields if needed
}

const api = makeTswsServer<Routes, ServerCtx>({
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
      // Yield 'count' random numbers, no sleep
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
