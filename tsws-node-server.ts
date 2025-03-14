// tsws-node-server.ts
import uWS from 'uWebSockets.js'

/**
 * Fix for "Generic type 'WebSocket<UserData>' requires 1 type argument(s)."
 * We'll just store <unknown>.
 */
type Ws = uWS.WebSocket<unknown>

/**
 * SERVER-SIDE ROUTE SIGNATURES
 *
 * In your examples, you define e.g.:
 *   whoami(_: Empty): Promise<{ name: string, userId: number }>
 * but then implement it as:
 *   async whoami(_, ctx) { ... }
 *
 * So we want the *exported* type to be (args: X, ctx: ServerCtx) => Return
 * so the user's code can do two parameters without error.
 */
type ServerProcImpl<Fn, Ctx> = Fn extends (args: infer A) => infer R ? (args: A, ctx: Ctx) => R : never

type ServerStreamerImpl<Fn, Ctx> = Fn extends (args: infer A) => infer R ? (args: A, ctx: Ctx) => R : never

/**
 * CLIENT-SIDE ROUTE SIGNATURES
 *
 * On the server side, we sometimes call "ctx.clientProcs.someProc(args)".
 * The user’s route is e.g. "approve(_: { question: string }): Promise<{ approved: boolean }>"
 * but we implement "async approve({ question }, ctx) { ... }".
 * So again, we want the final shape to be (args, ctx).
 */
type CallClientProc<Fn> = Fn extends (args: infer A) => infer R ? (args: A) => R : never

type CallClientStreamer<Fn> = Fn extends (args: infer A) => infer R ? (args: A) => R : never

/**
 * The user’s "Routes" interface is conceptually:
 *   {
 *     server: {
 *       procs: Record<string, (args) => Promise<any>>,
 *       streamers: Record<string, (args) => AsyncGenerator<any>>
 *     },
 *     client: {
 *       procs: ...,
 *       streamers: ...
 *     }
 *   }
 * but each method is *really* 2-parameter at runtime, `(args, ctx)`.
 * We'll transform them accordingly below.
 */
export type RoutesConstraint = {
  server: {
    procs: Record<string, (args: any) => Promise<any>>
    streamers: Record<string, (args: any) => AsyncGenerator<any>>
  }
  client: {
    procs: Record<string, (args: any) => Promise<any>>
    streamers: Record<string, (args: any) => AsyncGenerator<any>>
  }
}

/**
 * ServerContext, as seen by *server* code:
 *   - ws: the underlying uWS WebSocket
 *   - clientProcs: calls to the client's procs
 *   - clientStreamers: calls to the client's streamers
 * plus any user-defined fields in "ServerContext".
 */
export type TswsServerContext<Routes extends RoutesConstraint, ServerContext> = ServerContext & {
  ws: Ws
  clientProcs: {
    [K in keyof Routes['client']['procs']]: CallClientProc<
      Routes['client']['procs'][K]
      // ,TswsServerContext<Routes, ServerContext>
    >
  }
  clientStreamers: {
    [K in keyof Routes['client']['streamers']]: CallClientStreamer<
      Routes['client']['streamers'][K]
      // ,TswsServerContext<Routes, ServerContext>
    >
  }
}

/**
 * The server procs we expect from the user: for each route method
 * e.g. "square(_: {x: number}): Promise<{result: number}>"
 * we produce (args: {x:number}, ctx: TswsServerContext<...>) => Promise<{result: number}>
 */
type TswsServerProcs<Routes extends RoutesConstraint, ServerContext> = {
  [K in keyof Routes['server']['procs']]: ServerProcImpl<Routes['server']['procs'][K], TswsServerContext<Routes, ServerContext>>
}
type TswsServerStreamers<Routes extends RoutesConstraint, ServerContext> = {
  [K in keyof Routes['server']['streamers']]: ServerStreamerImpl<Routes['server']['streamers'][K], TswsServerContext<Routes, ServerContext>>
}

/**
 * Options for makeTswsServer.
 */
export interface TswsServerOpts<Routes extends RoutesConstraint, ServerContext> {
  procs: TswsServerProcs<Routes, ServerContext>
  streamers: TswsServerStreamers<Routes, ServerContext>
  port?: number
  onConnection?: (ctx: TswsServerContext<Routes, ServerContext>) => void | Promise<void>
}

