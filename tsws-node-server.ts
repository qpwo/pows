// tsws-node-server.ts

import { App, WebSocket, us_listen_socket, us_listen_socket_close } from 'uWebSockets.js'

type TswsMiddleware<Ctx> = (ctx: {
  rawSocket: WebSocket
  /** The upgrade request is available via (rawSocket as any).upgradeReq, if needed. */
}, next: () => Promise<void>) => Promise<void> | void

/**
 * We define the shape of how we store server-side procs & streamers:
 *   - procs: simpler calls returning a single result
 *   - streamers: calls returning an AsyncGenerator
 */
interface TswsServerSide<Routes, Ctx> {
  procs: {
    [K in keyof Routes]: (
      args: unknown[],
      ctx: Ctx
    ) => Promise<unknown> | unknown
  }
  streamers: {
    [K in keyof Routes]: (
      args: unknown[],
      ctx: Ctx
    ) => AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
  }
}

/**
 * We'll define a generic message shape for our WS protocol.
 */
type TswsMessage =
  | {
      type: 'rpc'; // request for a single-value result
      route: 'server' | 'client';
      id: string;
      procName: string;
      args: unknown[];
    }
  | {
      type: 'rpc_result'; // single-value result
      id: string;
      success?: unknown;
      error?: string;
    }
  | {
      type: 'stream_start'; // request to start streaming
      route: 'server' | 'client';
      id: string;
      procName: string;
      args: unknown[];
    }
  | {
      type: 'stream_next'; // next value from a stream
      id: string;
      value: unknown;
    }
  | {
      type: 'stream_error'; // error in a stream
      id: string;
      error: string;
    }
  | {
      type: 'stream_complete'; // stream completed
      id: string;
    };

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Makes a typed server that listens on a given port (or config).
 *
 * @param serverImpl - an object with your server procs/streamers
 * @param config - e.g. { port: number; middleware?: TswsMiddleware<Ctx>[] }
 * @returns an object with `start()`, `stop()`, and a `client` object
 */
export function makeTswsServer<
  Routes extends {
    server: {
      procs: Record<string, (...args: any) => any>
      streamers: Record<string, (...args: any) => AsyncGenerator<any, any, any>>
    }
    client: {
      procs: Record<string, (...args: any) => any>
      streamers: Record<string, (...args: any) => AsyncGenerator<any, any, any>>
    }
  },
  Ctx extends Record<string, any> = {}
