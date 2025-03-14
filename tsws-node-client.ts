// tsws-node-client.ts
import WebSocket from 'ws'
import { RoutesConstraint } from './tsws-node-server'

/**
 * The context shape we attach to each procedure or streamer callback
 * on the client side. We include `ws`, so you can see the raw WebSocket if needed.
 */
export type TswsClientContext<Routes extends RoutesConstraint, ClientContext> = ClientContext & {
  ws: WebSocket
}

/** Config for the Node client. */
export interface TswsClientOpts<
  Routes extends RoutesConstraint,
  ClientContext
> {
  procs: Routes['client']['procs']
  streamers: Routes['client']['streamers']
  url: string
  onOpen?: (ctx: TswsClientContext<Routes, ClientContext>) => void | Promise<void>
  onClose?: (ctx: TswsClientContext<Routes, ClientContext>) => void | Promise<void>
}

/** The returned object from `makeTswsClient()`. */
export interface TswsClient<Routes extends RoutesConstraint, ClientContext> {
  connect: () => Promise<void>
  close: () => void
  /** For calling server procs: `client.server.procs.foo(args)`. */
  server: {
    procs: {
      [K in keyof Routes['server']['procs']]: (
        args: Parameters<Routes['server']['procs'][K]>[0]
      ) => ReturnType<Routes['server']['procs'][K]>
    }
    streamers: {
      [K in keyof Routes['server']['streamers']]: (
        args: Parameters<Routes['server']['streamers'][K]>[0]
      ) => ReturnType<Routes['server']['streamers'][K]>
    }
  }
}

export function makeTswsClient<
  Routes extends RoutesConstraint,
  ClientContext = {}
