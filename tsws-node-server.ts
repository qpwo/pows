// tsws-node-server.ts

import { App, WebSocket, us_listen_socket, us_listen_socket_close } from 'uWebSockets.js'

type TswsMiddleware<Ctx> = (ctx: {
  rawSocket: WebSocket
}, next: () => Promise<void>) => Promise<void> | void

/**
 * We define the shape of our protocol messages
 */
type TswsMessage =
  | {
      type: 'rpc';
      route: 'server' | 'client';
      id: string;
      procName: string;
      args: unknown[];
    }
  | {
      type: 'rpc_result';
      id: string;
      success?: unknown;
      error?: string;
    }
  | {
      type: 'stream_start';
      route: 'server' | 'client';
      id: string;
      procName: string;
      args: unknown[];
    }
  | {
      type: 'stream_next';
      id: string;
      value: unknown;
    }
  | {
      type: 'stream_error';
      id: string;
      error: string;
    }
  | {
      type: 'stream_complete';
      id: string;
    };

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * The server factory
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

  // Separate "procs" vs "streamers" from user input
  const serverProcs: Record<string, (...args: any[]) => any> = {}
  const serverStreamers: Record<string, (...args: any[]) => AsyncGenerator<any>> = {}

  for (const [key, fn] of Object.entries(serverImpl)) {
    if (typeof fn === 'function') {
      const isGenerator =
        fn.constructor.name === 'AsyncGeneratorFunction' ||
        fn.constructor.name === 'GeneratorFunction'
      if (isGenerator) {
        serverStreamers[key] = fn as any
      } else {
        serverProcs[key] = fn as any
      }
    }
  }

  let listenSocket: us_listen_socket | null = null

  // Track the "most recent" client for server->client calls
  let currentClientSocket: WebSocket | null = null

  // For in-flight calls from server->client
  const serverPendingRequests = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()

  // For in-flight server->client streams
  interface OutboundStream {
    generator: AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
    cancel?: () => void
  }
  const serverOutboundStreams = new Map<string, OutboundStream>()

  // For client->server streams in progress
  const serverInboundStreams = new Map<
    string,
    AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
  >()

  // The object that server uses to call "client" methods
  const client = {
    procs: new Proxy(
      {},
      {
        get(_target, prop: string) {
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
          return (...args: unknown[]) => {
            if (!currentClientSocket) {
              throw new Error('No client is currently connected.')
            }
            const id = newId()
            // Return an async generator that yields as we get data
            const asyncGen = (async function* () {
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

              serverOutboundStreams.set(id, {
                generator: null as any,
                cancel: () => {
                  done = true
                  onData?.()
                },
              })

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
                  while (queue.length) {
                    const chunk = queue.shift()!
                    yield chunk.value
                  }
                  if (done) {
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

  // Helper to handle inbound RPC calls for server "procs"
  async function handleServerProc(
    ws: WebSocket,
    msg: Extract<TswsMessage, { type: 'rpc' }>,
    ctx: Ctx
  ) {
    const { procName, args, id } = msg
    const fn = serverProcs[procName]
    if (!fn) {
      ws.send(JSON.stringify({
        type: 'rpc_result',
        id,
        error: `Server procedure not found: ${procName}`,
      }))
      return
    }
    try {
      const result = await fn(args, ctx)
      ws.send(JSON.stringify({
        type: 'rpc_result',
        id,
        success: result,
      }))
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'rpc_result',
        id,
        error: String(err?.message || err),
      }))
    }
  }

  // Helper to handle inbound stream starts for server "streamers"
  async function handleServerStreamStart(
    ws: WebSocket,
    msg: Extract<TswsMessage, { type: 'stream_start' }>,
    ctx: Ctx
  ) {
    const { procName, args, id } = msg
    const fn = serverStreamers[procName]
    if (!fn) {
      ws.send(JSON.stringify({
        type: 'stream_error',
        id,
        error: `Server streamer not found: ${procName}`,
      }))
      return
    }
    try {
      const gen = fn(args, ctx)
      serverInboundStreams.set(id, gen)
      ;(async () => {
        try {
          for await (const val of gen) {
            ws.send(JSON.stringify({
              type: 'stream_next',
              id,
              value: val,
            }))
          }
          ws.send(JSON.stringify({
            type: 'stream_complete',
            id,
          }))
          serverInboundStreams.delete(id)
        } catch (err: any) {
          ws.send(JSON.stringify({
            type: 'stream_error',
            id,
            error: String(err?.message || err),
          }))
          serverInboundStreams.delete(id)
        }
      })()
    } catch (err: any) {
      ws.send(JSON.stringify({
        type: 'stream_error',
        id,
        error: String(err?.message || err),
      }))
    }
  }

  async function start() {
    return new Promise<void>((resolve, reject) => {
      const app = App()

      app.ws('/*', {
        /**
         * 1) The "upgrade" callback is where we can read HTTP headers.
         *    Then we attach them to user data so they become accessible in "open".
         */
        upgrade: (res, req, context) => {
          // Grab the headers you need
          const cookie = req.getHeader('cookie') // raw cookie string, if any

          // Create a small "upgradeReq" object that mimics what you want:
          const upgradeReq = {
            headers: {
              cookie,
              // e.g. host: req.getHeader('host'),
              // etc.
            },
          }

          res.upgrade(
            // The "userData" object:
            { upgradeReq },
            // Standard WebSocket upgrade fields:
            req.getHeader('sec-websocket-key'),
            req.getHeader('sec-websocket-protocol'),
            req.getHeader('sec-websocket-extensions'),
            context
          )
        },

        /**
         * 2) "open" is called after a successful upgrade. The "ws" argument
         *    is actually our userData object from above.
         */
        open: async (ws) => {
          // 'ws' is typed as WebSocket, but it also includes our userData keys
          // e.g. (ws as any).upgradeReq
          currentClientSocket = ws as WebSocket

          // Build a context object
          const ctxObj = { rawSocket: ws } as Ctx
          // Attach the "upgradeReq" onto the rawSocket,
          // so your middleware can do: ctx.uws.upgradeReq.headers.cookie
          ;(ws as any).upgradeReq = (ws as any).upgradeReq || {}
          ctxObj.rawSocket.upgradeReq = (ws as any).upgradeReq

          // Run middleware chain
          let i = 0
          const next = async () => {
            const mw = middleware[i++]
            if (mw) {
              await mw(ctxObj, next)
            }
          }
          await next()
          // Done with open
        },

        message: (ws, message, isBinary) => {
          if (isBinary) {
            return
          }
          let data: TswsMessage
          try {
            data = JSON.parse(Buffer.from(message).toString('utf8'))
          } catch (err) {
            return
          }
          const ctx = { rawSocket: ws } as Ctx
          // also attach upgradeReq to the context if needed
          ;(ctx.rawSocket as any).upgradeReq = (ws as any).upgradeReq

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
                // Usually not used for serverOutbound -> clientInbound
                // But symmetrical if you want client to push "next" data
              }
              break
            }
            case 'stream_error': {
              const stream = serverOutboundStreams.get(data.id)
              if (stream) {
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
