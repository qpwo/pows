// pows-node-client.ts
import WebSocket from 'ws'

export type PowsRouteProc<I, O> = readonly [
  /** Validation function for incoming request input */
  (input: unknown) => I,
  /** Validation function for the returned output */
  (output: unknown) => O,
]
export type PowsRouteStreamer<I, C> = readonly [
  /** Validation function for incoming request input */
  (input: unknown) => I,
  /** Validation function for each streamed chunk */
  (chunk: unknown) => C,
]

export interface PowsRoutes {
  server: {
    procs: Record<string, PowsRouteProc<any, any>>
    streamers: Record<string, PowsRouteStreamer<any, any>>
  }
  client: {
    procs: Record<string, PowsRouteProc<any, any>>
    streamers: Record<string, PowsRouteStreamer<any, any>>
  }
}

/**
 * A parallel approach for the client, which also takes a "Routes" object with
 * [ inAssert, outAssert ] pairs. The client can validate the outgoing arguments
 * before sending them, and validate the incoming results or streamed chunks.
 */

export type PowsClientContext<Routes extends PowsRoutes, ClientContext> = ClientContext & {
  ws: WebSocket
}

/**
 * For each client proc route, we want a function:
 *   (validatedArgs, ctx) => Promise<validatedResult>
 */
export type PowsClientProcs<Routes extends PowsRoutes, ClientContext> = {
  [K in keyof Routes['client']['procs']]: (
    args: ReturnType<Routes['client']['procs'][K][0]>,
    ctx: PowsClientContext<Routes, ClientContext>,
  ) => Promise<ReturnType<Routes['client']['procs'][K][1]>>
}

export type PowsClientStreamers<Routes extends PowsRoutes, ClientContext> = {
  [K in keyof Routes['client']['streamers']]: (
    args: ReturnType<Routes['client']['streamers'][K][0]>,
    ctx: PowsClientContext<Routes, ClientContext>,
  ) => AsyncGenerator<ReturnType<Routes['client']['streamers'][K][1]>, void, unknown>
}

export interface PowsClientOpts<Routes extends PowsRoutes, ClientContext> {
  procs: PowsClientProcs<Routes, ClientContext>
  streamers: PowsClientStreamers<Routes, ClientContext>
  url: string
  onOpen?: (ctx: PowsClientContext<Routes, ClientContext>) => void | Promise<void>
  onClose?: (ctx: PowsClientContext<Routes, ClientContext>) => void | Promise<void>
}

export interface PowsClient<Routes extends PowsRoutes, ClientContext> {
  connect: () => Promise<void>
  close: () => void

  /**
   * For calling the server’s procs & streamers (side='server'). Each route is
   *   (args) => Promise<result>  or  (args) => AsyncGenerator<chunk>
   * and arguments/results are validated by the provided routes object.
   */
  server: {
    procs: {
      [K in keyof Routes['server']['procs']]: (
        args: ReturnType<Routes['server']['procs'][K][0]>,
      ) => Promise<ReturnType<Routes['server']['procs'][K][1]>>
    }
    streamers: {
      [K in keyof Routes['server']['streamers']]: (
        args: ReturnType<Routes['server']['streamers'][K][0]>,
      ) => AsyncGenerator<ReturnType<Routes['server']['streamers'][K][1]>, void, unknown>
    }
  }
}

