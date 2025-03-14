/* tsws-node-server.ts */

import uWS from 'uWebSockets.js'

/**
 * Internal helper: check if a given object is an async generator.
 */
function isAsyncGenerator(obj: any): obj is AsyncGenerator {
  return obj && typeof obj[Symbol.asyncIterator] === 'function'
}

/**
 * Global server request ID generator, used for server->client calls.
 */
let globalReqId = 0
function newRequestId() {
  globalReqId++
  return 'srv_' + globalReqId
}

/**
 * Options for the server.
 */
export interface TswsServerOptions<Context> {
  /**
   * Port to listen on (default 8080).
   */
  port?: number

  /**
   * Called whenever a new client connects. You can initialize
   * the `ctx` here. We also provide `ctx.ws`, `ctx.procs`, and `ctx.streamers`
   * for calling the client's side (like `ctx.procs.someMethod()`).
   */
  onConnection?: (
    ctx: Context & {
      ws: uWS.WebSocket<unknown>
      procs: Record<string, any>
      streamers: Record<string, any>
    },
  ) => void | Promise<void>
}

/**
 * Transforms user-defined server methods from the “nice shape”
 *   `(x: number) => Promise<number>`
 * into an “internal shape”
 *   `([x], ctx) => Promise<number>`, plus rebinds `this` to `ctx`.
 *
 * We do this so the user can define normal TypeScript method signatures,
 * but internally, we handle passing arrays and context around.
 */
function wrapServerHandlers<ServerImpl extends Record<string, any>, Context>(
  rawHandlers: ServerImpl,
): Record<string, (args: unknown[], realCtx: Context) => any> {
  const wrapped: Record<string, any> = {}

  for (const key of Object.keys(rawHandlers)) {
    const userFn = rawHandlers[key]
    if (typeof userFn === 'function') {
      wrapped[key] = function handleRequest(argsArray: unknown[], realCtx: Context) {
        // We'll apply the user function with those arguments, but also bind `this = realCtx`.
        // Because TS does not like reassigning `this`, we do an @ts-expect-error:
        // (We do the call twice so we can handle if it's an async generator.)
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        return userFn.apply(realCtx, argsArray)
      }
    }
  }

  return wrapped
}

/**
 * Generic definition:
 *   Routes: { server: { procs: ..., streamers: ... }, client: { procs: ..., streamers: ... } }
 *   Context: Additional data you want on the server side (like user info).
 */
export function makeTswsServer<
  Routes extends {
    server: { procs: Record<string, any>; streamers: Record<string, any> }
    client: { procs: Record<string, any>; streamers: Record<string, any> }
  },
  Context = Record<string, any>