/**
 * The returned server object with start().
 */
export interface TswsServer<Routes extends RoutesConstraint, ServerContext> {
  start: () => Promise<void>
}

/**
 * The actual server function. Internally, we store everything as
 * `(args: any, ctx: any) => any` but we *export* the typed version above
 * so that user code type-checks perfectly with two parameters.
 */
export function makeTswsServer<Routes extends RoutesConstraint, ServerContext = {}>(
  opts: TswsServerOpts<Routes, ServerContext>,
): TswsServer<Routes, ServerContext> {
  const { procs, streamers, port = 8080, onConnection } = opts

  // Internally, we treat the user procs & streamers as any => any:
  const internalProcs = procs as Record<string, (args: any, ctx: any) => any>
  const internalStreamers = streamers as Record<string, (args: any, ctx: any) => AsyncGenerator<any>>

  interface PerSocketData {
    nextReqId: number
    pendingCalls: Map<
      number,
      {
        resolve: (data: any) => void
        reject: (err: any) => void
        streaming?: boolean
        streamController?: {
          push: (chunk: any) => void
          end: () => void
          error: (err: any) => void
        }
      }
    >
    activeServerStreams: Map<number, AsyncGenerator<any>>
  }

  const wsToContext = new WeakMap<Ws, TswsServerContext<Routes, ServerContext>>()

  function wsData(ws: Ws): PerSocketData {
    return (ws as any)._tswsData
  }

  const app = uWS.App().ws('/*', {
    open: (ws: Ws) => {
      ;(ws as any)._tswsData = {
        nextReqId: 1,
        pendingCalls: new Map(),
        activeServerStreams: new Map(),
      } as PerSocketData

      // Build TswsServerContext
      const baseCtx = {} as ServerContext
      const fullCtx: TswsServerContext<Routes, ServerContext> = {
        ...baseCtx,
        ws,
        clientProcs: new Proxy(
          {},
          {
            get(_t, methodName) {
              return (args: any) => callRemoteProc(ws, 'client', methodName as string, args)
            },
          },
        ) as any,
        clientStreamers: new Proxy(
          {},
          {
            get(_t, methodName) {
              return (args: any) => callRemoteStreamer(ws, 'client', methodName as string, args)
            },
          },
        ) as any,
      }
      wsToContext.set(ws, fullCtx)

      if (onConnection) {
        Promise.resolve(onConnection(fullCtx)).catch(err => {
          console.error('onConnection error:', err)
        })
      }
    },

    message: (ws: Ws, message, isBinary) => {
      if (isBinary) return
      let msg: any
      try {
        msg = JSON.parse(Buffer.from(message).toString('utf8'))
      } catch (e) {
        console.error('Invalid JSON from client:', e)
        return
      }
      handleMessage(ws, msg).catch(err => {
        console.error('handleMessage error:', err)
      })
    },

    close: (ws: Ws) => {
      const data = wsData(ws)
      for (const [, pc] of data.pendingCalls) {
        pc.reject(new Error('Connection closed'))
      }
      data.pendingCalls.clear()
      for (const [, gen] of data.activeServerStreams) {
        if (gen.return) {
          gen.return(undefined).catch(() => {})
        }
      }
      data.activeServerStreams.clear()
      wsToContext.delete(ws)
    },
  })

  function sendJson(ws: Ws, obj: any) {
    ws.send(JSON.stringify(obj))
  }

  function callRemoteProc(ws: Ws, side: 'server' | 'client', method: string, args: any) {
    const data = wsData(ws)
    const reqId = data.nextReqId++
    return new Promise<any>((resolve, reject) => {
      data.pendingCalls.set(reqId, { resolve, reject })
      sendJson(ws, {
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: false,
      })
    })
  }

  function callRemoteStreamer(ws: Ws, side: 'server' | 'client', method: string, args: any): AsyncGenerator<any> {
    const data = wsData(ws)
    const reqId = data.nextReqId++

    let pullController: ((chunk: any) => void) | null = null
    let endController: (() => void) | null = null
    let errorController: ((err: any) => void) | null = null
    let ended = false
    const queue: any[] = []

    const gen = (async function* () {
      sendJson(ws, {
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: true,
      })
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()
        } else if (ended) {
          return
        } else {
          await new Promise<void>((resolve, reject) => {
            pullController = chunk => {
              pullController = null
              queue.push(chunk)
              resolve()
            }
            endController = () => {
              pullController = null
              endController = null
              ended = true
              resolve()
            }
            errorController = err => {
              pullController = null
              endController = null
              errorController = null
              reject(err)
            }
          })
        }
      }
    })()

    data.pendingCalls.set(reqId, {
      resolve: () => {},
      reject: err => {
        if (errorController) errorController(err)
      },
      streaming: true,
      streamController: {
        push: (chunk: any) => {
          if (pullController) pullController(chunk)
          else queue.push(chunk)
        },
        end: () => {
          if (endController) endController()
        },
        error: (err: any) => {
          if (errorController) errorController(err)
        },
      },
    })

    return gen
  }

  async function handleMessage(ws: Ws, msg: any) {
    const data = wsData(ws)
    const ctx = wsToContext.get(ws)
    if (!ctx) return

    if (msg.type === 'rpc') {
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'server') {
        // client->server call
        if (!isStream) {
          const fn = internalProcs[method]
          if (!fn) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No server proc named '${method}'`,
            })
            return
          }
          try {
            // call with (args, ctx)
            const result = await fn(args, ctx)
            sendJson(ws, { type: 'rpc-res', reqId, ok: true, data: result })
          } catch (err: any) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
          }
        } else {
          const fn = internalStreamers[method]
          if (!fn) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No server streamer named '${method}'`,
            })
            return
          }
          let gen: AsyncGenerator<any>
          try {
            gen = fn(args, ctx)
          } catch (err: any) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
            return
          }
          sendJson(ws, {
            type: 'rpc-res',
            reqId,
            ok: true,
            streaming: true,
          })
          data.activeServerStreams.set(reqId, gen)
          pushServerStream(ws, reqId, gen).catch(err => {
            console.error('pushServerStream error:', err)
          })
        }
      } else {
        // side==='client' => error if we get it here
        sendJson(ws, {
          type: 'rpc-res',
          reqId,
          ok: false,
          error: 'Received side="client" call on server; ignoring.',
        })
      }
    } else if (msg.type === 'rpc-res') {
      // server->client call response
      const reqId = msg.reqId
      const pc = data.pendingCalls.get(reqId)
      if (!pc) return
      if (msg.ok) {
        if (!msg.streaming) {
          data.pendingCalls.delete(reqId)
          pc.resolve(msg.data)
        } else {
          pc.resolve(undefined)
        }
      } else {
        data.pendingCalls.delete(reqId)
        pc.reject(new Error(msg.error || 'Unknown error'))
      }
    } else if (msg.type === 'stream-chunk') {
      // chunk from client
      const pc = data.pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      pc.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      // end from client
      const pc = data.pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      data.pendingCalls.delete(msg.reqId)
      pc.streamController?.end()
    } else if (msg.type === 'stream-error') {
      // error from client
      const pc = data.pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      data.pendingCalls.delete(msg.reqId)
      pc.streamController?.error(new Error(msg.error || 'Unknown stream error'))
    }
  }

  async function pushServerStream(ws: Ws, reqId: number, gen: AsyncGenerator<any>) {
    const data = wsData(ws)
    try {
      for await (const chunk of gen) {
        sendJson(ws, { type: 'stream-chunk', reqId, chunk })
      }
      sendJson(ws, { type: 'stream-end', reqId })
    } catch (err: any) {
      sendJson(ws, { type: 'stream-error', reqId, error: err?.message || String(err) })
    } finally {
      data.activeServerStreams.delete(reqId)
    }
  }

  return {
    start() {
      return new Promise<void>((resolve, reject) => {
        app.listen(port, token => {
          if (!token) {
            return reject(new Error(`Failed to listen on port ${port}`))
          }
          console.log(`TSWS uWebSockets server listening on port ${port}`)
          resolve()
        })
      })
    },
  }
}