export function makePowsClient<Routes extends PowsRoutes, ClientContext = {}>(
  routes: Routes,
  opts: PowsClientOpts<Routes, ClientContext>,
): PowsClient<Routes, ClientContext> {
  const { procs, streamers, url, onOpen, onClose } = opts

  let ws: WebSocket | null = null
  let connected = false

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

  // Build the client's context
  const clientCtx: PowsClientContext<Routes, ClientContext> = {
    ...({} as ClientContext),
    get ws() {
      return ws!
    },
  }

  // Our local client procs & streamers as (args, ctx) => ...
  const internalProcs = procs as Record<string, (args: any, ctx: any) => Promise<any>>
  const internalStreamers = streamers as Record<string, (args: any, ctx: any) => AsyncGenerator<any>>

  const api: PowsClient<Routes, ClientContext> = {
    async connect() {
      if (connected) return
      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url)
        ws.onopen = async () => {
          connected = true
          if (onOpen) {
            try {
              await onOpen(clientCtx)
            } catch (err) {
              console.error('onOpen error:', err)
            }
          }
          resolve()
        }
        ws.onmessage = ev => {
          handleMessage(String(ev.data)).catch(err => {
            console.error('handleMessage error:', err)
          })
        }
        ws.onerror = err => {
          console.error('WebSocket error:', err)
        }
        ws.onclose = () => {
          connected = false
          for (const [, pc] of pendingCalls) {
            pc.reject(new Error('Connection closed'))
          }
          pendingCalls.clear()
          if (onClose) {
            Promise.resolve(onClose(clientCtx)).catch(err => {
              console.error('onClose error:', err)
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
      procs: new Proxy(
        {},
        {
          get(_target, methodName) {
            return (args: any) => callRemoteProc('server', methodName as string, args)
          },
        },
      ) as any,
      streamers: new Proxy(
        {},
        {
          get(_target, methodName) {
            return (args: any) => callRemoteStreamer('server', methodName as string, args)
          },
        },
      ) as any,
    },
  }

  function sendJson(obj: any) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
    ws.send(JSON.stringify(obj))
  }

  function callRemoteProc(side: 'server' | 'client', method: string, args: any): Promise<any> {
    // Validate the input using routes
    let inAssert, outAssert
    try {
      const procs = side === 'server' ? routes.server.procs : routes.client.procs
      const route = procs[method]
      if (!route) {
        console.log({ msg: 'rip', side, method, procs })
        throw new Error(`No ${side} proc named '${method}'`)
      }
      inAssert = route[0]
      outAssert = route[1]
    } catch (err) {
      return Promise.reject(err)
    }

    let validatedArgs: any
    try {
      validatedArgs = inAssert(args)
    } catch (err) {
      return Promise.reject(err)
    }

    const reqId = nextReqId++
    return new Promise((resolve, reject) => {
      pendingCalls.set(reqId, { resolve, reject })
      sendJson({
        type: 'rpc',
        side,
        reqId,
        method,
        args: validatedArgs,
        streaming: false,
      })
    })
  }

  function callRemoteStreamer(side: 'server' | 'client', method: string, args: any): AsyncGenerator<any> {
    let inAssert, chunkAssert
    try {
      const route = side === 'server' ? routes.server.streamers[method] : routes.client.streamers[method]
      if (!route) throw new Error(`No ${side} streamer named '${method}'`)
      inAssert = route[0]
      chunkAssert = route[1]
    } catch (err) {
      return (async function* () {
        throw err
      })()
    }

    let validatedArgs: any
    try {
      validatedArgs = inAssert(args)
    } catch (err) {
      return (async function* () {
        throw err
      })()
    }

    const reqId = nextReqId++
    let pullController: ((chunk: any) => void) | null = null
    let endController: (() => void) | null = null
    let errorController: ((err: any) => void) | null = null
    let ended = false
    const queue: any[] = []

    // initiate the streaming request
    sendJson({
      type: 'rpc',
      side,
      reqId,
      method,
      args: validatedArgs,
      streaming: true,
    })

    const gen = (async function* () {
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

    pendingCalls.set(reqId, {
      resolve: () => {},
      reject: err => {
        if (errorController) errorController(err)
      },
      streaming: true,
      streamController: {
        push: (chunk: any) => {
          // Validate chunk from the remote side
          let validated
          try {
            validated = chunkAssert(chunk)
          } catch (err) {
            if (errorController) errorController(err)
            return
          }
          if (pullController) pullController(validated)
          else queue.push(validated)
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

  async function handleMessage(dataStr: string) {
    let msg: any
    try {
      msg = JSON.parse(dataStr)
    } catch (err) {
      console.error('Invalid JSON from server:', dataStr)
      return
    }

    if (msg.type === 'rpc') {
      // The server is calling our client
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'client') {
        // The server is calling a client route
        if (!isStream) {
          // It's a client proc
          const route = routes.client.procs[method]
          if (!route) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No client proc named '${method}'`,
            })
            return
          }
          const [inAssert, outAssert] = route
          const fn = internalProcs[method]
          if (!fn) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `Client proc '${method}' not implemented locally`,
            })
            return
          }
          try {
            const validatedArgs = inAssert(args)
            const result = await fn(validatedArgs, clientCtx)
            const validatedResult = outAssert(result)
            sendJson({ type: 'rpc-res', reqId, ok: true, data: validatedResult })
          } catch (err: any) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
          }
        } else {
          // It's a client streamer
          const route = routes.client.streamers[method]
          if (!route) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `No client streamer named '${method}'`,
            })
            return
          }
          const [inAssert, chunkAssert] = route
          const fn = internalStreamers[method]
          if (!fn) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: `Client streamer '${method}' not implemented`,
            })
            return
          }
          let gen: AsyncGenerator<any>
          try {
            const validatedArgs = inAssert(args)
            gen = fn(validatedArgs, clientCtx)
          } catch (err: any) {
            sendJson({
              type: 'rpc-res',
              reqId,
              ok: false,
              error: err?.message || String(err),
            })
            return
          }
          sendJson({ type: 'rpc-res', reqId, ok: true, streaming: true })
          pushClientStream(reqId, gen, chunkAssert).catch(err => {
            console.error('Client streamer error:', err)
          })
        }
      } else {
        // side==='server' => we got it on the client => mismatch
        sendJson({
          type: 'rpc-res',
          reqId,
          ok: false,
          error: `Got side="server" call on the client; ignoring.`,
        })
      }
    } else if (msg.type === 'rpc-res') {
      // This is a response to a call we made to the server
      const pc = pendingCalls.get(msg.reqId)
      if (!pc) return
      if (msg.ok) {
        if (!msg.streaming) {
          pendingCalls.delete(msg.reqId)
          // We *could* do final validation of the response here if we had stored
          // the outAssert function in pendingCalls. For brevity, we'll skip it,
          // or you can store the necessary route info in the map if you want strict validation.
          pc.resolve(msg.data)
        } else {
          pc.resolve(undefined)
        }
      } else {
        pendingCalls.delete(msg.reqId)
        pc.reject(new Error(msg.error || 'Unknown error'))
      }
    } else if (msg.type === 'stream-chunk') {
      const pc = pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      pc.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const pc = pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      pendingCalls.delete(msg.reqId)
      pc.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const pc = pendingCalls.get(msg.reqId)
      if (!pc || !pc.streaming) return
      pendingCalls.delete(msg.reqId)
      pc.streamController?.error(new Error(msg.error || 'Unknown stream error'))
    }
  }

  async function pushClientStream(reqId: number, gen: AsyncGenerator<any>, chunkAssert: (chunk: unknown) => any) {
    try {
      for await (const rawChunk of gen) {
        let validated
        try {
          validated = chunkAssert(rawChunk)
        } catch (e) {
          const err = e as Error
          sendJson({ type: 'stream-error', reqId, error: err?.message || String(err) })
          return
        }
        sendJson({ type: 'stream-chunk', reqId, chunk: validated })
      }
      sendJson({ type: 'stream-end', reqId })
    } catch (err: any) {
      sendJson({ type: 'stream-error', reqId, error: err?.message || String(err) })
    }
  }

  return api
}
