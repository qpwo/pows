// tsws-node-server.ts

import uWS, { TemplatedApp, WebSocketBehavior } from 'uWebSockets.js'

/**
 * We define a helper type for the generic WebSocket in uWebSockets.js.
 * By default, uWebSockets expects a type parameter for user data. We'll use `unknown` here.
 */
type WS = uWS.WebSocket<unknown>

/**
 * The shape of the TSWS definition:
 * - server and client each declare "procs" (async functions) and "streamers" (async generators).
 */
export interface TSWSDefinition {
  server: {
    procs: Record<string, (...args: any[]) => any>
    streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>
  }
  client: {
    procs: Record<string, (...args: any[]) => any>
    streamers: Record<string, (...args: any[]) => AsyncGenerator<any, void, unknown>>
  }
}

/**
 * Middleware signature: each middleware receives the context and a `next` function.
 * The context typically carries user info, or any other request-specific data you want.
 */
export type Middleware<Context> = (ctx: ServerContext<Context>, next: () => Promise<void>) => Promise<void>

/**
 * Server context includes everything needed while handling a request.
 * - `extra` is a user-defined sub-object. Put your custom fields (e.g. `userName`, `userId`) in there.
 */
export interface ServerContext<Context> {
  rawSocket: WS
  connectionId: number
  server: TSWSInternalServer
  extra: Context
}

/**
 * Options for startServer
 */
export interface StartServerOptions<Routes extends TSWSDefinition, Context> {
  /**
   * Port for the WebSocket server
   */
  port?: number
  /**
   * Middleware array
   */
  middleware?: Middleware<Context>[]
  /**
   * Called after the server starts
   */
  onStarted?: (app: TemplatedApp) => void
}

/**
 * The server implementation. We'll store the methods for "server.procs" and "server.streamers".
 * But the shape is keyed by your TSWSDefinition's server sub-fields.
 */
export type ServerImplementation<Routes extends TSWSDefinition, Context> = {
  [K in keyof Routes['server']['procs']]: (
    args: Parameters<Routes['server']['procs'][K]>,
    ctx: ServerContext<Context>,
  ) => Promise<ReturnType<Routes['server']['procs'][K]>> | ReturnType<Routes['server']['procs'][K]>
} & {
  [K in keyof Routes['server']['streamers']]: (
    args: Parameters<Routes['server']['streamers'][K]>,
    ctx: ServerContext<Context>,
  ) => ReturnType<Routes['server']['streamers'][K]>
}

/**
 * For replying to streaming requests, we store each generator in a map
 * so we can send the `next()` results over time.
 */
interface ActiveStream {
  generator: AsyncGenerator<any, void, unknown>
  context: ServerContext<any>
}

/**
 * A minimal shape for TSWS messages.
 */
interface TSWSMessage {
  reqId?: number
  type: 'proc' | 'stream' | 'next' | 'complete' | 'error' | 'result' | 'cancel'
  route: 'server' | 'client'
  name: string
  args?: any[]
  value?: any
  error?: string
}

/**
 * Internal server object. We'll keep track of connections, streaming, etc.
 */
export interface TSWSInternalServer {
  connections: Map<
    number,
    {
      ws: WS
      activeStreams: Map<number, ActiveStream>
      nextClientReqId: number
      inflightClientRequests: Map<number, (value: any) => void>
      inflightClientRequestsReject: Map<number, (err: any) => void>
    }
  >
  nextConnectionId: number
}

/**
 * Start the TSWS server. Returns a minimal object containing the `app`.
 */
