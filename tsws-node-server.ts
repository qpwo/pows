// tsws-node-server.ts

import uWS from 'uWebSockets.js'

// A small helper type to detect AsyncGenerators
function isAsyncGenerator(obj: any): obj is AsyncGenerator {
  return obj && typeof obj[Symbol.asyncIterator] === 'function'
}

let globalReqId = 0
function newRequestId() {
  globalReqId++
  return 'srv_' + globalReqId
}

interface TswsServerOptions<Context> {
  port?: number
  /**
   * Called whenever a new client connects. Useful for populating
   * the Context object with user data, etc.
   */
  onConnection?: (
    ctx: Context & {
      ws: uWS.WebSocket
      procs: any
      streamers: any
    },
  ) => void | Promise<void>
}

/**
 * Create a TypeScript WebSocket Server using uWebSockets.js
 *
 * @param handlers An object implementing your `server.procs` and `server.streamers`.
 *   Each key is a function. If the function returns an AsyncGenerator,
 *   it is treated as a streamer. Otherwise, it is treated as a normal RPC.
 * @param options Server options, including port and onConnection callback.
 */
export function makeTswsServer<Routes, Context = Record<string, any>>(
  handlers: Partial<Routes['server']['procs'] & Routes['server']['streamers']>,
  options?: TswsServerOptions<Context>,
) {
  const port = options?.port ?? 8080

  // Store a map from ws to its context object
  const contexts = new WeakMap<uWS.WebSocket, Context & { ws: uWS.WebSocket; procs: any; streamers: any }>()

  // This map tracks requests *from the server to the client* so we can resolve them
  // once we get responses. Keyed by request ID.
  const pendingServerCalls = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()

  /**
   * Build a "client procs" object that the server can use to call
   * the client's `client.procs` methods. Each call returns a Promise.
   */
  function makeClientProcs(ws: uWS.WebSocket) {
    return new Proxy(
      {},
      {
        get(_, methodName: string) {
          // Return a function that, when called, sends a request to the client
          return (...args: any[]) => {
            const reqId = newRequestId()
            return new Promise((resolve, reject) => {
              pendingServerCalls.set(reqId, { resolve, reject })
              const msg = {
                type: 'proc',
                side: 'client' as const, // calling the client's side
                name: methodName,
                id: reqId,
                args,
              }
              ws.send(JSON.stringify(msg))
            })
          }
        },
      },
    )
  }

  /**
   * Build a "client streamers" object if you need streaming calls from server to client
   * (not used in the provided examples, but here for completeness).
   */
  function makeClientStreamers(ws: uWS.WebSocket) {
    return new Proxy(
      {},
      {
        get(_, methodName: string) {
          // Return a function that starts a streaming call to the client
          return (...args: any[]) => {
            // Create an async generator that yields chunks from the client
            const reqId = newRequestId()

            // We'll store a queue of incoming chunks
            let chunkQueue: any[] = []
            let finished = false
            let error: any = null

            // Send the start message
            const startMsg = {
              type: 'stream_start',
              side: 'client' as const,
              name: methodName,
              id: reqId,
              args,
            }
            ws.send(JSON.stringify(startMsg))

            // We also need a way to handle "stop" if the consumer closes early
            function stopStream() {
              if (!finished) {
                finished = true
                const stopMsg = {
                  type: 'stream_stop',
                  id: reqId,
                }
                ws.send(JSON.stringify(stopMsg))
              }
            }

            // Return an async generator
            return (async function* () {
              try {
                while (true) {
                  // If there are queued chunks, shift them out
                  if (chunkQueue.length > 0) {
                    yield chunkQueue.shift()
                    continue
                  }
                  if (error) {
                    throw error
                  }
                  if (finished) {
                    break
                  }

                  // Wait for the next event
                  await new Promise(resolve => setTimeout(resolve, 50))
                }
              } finally {
                stopStream()
              }
            })()
          }
        },
      },
    )
  }

  /**
   * Handle a message *from the client* to the server.
   */
  async function handleMessage(ws: uWS.WebSocket, rawData: ArrayBuffer | string) {
    let str: string
    if (typeof rawData === 'string') {
      str = rawData
    } else {
      str = Buffer.from(rawData).toString('utf8')
    }

    let msg: any
    try {
      msg = JSON.parse(str)
    } catch (err) {
      console.error('Invalid JSON message received:', str)
      return
    }

    const ctx = contexts.get(ws)!
    if (!msg || typeof msg !== 'object') {
      return
    }

    const { type, side, id, name, args } = msg

    // 1. If this is a "proc_result" or "stream_chunk" or "stream_end" from the client
    //    responding to a server->client call, handle that.
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
      // Not used by examples for server->client streaming. You'd collect chunk in a queue here
      // if implementing 2-way streaming. For simplicity, we skip a full example implementation.
      return
    }

    // 2. If this is a "proc" or "stream_start" from the client->server, handle the server's handlers
    if (type === 'proc' && side === 'server') {
      const fn = (handlers as any)[name]
      if (typeof fn !== 'function') {
        // Return an error
        ws.send(JSON.stringify({ type: 'proc_result', id, error: `No such server procedure: ${name}` }))
        return
      }
      try {
        const result = fn(args, ctx)
        if (isAsyncGenerator(result)) {
          // It's a streaming function
          // We'll start streaming back to the client
          const streamId = id
          ;(async () => {
            try {
              for await (const chunk of result) {
                const chunkMsg = {
                  type: 'stream_chunk',
                  id: streamId,
                  chunk,
                }
                ws.send(JSON.stringify(chunkMsg))
              }
              const endMsg = { type: 'stream_end', id: streamId }
              ws.send(JSON.stringify(endMsg))
            } catch (err) {
              const endMsg = { type: 'stream_end', id: streamId, error: String(err) }
              ws.send(JSON.stringify(endMsg))
            }
          })()
        } else {
          // It's a normal (sync or async) function
          Promise.resolve(result)
            .then(res => {
              ws.send(JSON.stringify({ type: 'proc_result', id, result: res }))
            })
            .catch(err => {
              ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
            })
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
      }
      return
    }

    if (type === 'stream_start' && side === 'server') {
      const fn = (handlers as any)[name]
      if (typeof fn !== 'function') {
        // Return an error
        const errMsg = {
          type: 'stream_end',
          id,
          error: `No such server streamer: ${name}`,
        }
        ws.send(JSON.stringify(errMsg))
        return
      }
      try {
        const result = fn(args, ctx)
        if (!isAsyncGenerator(result)) {
          // Not actually a streamer, treat as error
          const errMsg = {
            type: 'stream_end',
            id,
            error: `Handler ${name} is not an async generator`,
          }
          ws.send(JSON.stringify(errMsg))
          return
        }
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
      } catch (err) {
        ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
      }
      return
    }

    if (type === 'stream_stop') {
      // Client requests to stop a streaming. For brevity, not fully handled here.
      // You'd typically want a way to abort the generator or cleanup.
      return
    }
  }

  // Create the uWebSockets.js server
  const app = uWS.App()

  app.ws('/*', {
    open: ws => {
      // Create a fresh context for this connection
      const context = {} as Context & {
        ws: uWS.WebSocket
        procs: Routes['client']['procs']
        streamers: Routes['client']['streamers']
      }
      context.ws = ws
      context.procs = makeClientProcs(ws) as Routes['client']['procs']
      context.streamers = makeClientStreamers(ws) as Routes['client']['streamers']

      contexts.set(ws, context)

      // Let user code populate or handle the context
      if (options?.onConnection) {
        Promise.resolve(options.onConnection(context)).catch(err => {
          console.error('onConnection error:', err)
        })
      }
    },

    message: (ws, message, isBinary) => {
      handleMessage(ws, message).catch(err => {
        console.error('Failed to handle message:', err)
      })
    },

    close: ws => {
      contexts.delete(ws)
    },
  })

  return {
    /**
     * Start listening on the configured port
     */
    start() {
      return new Promise<void>((resolve, reject) => {
        app.listen(port, token => {
          if (!token) {
            reject(new Error('Failed to listen on port ' + port))
          } else {
            resolve()
          }
        })
      })
    },
  }
}
