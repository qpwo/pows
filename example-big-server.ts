// example-big-server.ts
import { startServer, callClientProc } from './tsws-node-server'

/**
 * Declare our routes (server side + client side).
 */
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

/**
 * Our custom server context fields (put anything you need here).
 */
type MyServerContext = {
  userName: string
  userId: number | null
}

/**
 * Start the server, providing implementations for the server's procs/streamers.
 */
startServer<Routes, MyServerContext>(
  {
    // Implementation of server procs:
    async square([x], ctx) {
      // x is a number (the client calls `api.server.procs.square(5)`)
      return x * x
    },

    async whoami(_args, ctx) {
      // Return info from our context
      return { name: ctx.extra.userName, userId: ctx.extra.userId }
    },

    async *doBigJob(_args, ctx) {
      yield 'Starting...'
      await sleep()

      // Example: server calls back the client to ask for approval
      const ok = await callClientProc<Routes, MyServerContext, 'approve'>(ctx, 'approve', ['Continue with big job?'])
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
    // Provide optional middleware to set up `ctx.extra`
    middleware: [
      async (ctx, next) => {
        ctx.extra.userId = 123
        ctx.extra.userName = 'Alice'
        await next()
      },
    ],
  },
)

/** Utility sleep function. */
function sleep(ms = 1000) {
  return new Promise(res => setTimeout(res, ms))
}
