/* tsws-node-client.ts */

import WebSocket from 'ws'

/**
 * Internal helper: check if something is an async generator.
 */
function isAsyncGenerator(obj: any): obj is AsyncGenerator {
  return obj && typeof obj[Symbol.asyncIterator] === 'function'
}

/**
 * Global request ID for client->server calls.
 */
let globalReqId = 0
function newRequestId() {
  globalReqId++
  return 'cli_' + globalReqId
}

/**
 * Transform user-defined client methods from “nice shape” `(question: string) => boolean`
 * into an internal `(args: unknown[], ctx) => boolean`, plus bind `this` = `ctx`.
 *
 * Also the same for streaming methods (async generators).
 */
function wrapClientHandlers<ClientImpl extends Record<string, any>, Context>(
  rawHandlers: ClientImpl,
): Record<string, (args: unknown[], realCtx: Context) => any> {
  const wrapped: Record<string, any> = {}

  for (const key of Object.keys(rawHandlers)) {
    const userFn = rawHandlers[key]
    if (typeof userFn === 'function') {
      wrapped[key] = function handleRequest(argsArray: unknown[], realCtx: Context) {
        return userFn.apply(realCtx, argsArray)
      }
    }
  }

  return wrapped
}

/**
 * Create a Node.js WebSocket client with typed server calls + typed client handlers.
 */
export function makeTswsClient<
  Routes extends {
    server: { procs: Record<string, any>; streamers: Record<string, any> }
    client: { procs: Record<string, any>; streamers: Record<string, any> }
  },
  Context = Record<string, any>
>(
  /**
   * The client's “nice shape” handlers (what the server can call on the client).
   */
  rawClientHandlers: Partial<Routes['client']['procs'] & Routes['client']['streamers']>,

  options: { url: string },
) {
  let ws: WebSocket
  const wsUrl = options.url

  // Wrap the user’s client handlers so we store them in internal form (args[], ctx).
  const clientHandlers = wrapClientHandlers(rawClientHandlers || {}) as Record<string, any>

  // Map from request ID => {resolve, reject} for client->server calls
  const pendingClientCalls = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()

  // For streaming calls from client->server
  interface StreamState {
    done: boolean
    queue: any[]
    error: any
  }
  const clientStreams = new Map<string, StreamState>()

  /**
   * Build a “server.procs” object so user code calls `api.server.procs.foo(123)`.
   * Internally, we send {args:[123]} to the server.
   */
  function makeServerProcs(): Routes['server']['procs'] {
    return new Proxy({} as Record<string, any>, {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          return new Promise((resolve, reject) => {
            pendingClientCalls.set(id, { resolve, reject })
            ws.send(
              JSON.stringify({
                type: 'proc',
                side: 'server' as const,
                name: methodName,
                id,
                args,
              }),
            )
          })
        }
      },
    }) as Routes['server']['procs']
  }

  /**
   * Build a “server.streamers” so user calls `api.server.streamers.someStream(...)`.
   */
  function makeServerStreamers(): Routes['server']['streamers'] {
    return new Proxy({} as Record<string, any>, {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          const st: StreamState = { done: false, queue: [], error: null }
          clientStreams.set(id, st)

          // Send a "stream_start" message
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              side: 'server',
              name: methodName,
              id,
              args,
            }),
          )

          // Return an async generator
          return (async function* () {
            try {
              while (true) {
                if (st.queue.length > 0) {
                  yield st.queue.shift()
                  continue
                }
                if (st.error) {
                  throw st.error
                }
                if (st.done) {
                  break
                }
                await new Promise(res => setTimeout(res, 50))
              }
            } finally {
              // If consumer stops early, tell server "stream_stop"
              if (!st.done) {
                ws.send(JSON.stringify({ type: 'stream_stop', id }))
              }
            }
          })()
        }
      },
    }) as Routes['server']['streamers']
  }

  const serverProcs = makeServerProcs()
  const serverStreamers = makeServerStreamers()

  /**
   * Handle inbound messages from server -> client.
   */
  function handleMessage(data: WebSocket.Data) {
    let str: string
    if (typeof data === 'string') {
      str = data
    } else {
      str = data.toString()
    }

    let msg: any
    try {
      msg = JSON.parse(str)
    } catch {
      console.error('Client received invalid JSON:', str)
      return
    }

    const { type, side, id, name, args } = msg

    // 1) If it's a response to a client->server call:
    if (type === 'proc_result') {
      const pending = pendingClientCalls.get(id)
      if (!pending) return
      pendingClientCalls.delete(id)
      if ('error' in msg) {
        pending.reject(msg.error)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (type === 'stream_chunk') {
      const st = clientStreams.get(id)
      if (!st) return
      st.queue.push(msg.chunk)
      return
    }

    if (type === 'stream_end') {
      const st = clientStreams.get(id)
      if (!st) return
      if (msg.error) {
        st.error = msg.error
      }
      st.done = true
      return
    }

    // 2) If it's a call from server->client:
    if ((type === 'proc' || type === 'stream_start') && side === 'client') {
      const fn = clientHandlers[name]
      if (typeof fn !== 'function') {
        if (type === 'proc') {
          ws.send(JSON.stringify({ type: 'proc_result', id, error: `No such client proc: ${name}` }))
        } else {
          ws.send(JSON.stringify({ type: 'stream_end', id, error: `No such client streamer: ${name}` }))
        }
        return
      }

      // We'll call it with `(args, context)`, binding `this = context`.
      // Make a minimal "ctx" that includes `ws` for your usage.
      const ctx: Context & { ws: WebSocket } = { ws } as any

      try {
        const result = fn(args, ctx)
        if (isAsyncGenerator(result)) {
          // The client is streaming data back to the server
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
      // The server wants to stop the stream. Not implemented.
      return
    }
  }

  return {
    /**
     * Connect to the server. Resolves once the WS is open.
     */
    connect() {
      return new Promise<void>((resolve, reject) => {
        ws = new WebSocket(wsUrl)
        ws.on('open', () => resolve())
        ws.on('error', err => reject(err))
        ws.on('message', handleMessage)
      })
    },

    /**
     * Expose server calls so user can do `api.server.procs.someMethod(...)`
     * or `api.server.streamers.someStreamer(...)`.
     */
    server: {
      procs: serverProcs,
      streamers: serverStreamers,
    },
  }
}
