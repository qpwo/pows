// tsws-node-server.ts

import uWS from 'uWebSockets.js'

/**
 * A marker type to ensure Routes has the shape:
 *   {
 *     server: { procs, streamers },
 *     client: { procs, streamers },
 *   }
 */
export type RoutesConstraint = {
  server: {
    procs: Record<string, (args: any, ctx: any) => any>
    streamers: Record<string, (args: any, ctx: any) => AsyncGenerator<any>>
  }
  client: {
    procs: Record<string, (args: any, ctx: any) => any>
    streamers: Record<string, (args: any, ctx: any) => AsyncGenerator<any>>
  }
}

/**
 * The server context that will be passed to each server-side
 * procedure or streamer. It includes:
 *   - ws: the uWebSockets.js connection
 *   - clientProcs / clientStreamers: for calling the client's RPC
 */
export type TswsServerContext<Routes extends RoutesConstraint, ServerContext> = ServerContext & {
  ws: uWS.WebSocket
  clientProcs: {
    [K in keyof Routes['client']['procs']]: (
      args: Parameters<Routes['client']['procs'][K]>[0]
    ) => ReturnType<Routes['client']['procs'][K]>
  }
  clientStreamers: {
    [K in keyof Routes['client']['streamers']]: (
      args: Parameters<Routes['client']['streamers'][K]>[0]
    ) => ReturnType<Routes['client']['streamers'][K]>
  }
}

export interface TswsServerOpts<
  Routes extends RoutesConstraint,
  ServerContext
> {
  procs: Routes['server']['procs']
  streamers: Routes['server']['streamers']
  port?: number
  onConnection?: (
    ctx: TswsServerContext<Routes, ServerContext>
  ) => void | Promise<void>
}

