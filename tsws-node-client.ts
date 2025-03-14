// tsws-node-client.ts
import WebSocket from 'ws'
import { RoutesConstraint } from './tsws-node-server'

/**
 * CLIENT-SIDE ROUTE SIGNATURES
 *
 * In the "example-big-client.ts", you have:
 *   approve(_: { question: string }): Promise<{ approved: boolean }>
 * but you implement:
 *   async approve({ question }, ctx) { ... }
 *
 * We want the final type: (args: { question: string }, ctx: TswsClientContext<...>) => ...
 * so destructuring "question" is typed, and "ctx" is typed.
 */
type ClientProc<Fn, Ctx> = Fn extends (args: infer A) => infer R ? (args: A, ctx: Ctx) => R : never

type ClientStreamer<Fn, Ctx> = Fn extends (args: infer A) => infer R ? (args: A, ctx: Ctx) => R : never

/**
 * For calling the *server* from the client, we want to expose "server.procs.foo"
 * as a single-parameter method (args) => ReturnType, with *no* `ctx`.
 */
type CallServerProc<Fn> = Fn extends (args: infer A) => infer R ? (args: A) => R : never

type CallServerStreamer<Fn> = Fn extends (args: infer A) => infer R ? (args: A) => R : never

/**
 * The user’s "Routes" interface is conceptually:
 *   {
 *     server: {
 *       procs: (args) => Promise<any>,
 *       streamers: (args) => AsyncGenerator<any>
 *     },
 *     client: {
 *       procs: (args) => Promise<any>,
 *       streamers: (args) => AsyncGenerator<any>
 *     }
 *   }
 */
export type TswsClientContext<Routes extends RoutesConstraint, ClientContext> = ClientContext & {
  ws: WebSocket
}

type TswsClientProcs<Routes extends RoutesConstraint, ClientContext> = {
  [K in keyof Routes['client']['procs']]: ClientProc<Routes['client']['procs'][K], TswsClientContext<Routes, ClientContext>>
}
type TswsClientStreamers<Routes extends RoutesConstraint, ClientContext> = {
  [K in keyof Routes['client']['streamers']]: ClientStreamer<Routes['client']['streamers'][K], TswsClientContext<Routes, ClientContext>>
}

export interface TswsClientOpts<Routes extends RoutesConstraint, ClientContext> {
  // The user's local implementations for client procs & streamers:
  procs: TswsClientProcs<Routes, ClientContext>
  streamers: TswsClientStreamers<Routes, ClientContext>

  url: string
  onOpen?: (ctx: TswsClientContext<Routes, ClientContext>) => void | Promise<void>
  onClose?: (ctx: TswsClientContext<Routes, ClientContext>) => void | Promise<void>
}

export interface TswsClient<Routes extends RoutesConstraint, ClientContext> {
  connect: () => Promise<void>
  close: () => void
  /**
   * For calling the server’s procs & streamers. These do NOT take `ctx`.
   * The user calls e.g. `api.server.procs.square({ x: 5 })`.
   */
  server: {
    procs: {
      [K in keyof Routes['server']['procs']]: CallServerProc<Routes['server']['procs'][K]>
    }
    streamers: {
      [K in keyof Routes['server']['streamers']]: CallServerStreamer<Routes['server']['streamers'][K]>
    }
  }
}

/**
 * Implementation
 */
export function makeTswsClient<Routes extends RoutesConstraint, ClientContext = {}>(
  opts: TswsClientOpts<Routes, ClientContext>,
): TswsClient<Routes, ClientContext> {
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

  // The user’s client context
  const clientCtx: TswsClientContext<Routes, ClientContext> = {
    ...({} as ClientContext),
    get ws() {
      return ws!
    },
  }

  // Internally, treat procs/streamers as (args: any, ctx: any) => any
  const internalProcs = procs as Record<string, (args: any, ctx: any) => Promise<any>>
  const internalStreamers = streamers as Record<string, (args: any, ctx: any) => AsyncGenerator<any>>

  // For calling the server
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
      sendJson({
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

    pendingCalls.set(reqId, {
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

  async function handleMessage(dataStr: string) {
    let msg: any
    try {
      msg = JSON.parse(dataStr)
    } catch (err) {
      console.error('Invalid JSON from server:', dataStr)
      return
    }

    if (msg.type === 'rpc') {
      // server calling this client
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'client') {
        if (!isStream) {
          const fn = internalProcs[method]
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
          const fn = internalStreamers[method]
          if (!fn) {
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
            gen = fn(args, clientCtx)
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
          pushClientStream(reqId, gen).catch(err => {
            console.error('Client streamer error:', err)
          })
        }
      } else {
        // side==='server' => we got it on the client => mismatch
        sendJson({
          type: 'rpc-res',
          reqId,
          ok: false,
          error: 'Got side="server" call on the client; ignoring.',
        })
      }
    } else if (msg.type === 'rpc-res') {
      const pc = pendingCalls.get(msg.reqId)
      if (!pc) return
      if (msg.ok) {
        if (!msg.streaming) {
          pendingCalls.delete(msg.reqId)
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