export function startServer<Routes extends TSWSDefinition, Context = {}>(
  serverImpl: Partial<ServerImplementation<Routes, Context>>,
  options: StartServerOptions<Routes, Context> = {},
) {
  const port = options.port ?? 8080

  const internalServer: TSWSInternalServer = {
    connections: new Map(),
    nextConnectionId: 1,
  }

  const app = uWS.App({})

  // WebSocket behavior
  const wsBehavior: WebSocketBehavior = {
    open: ws => {
      const connectionId = internalServer.nextConnectionId++
      internalServer.connections.set(connectionId, {
        ws,
        activeStreams: new Map(),
        nextClientReqId: 1,
        inflightClientRequests: new Map(),
        inflightClientRequestsReject: new Map(),
      })
      ;(ws as any).connectionId = connectionId
    },

    message: async (ws, message, isBinary) => {
      // Convert message from ArrayBuffer/Buffer to string
      let msgString: string
      if (message instanceof ArrayBuffer) {
        msgString = Buffer.from(message).toString('utf-8')
      } else {
        // In uWebSockets, 'message' is an ArrayBuffer by default, but let's handle generically
        msgString = Buffer.from(message).toString('utf-8')
      }

      let data: TSWSMessage
      try {
        data = JSON.parse(msgString)
      } catch (err) {
        console.error('Invalid JSON message:', err)
        return
      }

      const connectionId = (ws as any).connectionId
      const connState = internalServer.connections.get(connectionId)
      if (!connState) {
        return
      }

      switch (data.type) {
        case 'proc':
        case 'stream': {
          // The client is calling a server method or streamer
          const ctx: ServerContext<Context> = {
            rawSocket: ws,
            connectionId,
            server: internalServer,
            extra: {} as Context,
          }

          // Run middleware chain
          let index = 0
          const middlewares = options.middleware || []
          const routeCall = async () => {
            const { route, name, args } = data
            if (route !== 'server') {
              // Possibly an invalid route
              return
            }

            if (data.type === 'proc') {
              // A normal procedure
              const method = (serverImpl as any)[name]
              if (typeof method !== 'function') {
                return sendError(ws, data.reqId, `Server procedure '${name}' not found`)
              }
              try {
                const result = await method(args, ctx)
                sendResult(ws, data.reqId, result)
              } catch (err: any) {
                sendError(ws, data.reqId, err?.message ?? String(err))
              }
            } else {
              // A streamer
              const method = (serverImpl as any)[name]
              if (typeof method !== 'function') {
                return sendError(ws, data.reqId, `Server streamer '${name}' not found`)
              }
              try {
                const generator = method(args, ctx)
                connState.activeStreams.set(data.reqId!, {
                  generator,
                  context: ctx,
                })
                pumpStream(ws, connectionId, data.reqId!, generator, internalServer)
              } catch (err: any) {
                sendError(ws, data.reqId, err?.message ?? String(err))
              }
            }
          }

          const runNext = async () => {
            const fn = middlewares[index++]
            if (fn) {
              await fn(ctx, runNext)
            } else {
              await routeCall()
            }
          }

          try {
            await runNext()
          } catch (err) {
            sendError(ws, data.reqId, (err as any)?.message ?? String(err))
          }
          break
        }

        case 'next':
        case 'complete':
        case 'error':
        case 'cancel':
        case 'result': {
          // The client is replying to a server->client call or stream
          handleClientResponse(internalServer, connectionId, data)
          break
        }

        default:
          console.warn('Unknown message type:', data.type)
          break
      }
    },

    close: (ws, code, message) => {
      const connectionId = (ws as any).connectionId
      internalServer.connections.delete(connectionId)
    },
  }

  app.ws('/*', wsBehavior)

  app.listen(port, token => {
    if (token) {
      console.log(`TSWS server listening on port ${port}`)
      if (options.onStarted) {
        options.onStarted(app)
      }
    } else {
      console.error(`Failed to listen on port ${port}`)
    }
  })

  return {
    app,
  }
}

/**
 * Send a "result" message (RPC success).
 */
function sendResult(ws: WS, reqId: number | undefined, value: any) {
  if (!reqId) return
  ws.send(
    JSON.stringify({
      reqId,
      type: 'result',
      value,
    }),
  )
}

/**
 * Send an "error" message (RPC error).
 */
function sendError(ws: WS, reqId: number | undefined, error: string) {
  if (!reqId) return
  ws.send(
    JSON.stringify({
      reqId,
      type: 'error',
      error,
    }),
  )
}

/**
 * Send a "next" message for streaming.
 */
function sendNext(ws: WS, reqId: number, value: any) {
  ws.send(
    JSON.stringify({
      reqId,
      type: 'next',
      value,
    }),
  )
}

/**
 * Send a "complete" message for streaming.
 */
function sendComplete(ws: WS, reqId: number) {
  ws.send(
    JSON.stringify({
      reqId,
      type: 'complete',
    }),
  )
}

/**
 * Pull from the generator and send the values to the client.
 */
async function pumpStream(
  ws: WS,
  connectionId: number,
  reqId: number,
  generator: AsyncGenerator<any, void, unknown>,
  internalServer: TSWSInternalServer,
) {
  try {
    while (true) {
      const { value, done } = await generator.next()
      if (done) {
        sendComplete(ws, reqId)
        break
      }
      sendNext(ws, reqId, value)
    }
  } catch (err: any) {
    sendError(ws, reqId, err?.message ?? String(err))
  }
}

/**
 * Handle client responses to server-initiated calls or streams.
 */
function handleClientResponse(internalServer: TSWSInternalServer, connectionId: number, msg: TSWSMessage) {
  const conn = internalServer.connections.get(connectionId)
  if (!conn) return

  const { reqId, type, value, error } = msg
  if (!reqId) return

  const resolver = conn.inflightClientRequests.get(reqId)
  const rejecter = conn.inflightClientRequestsReject.get(reqId)

  if (resolver || rejecter) {
    switch (type) {
      case 'result':
        conn.inflightClientRequests.delete(reqId)
        conn.inflightClientRequestsReject.delete(reqId)
        resolver?.(value)
        break
      case 'error':
        conn.inflightClientRequests.delete(reqId)
        conn.inflightClientRequestsReject.delete(reqId)
        rejecter?.(new Error(error || 'Unknown error'))
        break
      // For streaming from client to server, we'd handle 'next', 'complete', etc. similarly.
      default:
        break
    }
  }
}

/**
 * Helper for calling the client's procs from the server side.
 * Usage example:
 *   const result = await callClientProc<Routes, MyContext, 'approve'>(ctx, 'approve', ['question?'])
 */
export function callClientProc<Routes extends TSWSDefinition, Context, K extends keyof Routes['client']['procs']>(
  ctx: ServerContext<Context>,
  methodName: K,
  args: Parameters<Routes['client']['procs'][K]>,
): Promise<Awaited<ReturnType<Routes['client']['procs'][K]>>> {
  const conn = ctx.server.connections.get(ctx.connectionId)
  if (!conn) throw new Error('Connection not found in server context')

  const reqId = conn.nextClientReqId++
  return new Promise((resolve, reject) => {
    conn.inflightClientRequests.set(reqId, resolve)
    conn.inflightClientRequestsReject.set(reqId, reject)

    conn.ws.send(
      JSON.stringify({
        reqId,
        type: 'proc',
        route: 'client',
        name: methodName,
        args,
      }),
    )
  })
}