>(
  /**
   * User-defined server methods in their “nice shape.”
   * We'll convert them internally to (args, ctx).
   */
  rawHandlers: Partial<Routes['server']['procs'] & Routes['server']['streamers']>,

  options?: TswsServerOptions<Context>,
) {
  const port = options?.port ?? 8080

  // Wrap the user handlers so we store them in a shape where each function is (args, ctx).
  const handlers = wrapServerHandlers(rawHandlers || {}) as Record<string, any>

  /**
   * We keep a WeakMap from the `WebSocket` to the combined context object,
   * which includes your custom `Context` plus `.ws`, `.procs`, `.streamers`.
   */
  const contexts = new WeakMap<
    uWS.WebSocket<unknown>,
    Context & {
      ws: uWS.WebSocket<unknown>
      procs: Routes['client']['procs']
      streamers: Routes['client']['streamers']
    }
  >()

  /**
   * When the server calls the client (`ctx.procs.foo(...)`),
   * we store the pending call in this map so we can resolve it upon reply.
   */
  const pendingServerCalls = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()

  /**
   * Build a "client procs" object so the server can call
   * `ctx.procs.someClientMethod(...)`.
   */
  function makeClientProcs(ws: uWS.WebSocket<unknown>): Routes['client']['procs'] {
    // We cast to `any` inside the Proxy, then return the typed object at the end.
    return new Proxy({} as Record<string, any>, {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const reqId = newRequestId()
          return new Promise((resolve, reject) => {
            pendingServerCalls.set(reqId, { resolve, reject })
            const message = {
              type: 'proc',
              side: 'client' as const,
              name: methodName,
              id: reqId,
              args,
            }
            ws.send(JSON.stringify(message))
          })
        }
      },
    }) as Routes['client']['procs']
  }

  /**
   * Build a "client streamers" object so the server can start
   * streaming calls to the client. Not fully implemented for chunk handling,
   * but enough for demonstration.
   */
  function makeClientStreamers(ws: uWS.WebSocket<unknown>): Routes['client']['streamers'] {
    return new Proxy({} as Record<string, any>, {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const reqId = newRequestId()

          // Send "stream_start"
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              side: 'client',
              name: methodName,
              id: reqId,
              args,
            }),
          )

          // Return a minimal async generator that would yield chunks from the client
          let finished = false
          let error: any = null
          let queue: any[] = []

          function stop() {
            if (!finished) {
              finished = true
              ws.send(JSON.stringify({ type: 'stream_stop', id: reqId }))
            }
          }

          // We won't show client->server chunk handling here for brevity.
          return (async function* () {
            try {
              while (true) {
                if (queue.length > 0) {
                  yield queue.shift()
                  continue
                }
                if (error) throw error
                if (finished) break
                await new Promise(res => setTimeout(res, 50))
              }
            } finally {
              stop()
            }
          })()
        }
      },
    }) as Routes['client']['streamers']
  }

  /**
   * Handle an incoming message from the client -> server.
   */
  async function handleMessage(ws: uWS.WebSocket<unknown>, rawData: ArrayBuffer | string) {
    const str = typeof rawData === 'string' ? rawData : Buffer.from(rawData).toString('utf8')

    let msg: any
    try {
      msg = JSON.parse(str)
    } catch {
      console.error('Invalid JSON from client:', str)
      return
    }
    if (!msg || typeof msg !== 'object') return

    const ctx = contexts.get(ws)
    if (!ctx) return

    const { type, side, id, name, args } = msg

    // 1) If this is a response to a server->client call:
    if (type === 'proc_result') {
      const pending = pendingServerCalls.get(id)
      if (!pending) return
      pendingServerCalls.delete(id)
      if ('error' in msg) {
        pending.reject(msg.error)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (type === 'stream_chunk' || type === 'stream_end') {
      // Not fully shown for server->client streaming
      return
    }

    // 2) If this is a client->server request:
    if ((type === 'proc' || type === 'stream_start') && side === 'server') {
      const fn = handlers[name]
      if (typeof fn !== 'function') {
        // No such handler
        if (type === 'proc') {
          ws.send(JSON.stringify({ type: 'proc_result', id, error: `No server procedure: ${name}` }))
        } else {
          ws.send(JSON.stringify({ type: 'stream_end', id, error: `No server streamer: ${name}` }))
        }
        return
      }

      // We call the wrapped function (args[], ctx).
      try {
        const result = fn(args, ctx)
        // If it’s an async generator, we stream results
        if (isAsyncGenerator(result)) {
          ;(async () => {
            try {
              for await (const chunk of result) {
                ws.send(JSON.stringify({ type: 'stream_chunk', id, chunk }))
              }
              ws.send(JSON.stringify({ type: 'stream_end', id }))
            } catch (err) {
              ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
            }
          })()
        } else {
          // Normal function (sync or async)
          Promise.resolve(result)
            .then(res => {
              ws.send(JSON.stringify({ type: 'proc_result', id, result: res }))
            })
            .catch(err => {
              ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
            })
        }
      } catch (err) {
        if (type === 'proc') {
          ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
        } else {
          ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
        }
      }
      return
    }

    if (type === 'stream_stop') {
      // Client wants to stop a stream. Not fully handled here.
      return
    }
  }

  // Create the uWS.App
  const app = uWS.App()

  app.ws('/*', {
    open: ws => {
      // Build a context object for this connection
      const context = {} as Context & {
        ws: uWS.WebSocket<unknown>
        procs: Routes['client']['procs']
        streamers: Routes['client']['streamers']
      }
      context.ws = ws
      context.procs = makeClientProcs(ws)
      context.streamers = makeClientStreamers(ws)

      contexts.set(ws, context)

      // Call user’s onConnection
      if (options?.onConnection) {
        Promise.resolve(options.onConnection(context)).catch(err => {
          console.error('onConnection error:', err)
        })
      }
    },

    message: (ws, message, isBinary) => {
      handleMessage(ws, message).catch(err => {
        console.error('Error handling client message:', err)
      })
    },

    close: ws => {
      contexts.delete(ws)
    },
  })

  return {
    /**
     * Start listening on the configured port.
     */
    start() {
      return new Promise<void>((resolve, reject) => {
        app.listen(port, token => {
          if (!token) {
            reject(new Error(`Failed to listen on port ${port}`))
          } else {
            resolve()
          }
        })
      })
    },
  }
}
