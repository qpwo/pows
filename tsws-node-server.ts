// tsws-node-server.ts
import uWS from 'uWebSockets.js'

/**
 * A marker type to help ensure your Routes follow the shape
 * { server: { procs, streamers }, client: { procs, streamers } }.
 * In your own code: `const __: RoutesConstraint = null as any as YourRoutes;`
 */
export type RoutesConstraint = {
  server: {
    procs: Record<string, (args: any, ctx: any) => any>
    streamers: Record<string, (args: any, ctx: any) => AsyncGenerator<any, any, any>>
  }
  client: {
    procs: Record<string, (args: any, ctx: any) => any>
    streamers: Record<string, (args: any, ctx: any) => AsyncGenerator<any, any, any>>
  }
}

/**
 * The server context shape that we'll inject into procedure/streamer calls.
 * We add `ws` (the raw uWebSockets WebSocket) and `clientProcs` / `clientStreamers`
 * so that server code can call the client's procs/streamers.
 */
export type TswsServerContext<Routes extends RoutesConstraint, ServerContext> = ServerContext & {
  ws: uWS.WebSocket
  /**
   * For calling procedures on the client side. If you defined client procs like:
   *   client: { procs: { sayHello: (args: { name: string }) => Promise<{ ok: boolean }> } }
   * then you'll have ctx.clientProcs.sayHello available here on the server side.
   */
  clientProcs: {
    [K in keyof Routes['client']['procs']]: (
      args: Parameters<Routes['client']['procs'][K]>[0]
    ) => ReturnType<Routes['client']['procs'][K]>
  }
  /**
   * For starting streaming calls on the client side.
   */
  clientStreamers: {
    [K in keyof Routes['client']['streamers']]: (
      args: Parameters<Routes['client']['streamers'][K]>[0]
    ) => ReturnType<Routes['client']['streamers'][K]>
  }
}

/**
 * Configuration options for makeTswsServer.
 */
export interface TswsServerOpts<
  Routes extends RoutesConstraint,
  ServerContext
> {
  /** Implementation of the server's procs (RPC calls). */
  procs: Routes['server']['procs']
  /** Implementation of the server's streamers (RPC streaming). */
  streamers: Routes['server']['streamers']
  /** Port number to listen on (defaults to 8080). */
  port?: number
  /**
   * A hook called when a client connection is opened.
   * You can attach additional fields to `ctx` here.
   */
  onConnection?: (
    ctx: TswsServerContext<Routes, ServerContext>
  ) => void | Promise<void>
}

/**
 * The return object from `makeTswsServer`.
 */
export interface TswsServer<Routes extends RoutesConstraint, ServerContext> {
  /** Start listening on the configured port. */
  start: () => Promise<void>
}

/**
 * Create a TSWS server. Example usage:
 *
 *   interface Routes {
 *     server: {
 *       procs: { doSomething(args: { x: number }): Promise<{ ok: boolean }> }
 *       streamers: { bigJob(args: {}): AsyncGenerator<string> }
 *     }
 *     client: { procs: {}, streamers: {} }
 *   }
 *   const server = makeTswsServer<Routes>({ procs, streamers, port: 8080 })
 *   server.start()
 */
export function makeTswsServer<
  Routes extends RoutesConstraint,
  ServerContext = {}
