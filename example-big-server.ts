// example-big-server.ts
import { makeTswsServer } from './tsws-node-server'

// Keep the route interfaces simple: no array-destructuring, no explicit ctx
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

// The server's context—no mention of ws, we just do userName/userId:
type ServerContext = {
  userName?: string
  userId?: number
}

const api = makeTswsServer<Routes, ServerContext>(
  {
    // The library forcibly transforms this at runtime
    // from (x) => ... into (args:[x], ctx) => ...
    async square(x) {
      return x * x
    },

    async whoami() {
      // "this" inside here will actually be "Context & {ws, procs, ...}"
      // But you can do a quick cast if you want TS to hush:
      const c = this as ServerContext & { ws: unknown }
      return {
        name: c.userName ?? 'Unknown',
        userId: c.userId ?? null,
      }
    },

    async *doBigJob() {
      yield 'Starting...'
      await sleep()

      // The library merges in `procs` so that you can do:
      //   this.procs.approve(...)
      // We'll @ts-expect-error to hush TS about "this" shape.
      // Or do a cast like above if you prefer.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      const ok = await this.procs.approve('Continue with big job?')
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
      console.log('New connection; raw ws:', ctx.ws) // type-safely available
      // Fill the userName/userId in the context
      if (!ctx.userId) {
        ctx.userId = Math.floor(Math.random() * 999999999)
      }
      if (!ctx.userName) {
        ctx.userName = 'Alice'
      }
    },
  },
)

function sleep(ms = 500) {
  return new Promise(res => setTimeout(res, ms))
}

console.log('starting api on :8080')
api.start().then(() => console.log('started!'))