export interface TswsServer<Routes extends RoutesConstraint, ServerContext> {
  start: () => Promise<void>
}

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

  // For each WS, store:
  //   - nextReqId: counter for calls we make from server->client
  //   - pendingCalls: map of requestId -> { resolve, reject, possibly streaming }
  //   - activeServerStreams: requestId -> active AsyncGenerator from server->client
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

  // Each uWS.WebSocket has a `_tswsData` property.
  function wsData(ws: uWS.WebSocket): PerSocketData {
    return (ws as any)._tswsData
  }

  // We track the server context object for each WS:
  const wsToContext = new WeakMap<uWS.WebSocket, TswsServerContext<Routes, ServerContext>>()

  // Create the server app
  const app = uWS.App().ws('/*', {
    open: (ws) => {
      // Initialize PerSocketData
      (ws as any)._tswsData = {
        nextReqId: 1,
        pendingCalls: new Map(),
        activeServerStreams: new Map(),
      } as PerSocketData

      // Create the user’s ServerContext object
      // plus "clientProcs" and "clientStreamers" proxies
      const baseCtx = {} as ServerContext
      const fullCtx = {
        ...baseCtx,
        ws,
        clientProcs: makeClientProcs(ws),
        clientStreamers: makeClientStreamers(ws),
      } as TswsServerContext<Routes, ServerContext>

      wsToContext.set(ws, fullCtx)

      // onConnection hook
      if (onConnection) {
        Promise.resolve(onConnection(fullCtx)).catch((err) => {
          console.error('onConnection error:', err)
        })
      }
    },

    message: (ws, message, isBinary) => {
      if (isBinary) return
      let msg: any
      try {
        msg = JSON.parse(Buffer.from(message).toString('utf8'))
      } catch (e) {
        console.error('Invalid JSON:', e)
        return
      }
      handleMessage(ws, msg).catch((err) => {
        console.error('Error in handleMessage:', err)
      })
    },

    close: (ws) => {
      // cleanup any pending calls or server streams
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

  // Helper: create a "clientProcs" object that calls side='client'
  function makeClientProcs(ws: uWS.WebSocket) {
    return new Proxy(
      {},
      {
        get(_target, methodName) {
          return (args: any) => callRemoteProc(ws, 'client', methodName as string, args)
        },
      }
    ) as TswsServerContext<Routes, ServerContext>['clientProcs']
  }

  // Helper: create a "clientStreamers" object that calls side='client'
  function makeClientStreamers(ws: uWS.WebSocket) {
    return new Proxy(
      {},
      {
        get(_target, methodName) {
          return (args: any) =>
            callRemoteStreamer(ws, 'client', methodName as string, args)
        },
      }
    ) as TswsServerContext<Routes, ServerContext>['clientStreamers']
  }

  function sendJson(ws: uWS.WebSocket, obj: any) {
    ws.send(JSON.stringify(obj))
  }

  // Server->client calls (procedures)
  function callRemoteProc(ws: uWS.WebSocket, side: 'server' | 'client', method: string, args: any) {
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

  // Server->client calls (streamers)
  function callRemoteStreamer(
    ws: uWS.WebSocket,
    side: 'server' | 'client',
    method: string,
    args: any
  ): AsyncGenerator<any> {
    const data = wsData(ws)
    const reqId = data.nextReqId++

    let pullController: ((chunk: any) => void) | null = null
    let endController: (() => void) | null = null
    let errorController: ((err: any) => void) | null = null
    let ended = false
    const queue: any[] = []

    const gen = (async function* () {
      // Send initial request
      sendJson(ws, {
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: true,
      })

      while (true) {
        if (queue.length) {
          yield queue.shift()
        } else if (ended) {
          return
        } else {
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

    data.pendingCalls.set(reqId, {
      resolve: () => {},
      reject: (err) => {
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

  async function handleMessage(ws: uWS.WebSocket, msg: any) {
    const ctx = wsToContext.get(ws)
    if (!ctx) return

    const data = wsData(ws)

    // "rpc" means this is a request calling the server or client
    if (msg.type === 'rpc') {
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'server') {
        // client->server call
        if (!isStream) {
          // normal RPC
          const fn = serverProcs[method]
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
          const streamFn = serverStreamers[method]
          if (!streamFn) {
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
          // Indicate streaming start
          sendJson(ws, {
            type: 'rpc-res',
            reqId,
            ok: true,
            streaming: true,
          })
          data.activeServerStreams.set(reqId, gen)
          pushServerStream(ws, reqId, gen).catch((err) => {
            console.error('Server streaming error:', err)
          })
        }
      } else {
        // side==='client' => the server would be calling the client's procedures,
        // but we are on the server. Possibly a mismatch => respond with error:
        sendJson(ws, {
          type: 'rpc-res',
          reqId,
          ok: false,
          error: "Got side='client' call on the server; ignoring.",
        })
      }
    }

    // "rpc-res" => a response to a server->client call we made
    else if (msg.type === 'rpc-res') {
      const reqId = msg.reqId
      const pc = data.pendingCalls.get(reqId)
      if (!pc) return
      if (msg.ok) {
        if (!msg.streaming) {
          data.pendingCalls.delete(reqId)
          pc.resolve(msg.data)
        } else {
          // streaming started
          pc.resolve(undefined)
        }
      } else {
        data.pendingCalls.delete(reqId)
        pc.reject(new Error(msg.error || 'Unknown error'))
      }
    }

    // "stream-chunk", "stream-end", "stream-error" => part of a stream from client->server
    else if (msg.type === 'stream-chunk') {
      const reqId = msg.reqId
      const pc = data.pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      pc.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const reqId = msg.reqId
      const pc = data.pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      data.pendingCalls.delete(reqId)
      pc.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const reqId = msg.reqId
      const pc = data.pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      data.pendingCalls.delete(reqId)
      pc.streamController?.error(new Error(msg.error || 'Unknown stream error'))
    }

    // "cancel" not implemented in these examples
  }

  async function pushServerStream(ws: uWS.WebSocket, reqId: number, gen: AsyncGenerator<any>) {
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