>(opts: TswsServerOpts<Routes, ServerContext>): TswsServer<Routes, ServerContext> {
  const {
    procs: serverProcs,
    streamers: serverStreamers,
    port = 8080,
    onConnection,
  } = opts

  // Each WebSocket connection will have its own context, request ID counters, etc.
  const wsToContext = new WeakMap<uWS.WebSocket, TswsServerContext<Routes, ServerContext>>()

  // We define a message interface for what we'll send/receive over the wire.
  // We'll keep everything in JSON, with typed fields.

  // On the server side, to call the client, we need a request ID generator, plus
  // a map to store pending requests & streaming states.
  type PendingCall = {
    resolve: (data: any) => void
    reject: (err: any) => void
    streaming?: boolean
    streamController?: {
      push: (chunk: any) => void
      end: () => void
      error: (err: any) => void
    }
  }

  // For each connection, track the next request ID and a map of pending calls.
  interface PerSocketData {
    nextReqId: number
    pendingCalls: Map<number, PendingCall>
    activeServerStreams: Map<number, AsyncGenerator<any>> // streaming from server to client
  }

  function createClientSideHelpers(ctx: TswsServerContext<Routes, ServerContext>) {
    // Build an object with the same shape as Routes['client']['procs'].
    const clientProcs = {} as TswsServerContext<Routes, ServerContext>['clientProcs']
    for (const methodName of Object.keys(serverRoutes.clientProcs)) {
      // For each method, we create a function that calls the client via JSON message.
      (clientProcs as any)[methodName] = async (args: any) => {
        return callRemoteProc(ctx, 'client', methodName, args)
      }
    }

    // Build an object with the same shape as Routes['client']['streamers'].
    const clientStreamers = {} as TswsServerContext<Routes, ServerContext>['clientStreamers']
    for (const methodName of Object.keys(serverRoutes.clientStreamers)) {
      (clientStreamers as any)[methodName] = (args: any) => {
        return callRemoteStreamer(ctx, 'client', methodName, args)
      }
    }

    return { clientProcs, clientStreamers }
  }

  // We'll unify the server's procs and streamers, plus the client's shape, for type reflection:
  const serverRoutes = {
    serverProcs: serverProcs,
    serverStreamers: serverStreamers,
    clientProcs: ({} as Routes['client']['procs']),
    clientStreamers: ({} as Routes['client']['streamers']),
  }

  // -------------------- transport layer: sending/receiving JSON messages --------------------
  function sendJson(ws: uWS.WebSocket, obj: any) {
    ws.send(JSON.stringify(obj))
  }

  function callRemoteProc(
    ctx: TswsServerContext<Routes, ServerContext>,
    side: 'server' | 'client',
    method: string,
    args: any
  ): Promise<any> {
    const data = wsData(ctx.ws)
    const reqId = data.nextReqId++
    return new Promise((resolve, reject) => {
      data.pendingCalls.set(reqId, { resolve, reject })
      sendJson(ctx.ws, {
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: false,
      })
    })
  }

  function callRemoteStreamer(
    ctx: TswsServerContext<Routes, ServerContext>,
    side: 'server' | 'client',
    method: string,
    args: any
  ): AsyncGenerator<any, void, unknown> {
    // We'll send an rpc with streaming: true, then yield chunks as they arrive.
    const data = wsData(ctx.ws)
    const reqId = data.nextReqId++

    let pullController: ((chunk: any) => void) | null = null
    let endController: (() => void) | null = null
    let errorController: ((err: any) => void) | null = null

    let ended = false
    const queue: any[] = []

    const gen = (async function* () {
      // Kick off the streaming request:
      sendJson(ctx.ws, {
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: true,
      })

      // Wait for chunks to arrive via push from handleMessage.
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift()
          yield chunk
        } else if (ended) {
          return
        } else {
          // Wait for next chunk
          await new Promise<void>((resolve, reject) => {
            pullController = (chunk) => {
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
            errorController = (err) => {
              pullController = null
              endController = null
              errorController = null
              reject(err)
            }
          })
        }
      }
    })()

    // store in pendingCalls so handleMessage can push chunks
    data.pendingCalls.set(reqId, {
      resolve: () => {}, // never used for normal resolution
      reject: (err) => {
        if (errorController) {
          errorController(err)
        }
      },
      streaming: true,
      streamController: {
        push: (chunk) => {
          if (pullController) {
            pullController(chunk)
          } else {
            queue.push(chunk)
          }
        },
        end: () => {
          if (endController) {
            endController()
          }
        },
        error: (err) => {
          if (errorController) {
            errorController(err)
          }
        },
      },
    })

    return gen
  }

  function wsData(ws: uWS.WebSocket): PerSocketData {
    // We store a small object per connection that tracks request IDs, etc.
    // We'll attach it once on open:
    return (ws as any)._tswsData
  }

  // -------------------- main server logic (uWebSockets) --------------------
  const app = uWS.App().ws('/*', {
    // Called when the HTTP -> WS upgrade is done
    open: (ws) => {
      // create per-socket data
      (ws as any)._tswsData = {
        nextReqId: 1,
        pendingCalls: new Map<number, PendingCall>(),
        activeServerStreams: new Map<number, AsyncGenerator<any>>(),
      } as PerSocketData

      // Build the context (ServerContext + helper fields)
      const baseCtx = {} as ServerContext // user can fill in onConnection
      const fullCtx = {
        ...baseCtx,
        ws,
        ...createClientSideHelpers(null as any), // fix below
      } as TswsServerContext<Routes, ServerContext>

      // correct the references inside createClientSideHelpers
      const helpers = createClientSideHelpers(fullCtx)
      ;(fullCtx.clientProcs as any) = helpers.clientProcs
      ;(fullCtx.clientStreamers as any) = helpers.clientStreamers

      // store
      wsToContext.set(ws, fullCtx)

      // call user hook
      if (onConnection) {
        Promise.resolve(onConnection(fullCtx)).catch((err) => {
          console.error('Error in onConnection:', err)
        })
      }
    },

    // Called when a message arrives from a client
    message: (ws, message, isBinary) => {
      if (isBinary) return // ignoring binary
      let msg: any
      try {
        msg = JSON.parse(Buffer.from(message).toString('utf8'))
      } catch (err) {
        console.error('Failed to parse JSON:', err)
        return
      }
      handleMessage(ws, msg).catch((err) => {
        console.error('Error handling message:', err)
      })
    },

    // Called when a connection is closed
    close: (ws) => {
      // we can do any cleanup here if needed
      // e.g. close any open streams
      const data = wsData(ws)
      // reject all pending calls
      for (const [, pc] of data.pendingCalls) {
        pc.reject(new Error('Connection closed'))
      }
      data.pendingCalls.clear()
      data.activeServerStreams.forEach((gen) => {
        if (gen.return) {
          gen.return(undefined).catch(() => {})
        }
      })
      data.activeServerStreams.clear()
      wsToContext.delete(ws)
    },
  })

  async function handleMessage(ws: uWS.WebSocket, msg: any) {
    const ctx = wsToContext.get(ws)
    if (!ctx) return

    // If it's a request from client => type='rpc'
    if (msg.type === 'rpc') {
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'server') {
        // The client is calling a server proc/stream
        // Find the method in serverProcs or serverStreamers
        if (!isStream) {
          // normal RPC
          const fn = serverRoutes.serverProcs[method]
          if (!fn) {
            // no such method
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No server proc named '${method}'`,
            })
            return
          }
          try {
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
          // streaming RPC
          const streamFn = serverRoutes.serverStreamers[method]
          if (!streamFn) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No server streamer named '${method}'`,
            })
            return
          }
          // start the generator
          let gen: AsyncGenerator<any>
          try {
            gen = streamFn(args, ctx)
          } catch (err: any) {
            sendJson(ws, {
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
            return
          }
          // If we get here, the generator was created successfully
          // send initial success
          sendJson(ws, {
            type: 'rpc-res',
            reqId,
            ok: true,
            streaming: true,
          })
          // store it so we can continue sending chunks
          wsData(ws).activeServerStreams.set(reqId, gen)

          // begin pushing
          pushServerStream(ws, reqId, gen).catch((err) => {
            console.error('Stream push error:', err)
          })
        }
      } else if (side === 'client') {
        // The client is asking the server to call the *client* procs? Actually
        // that means the server is receiving a request that it originally
        // triggered by `ctx.clientProcs.*`. But the roles are reversed here:
        // the client is implementing these. Usually the server won't implement side='client'.
        // Possibly the client made an internal mistake. We won't do anything.
        sendJson(ws, {
          type: 'rpc-res',
          reqId,
          ok: false,
          error: 'Received side=client call on server; ignoring.',
        })
      }
    }
    // If it's a response => type='rpc-res'
    else if (msg.type === 'rpc-res') {
      const reqId = msg.reqId
      const data = wsData(ws).pendingCalls.get(reqId)
      if (!data) return // no pending call
      if (msg.ok) {
        if (!msg.streaming) {
          // normal call
          wsData(ws).pendingCalls.delete(reqId)
          data.resolve(msg.data)
        } else {
          // streaming call started OK
          data.resolve(undefined) // signals "generator open" for the caller
        }
      } else {
        // error
        wsData(ws).pendingCalls.delete(reqId)
        data.reject(new Error(msg.error || 'Unknown error'))
      }
    }
    // If it's a stream event => type in {'stream-chunk','stream-end','stream-error'}
    else if (msg.type === 'stream-chunk') {
      const reqId = msg.reqId
      const data = wsData(ws).pendingCalls.get(reqId)
      if (!data || !data.streaming) return
      data.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const reqId = msg.reqId
      const data = wsData(ws).pendingCalls.get(reqId)
      if (!data || !data.streaming) return
      wsData(ws).pendingCalls.delete(reqId)
      data.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const reqId = msg.reqId
      const data = wsData(ws).pendingCalls.get(reqId)
      if (!data || !data.streaming) return
      wsData(ws).pendingCalls.delete(reqId)
      data.streamController?.error(new Error(msg.error || 'Unknown stream error'))
    }
    // If it's a cancel => type='cancel' (not shown in examples, but could be supported)
    else if (msg.type === 'cancel') {
      // client is canceling a streaming
      const reqId = msg.reqId
      const gen = wsData(ws).activeServerStreams.get(reqId)
      if (gen) {
        wsData(ws).activeServerStreams.delete(reqId)
        if (gen.return) {
          gen.return(undefined).catch(() => {})
        }
      }
    }
  }

  async function pushServerStream(ws: uWS.WebSocket, reqId: number, gen: AsyncGenerator<any>) {
    try {
      for await (const chunk of gen) {
        // send chunk
        sendJson(ws, { type: 'stream-chunk', reqId, chunk })
      }
      // done
      sendJson(ws, { type: 'stream-end', reqId })
    } catch (err: any) {
      sendJson(ws, { type: 'stream-error', reqId, error: err?.message || String(err) })
    } finally {
      wsData(ws).activeServerStreams.delete(reqId)
    }
  }

  return {
    async start() {
      return new Promise<void>((resolve, reject) => {
        app.listen(port, (token) => {
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