>(opts: TswsClientOpts<Routes, ClientContext>): TswsClient<Routes, ClientContext> {
  const { procs: clientProcs, streamers: clientStreamers, url, onOpen, onClose } = opts

  let ws: WebSocket | null = null
  let connected = false

  // track requests that the client made to the server
  let nextReqId = 1
  const pendingCalls = new Map<
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
  >()

  // track active streams from server to this client
  const activeServerStreams = new Map<number, AsyncGenerator<any>>()

  // We store a context object to pass to client procs (server->client calls).
  const clientCtx: TswsClientContext<Routes, ClientContext> = {
    ...({} as ClientContext),
    get ws() {
      return ws!
    },
  }

  // Build the object that we return: server procs, server streamers, connect, close
  const api: TswsClient<Routes, ClientContext> = {
    async connect() {
      if (connected) return
      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url)
        ws.onopen = async () => {
          connected = true
          if (onOpen) {
            try {
              await onOpen(clientCtx)
            } catch (e) {
              console.error('Error in onOpen:', e)
            }
          }
          resolve()
        }
        ws.onmessage = (ev) => {
          handleMessage(ev.data).catch((err) => {
            console.error('Error handling server message:', err)
          })
        }
        ws.onerror = (err) => {
          console.error('WebSocket error:', err)
        }
        ws.onclose = () => {
          connected = false
          // finalize pending calls:
          for (const [, pc] of pendingCalls) {
            pc.reject(new Error('Connection closed'))
          }
          pendingCalls.clear()

          if (onClose) {
            Promise.resolve(onClose(clientCtx)).catch((err) => {
              console.error('Error in onClose:', err)
            })
          }
        }
      })
    },
    close() {
      if (ws && connected) {
        ws.close()
      }
      connected = false
    },
    server: {
      procs: {} as any,
      streamers: {} as any,
    },
  }

  // Fill in the "server.procs" calls
  for (const methodName of Object.keys(clientCtxRoutes().serverProcs)) {
    (api.server.procs as any)[methodName] = async (args: any) => {
      return callRemoteProc('server', methodName, args)
    }
  }
  // Fill in the "server.streamers" calls
  for (const methodName of Object.keys(clientCtxRoutes().serverStreamers)) {
    (api.server.streamers as any)[methodName] = (args: any) => {
      return callRemoteStreamer('server', methodName, args)
    }
  }

  // For the client side, we store the local procs in a table for "server->client" calls:
  function clientCtxRoutes() {
    return {
      serverProcs: ({} as Routes['server']['procs']),
      serverStreamers: ({} as Routes['server']['streamers']),
      clientProcs,
      clientStreamers,
    }
  }

  // Helper to send JSON
  function sendJson(obj: any) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
    ws.send(JSON.stringify(obj))
  }

  // Call a remote procedure on the server or client
  function callRemoteProc(side: 'server' | 'client', method: string, args: any): Promise<any> {
    const reqId = nextReqId++
    return new Promise((resolve, reject) => {
      pendingCalls.set(reqId, { resolve, reject })
      sendJson({
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: false,
      })
    })
  }

  function callRemoteStreamer(side: 'server' | 'client', method: string, args: any): AsyncGenerator<any> {
    const reqId = nextReqId++

    let pullController: ((chunk: any) => void) | null = null
    let endController: (() => void) | null = null
    let errorController: ((err: any) => void) | null = null
    let ended = false
    const queue: any[] = []

    const gen = (async function* () {
      // Send initial request
      sendJson({
        type: 'rpc',
        side,
        reqId,
        method,
        args,
        streaming: true,
      })

      // Wait for data
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift()
          yield chunk
        } else if (ended) {
          return
        } else {
          // wait for next chunk
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

    pendingCalls.set(reqId, {
      resolve: () => {},
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

  // Handle inbound messages from the server
  async function handleMessage(dataStr: string) {
    let msg: any
    try {
      msg = JSON.parse(dataStr)
    } catch (e) {
      console.error('Failed to parse message:', dataStr)
      return
    }

    // If msg.type === 'rpc', the server is calling our client procs/streamers
    if (msg.type === 'rpc') {
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'client') {
        // The server is calling a client procedure/streamer
        if (!isStream) {
          // normal call
          const fn = clientProcs[method]
          if (!fn) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No client proc named '${method}'`,
            })
            return
          }
          try {
            const result = await fn(args, clientCtx)
            sendJson({ type: 'rpc-res', reqId, ok: true, data: result })
          } catch (err: any) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
          }
        } else {
          // streaming
          const streamFn = clientStreamers[method]
          if (!streamFn) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No client streamer named '${method}'`,
            })
            return
          }
          let gen: AsyncGenerator<any>
          try {
            gen = streamFn(args, clientCtx)
          } catch (err: any) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
            return
          }
          // success
          sendJson({ type: 'rpc-res', reqId, ok: true, streaming: true })
          // push out chunks
          pushClientStream(reqId, gen).catch((err) => {
            console.error('Client streamer error:', err)
          })
        }
      } else {
        // side=server from the server? That means the server is calling the server side? Unlikely scenario
        // We ignore it or send error:
        sendJson({
          type: 'rpc-res',
          reqId,
          ok: false,
          error: 'Received side=server call on client; ignoring.',
        })
      }
    }
    // If msg.type === 'rpc-res', that is a response to our calls
    else if (msg.type === 'rpc-res') {
      const reqId = msg.reqId
      const pending = pendingCalls.get(reqId)
      if (!pending) return
      if (msg.ok) {
        if (!msg.streaming) {
          pendingCalls.delete(reqId)
          pending.resolve(msg.data)
        } else {
          // indicates streaming started
          pending.resolve(undefined)
        }
      } else {
        pendingCalls.delete(reqId)
        pending.reject(new Error(msg.error || 'Unknown error'))
      }
    }
    // If it's a streaming chunk or end or error
    else if (msg.type === 'stream-chunk') {
      const reqId = msg.reqId
      const pending = pendingCalls.get(reqId)
      if (!pending || !pending.streaming) return
      pending.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const reqId = msg.reqId
      const pending = pendingCalls.get(reqId)
      if (!pending || !pending.streaming) return
      pendingCalls.delete(reqId)
      pending.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const reqId = msg.reqId
      const pending = pendingCalls.get(reqId)
      if (!pending || !pending.streaming) return
      pendingCalls.delete(reqId)
      pending.streamController?.error(new Error(msg.error || 'Unknown stream error'))
    }
    // cancel not used in examples, skipping
  }

  async function pushClientStream(reqId: number, gen: AsyncGenerator<any>) {
    try {
      for await (const chunk of gen) {
        sendJson({ type: 'stream-chunk', reqId, chunk })
      }
      sendJson({ type: 'stream-end', reqId })
    } catch (err: any) {
      sendJson({ type: 'stream-error', reqId, error: err?.message || String(err) })
    }
  }

  return api
}