>(
  serverImpl: Partial<Routes['server']['procs']> &
    Partial<Routes['server']['streamers']>,
  config?: {
    port?: number
    middleware?: TswsMiddleware<Ctx>[]
    /** Called once on server start success. */
    onStarted?: (port: number) => void
  }
) {
  const port = config?.port ?? 8080
  const middleware = config?.middleware ?? []

  // We separate procs vs streamers
  const serverProcs: TswsServerSide<Routes['server']['procs'], Ctx>['procs'] = {}
  const serverStreamers: TswsServerSide<Routes['server']['streamers'], Ctx>['streamers'] =
    {}

  // Identify which user-provided functions are async generator vs normal
  for (const [key, fn] of Object.entries(serverImpl)) {
    if (typeof fn === 'function') {
      // naive check for AsyncGenerator by looking at `fn.constructor.name`
      const isGenerator =
        fn.constructor.name === 'AsyncGeneratorFunction' ||
        fn.constructor.name === 'GeneratorFunction'
      if (isGenerator) {
        // streamer
        serverStreamers[key] = fn as any
      } else {
        // proc
        serverProcs[key] = fn as any
      }
    }
  }

  let listenSocket: us_listen_socket | null = null

  // We track the "most recent" connection for the server to call "client.*" on
  let currentClientSocket: WebSocket | null = null

  // For in-flight calls from server to client:
  const serverPendingRequests = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()
  // For in-flight streams from server to client:
  interface OutboundStream {
    generator: AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
    cancel?: () => void
  }
  const serverOutboundStreams = new Map<string, OutboundStream>()

  // For inbound calls from the client:
  //   We track in-progress streams that the client is pulling from the server
  const serverInboundStreams = new Map<
    string,
    AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
  >()

  // Create our client object so that the server can call `client.procs.*` or `client.streamers.*`
  const client = {
    procs: new Proxy(
      {},
      {
        get(_target, prop: string) {
          // Return a function that calls the remote client method
          return async (...args: unknown[]) => {
            if (!currentClientSocket) {
              throw new Error('No client is currently connected.')
            }
            const id = newId()
            return new Promise((resolve, reject) => {
              serverPendingRequests.set(id, { resolve, reject })
              const msg: TswsMessage = {
                type: 'rpc',
                route: 'client',
                id,
                procName: prop,
                args,
              }
              currentClientSocket.send(JSON.stringify(msg))
            })
          }
        },
      }
    ) as Routes['client']['procs'],
    streamers: new Proxy(
      {},
      {
        get(_target, prop: string) {
          // Return a function that starts a remote streaming call
          return (...args: unknown[]) => {
            if (!currentClientSocket) {
              throw new Error('No client is currently connected.')
            }
            const id = newId()
            // Create an async generator that yields as we get data
            const asyncGen = (async function* () {
              // Send start request
              const msg: TswsMessage = {
                type: 'stream_start',
                route: 'client',
                id,
                procName: prop,
                args,
              }
              currentClientSocket.send(JSON.stringify(msg))

              let done = false
              const queue: { value: unknown; done?: boolean }[] = []
              let onData: (() => void) | null = null
              let error: any = null

              // We store a listener so that incoming messages for this stream
              // are pushed in the queue
              const listener = {
                next: (val: unknown) => {
                  queue.push({ value: val })
                  onData?.()
                },
                error: (err: any) => {
                  error = err
                  done = true
                  onData?.()
                },
                complete: () => {
                  done = true
                  onData?.()
                },
              }

              serverOutboundStreams.set(id, {
                generator: null as any, // not used for outbound
                cancel: () => {
                  done = true
                  onData?.()
                },
              } as OutboundStream)

              try {
                while (!done) {
                  if (!queue.length && !error) {
                    await new Promise<void>(r => {
                      onData = r
                    })
                    onData = null
                  }
                  if (error) {
                    throw error
                  }
                  if (queue.length) {
                    const chunk = queue.shift()!
                    yield chunk.value
                  } else if (done) {
                    break
                  }
                }
              } finally {
                serverOutboundStreams.delete(id)
              }
            })()
            return asyncGen
          }
        },
      }
    ) as Routes['client']['streamers'],
  }

  // The core dispatch to call server procs or streamers
  async function handleServerProc(
    ws: WebSocket,
    msg: Extract<TswsMessage, { type: 'rpc' }>,
    ctx: Ctx
  ) {
    const { procName, args, id } = msg
    const fn = serverProcs[procName as keyof typeof serverProcs]
    if (!fn) {
      // No such proc
      const resp: TswsMessage = {
        type: 'rpc_result',
        id,
        error: `Server procedure not found: ${procName}`,
      }
      ws.send(JSON.stringify(resp))
      return
    }
    try {
      const result = await fn(args, ctx)
      const resp: TswsMessage = {
        type: 'rpc_result',
        id,
        success: result,
      }
      ws.send(JSON.stringify(resp))
    } catch (err: any) {
      const resp: TswsMessage = {
        type: 'rpc_result',
        id,
        error: String(err?.message || err),
      }
      ws.send(JSON.stringify(resp))
    }
  }

  async function handleServerStreamStart(
    ws: WebSocket,
    msg: Extract<TswsMessage, { type: 'stream_start' }>,
    ctx: Ctx
  ) {
    const { procName, args, id } = msg
    const fn = serverStreamers[procName as keyof typeof serverStreamers]
    if (!fn) {
      // No such stream
      const resp: TswsMessage = {
        type: 'stream_error',
        id,
        error: `Server streamer not found: ${procName}`,
      }
      ws.send(JSON.stringify(resp))
      return
    }
    try {
      const gen = fn(args, ctx)
      serverInboundStreams.set(id, gen)
      // Start reading from the generator and push results
      ;(async () => {
        try {
          for await (const val of gen) {
            const resp: TswsMessage = {
              type: 'stream_next',
              id,
              value: val,
            }
            ws.send(JSON.stringify(resp))
          }
          const done: TswsMessage = {
            type: 'stream_complete',
            id,
          }
          ws.send(JSON.stringify(done))
          serverInboundStreams.delete(id)
        } catch (err: any) {
          const e: TswsMessage = {
            type: 'stream_error',
            id,
            error: String(err?.message || err),
          }
          ws.send(JSON.stringify(e))
          serverInboundStreams.delete(id)
        }
      })()
    } catch (err: any) {
      const e: TswsMessage = {
        type: 'stream_error',
        id,
        error: String(err?.message || err),
      }
      ws.send(JSON.stringify(e))
    }
  }

  // Spin up the server
  async function start() {
    return new Promise<void>((resolve, reject) => {
      const app = App()

      app.ws('/*', {
        // Called when a new websocket is established
        open: async (ws) => {
          currentClientSocket = ws
          const ctxObj = { rawSocket: ws } as { [k: string]: any }
          // The upgrade request can be read from ws as any:
          // (ws as any).upgradeReq: { headers, etc. }

          // Run middleware chain:
          let i = 0
          const next = async () => {
            const mw = middleware[i++]
            if (mw) {
              await mw(ctxObj as Ctx, next)
            }
          }
          await next()

          // We attach the final context to ws
          ;(ws as any)._tsws_ctx = ctxObj
        },
        // Called on message
        message: (ws, message, isBinary) => {
          if (isBinary) {
            // we don't handle binary here
            return
          }
          let data: TswsMessage
          try {
            data = JSON.parse(Buffer.from(message).toString('utf8'))
          } catch (err) {
            return
          }
          const ctx = ((ws as any)._tsws_ctx || {}) as Ctx

          switch (data.type) {
            // -- inbound requests (client calling server) --
            case 'rpc':
              if (data.route === 'server') {
                handleServerProc(ws, data, ctx)
              }
              break
            case 'stream_start':
              if (data.route === 'server') {
                handleServerStreamStart(ws, data, ctx)
              }
              break

            // -- inbound responses (from client to server) --
            case 'rpc_result': {
              const pending = serverPendingRequests.get(data.id)
              if (pending) {
                serverPendingRequests.delete(data.id)
                if (data.error) {
                  pending.reject(new Error(data.error))
                } else {
                  pending.resolve(data.success)
                }
              }
              break
            }
            case 'stream_next': {
              const stream = serverOutboundStreams.get(data.id)
              if (stream) {
                // If this were inbound from the client, we'd push to a queue, etc.
                // But for simplicity, we won't implement "server receiving next from client"
                // because typically only one side yields.
                // This is a place-holder if you needed symmetrical streaming from client → server.
              }
              break
            }
            case 'stream_error': {
              const stream = serverOutboundStreams.get(data.id)
              if (stream) {
                // signal error somehow if needed
                if (stream.cancel) stream.cancel()
              }
              break
            }
            case 'stream_complete': {
              const stream = serverOutboundStreams.get(data.id)
              if (stream) {
                if (stream.cancel) stream.cancel()
              }
              break
            }
          }
        },
        // Called when websocket is closed
        close: (ws, code, message) => {
          if (currentClientSocket === ws) {
            currentClientSocket = null
          }
        },
      })

      app.listen(port, (token) => {
        if (!token) {
          reject(new Error(`Failed to listen on port ${port}`))
          return
        }
        listenSocket = token
        config?.onStarted?.(port)
        resolve()
      })
    })
  }

  async function stop() {
    if (listenSocket) {
      us_listen_socket_close(listenSocket)
      listenSocket = null
    }
  }

  return {
    start,
    stop,
    client,
  }
}
