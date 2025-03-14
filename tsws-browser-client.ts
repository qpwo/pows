// tsws-browser-client.ts
import { RoutesConstraint } from './tsws-node-server'

/**
 * Browser version of the TSWS client, using the standard WebSocket API.
 */

export type TswsBrowserClientContext<
  Routes extends RoutesConstraint,
  ClientContext
> = ClientContext & {
  ws: WebSocket
}

export interface TswsBrowserClientOpts<
  Routes extends RoutesConstraint,
  ClientContext
> {
  procs: Routes['client']['procs']
  streamers: Routes['client']['streamers']
  url: string
  onOpen?: (ctx: TswsBrowserClientContext<Routes, ClientContext>) => void | Promise<void>
  onClose?: (ctx: TswsBrowserClientContext<Routes, ClientContext>) => void | Promise<void>
}

export interface TswsBrowserClient<Routes extends RoutesConstraint, ClientContext> {
  connect: () => Promise<void>
  close: () => void
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

export function makeTswsBrowserClient<
  Routes extends RoutesConstraint,
  ClientContext = {}
>(opts: TswsBrowserClientOpts<Routes, ClientContext>): TswsBrowserClient<Routes, ClientContext> {
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

  const clientCtx: TswsBrowserClientContext<Routes, ClientContext> = {
    ...({} as ClientContext),
    get ws() {
      return ws!
    },
  }

  const api: TswsBrowserClient<Routes, ClientContext> = {
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
            console.error('Error handling message:', err)
          })
        }
        ws.onerror = (err) => {
          console.error('WebSocket error:', err)
        }
        ws.onclose = () => {
          connected = false
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

  // Fill in "server.procs"
  for (const methodName of Object.keys(procsForServer().serverProcs)) {
    (api.server.procs as any)[methodName] = (args: any) => {
      return callRemoteProc('server', methodName, args)
    }
  }
  // Fill in "server.streamers"
  for (const methodName of Object.keys(procsForServer().serverStreamers)) {
    (api.server.streamers as any)[methodName] = (args: any) => {
      return callRemoteStreamer('server', methodName, args)
    }
  }

  function procsForServer() {
    return {
      serverProcs: ({} as Routes['server']['procs']),
      serverStreamers: ({} as Routes['server']['streamers']),
      clientProcs: procs,
      clientStreamers: streamers,
    }
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
        if (errorController) errorController(err)
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
          if (endController) endController()
        },
        error: (err) => {
          if (errorController) errorController(err)
        },
      },
    })

    return gen
  }

  async function handleMessage(msgStr: string) {
    let msg: any
    try {
      msg = JSON.parse(msgStr)
    } catch (e) {
      console.error('Failed to parse message:', msgStr)
      return
    }

    if (msg.type === 'rpc') {
      // The server is calling our client procs?
      const side = msg.side
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'client') {
        // The server wants to call our client
        const fn = (isStream ? streamers[method] : procs[method]) as any
        if (!fn) {
          sendJson({
            type: 'rpc-res',
            reqId,
            ok: false,
            error: `No client ${isStream ? 'streamer' : 'proc'} named '${method}'`,
          })
          return
        }
        if (!isStream) {
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
          // success
          sendJson({ type: 'rpc-res', reqId, ok: true, streaming: true })
          pushClientStream(reqId, gen).catch((err) => {
            console.error('Client streamer error:', err)
          })
        }
      } else {
        // side=server from server => confusion. ignore
        sendJson({
          type: 'rpc-res',
          reqId,
          ok: false,
          error: 'Got side=server call on the client. Ignoring.',
        })
      }
    } else if (msg.type === 'rpc-res') {
      const pending = pendingCalls.get(msg.reqId)
      if (!pending) return
      if (msg.ok) {
        if (!msg.streaming) {
          pendingCalls.delete(msg.reqId)
          pending.resolve(msg.data)
        } else {
          pending.resolve(undefined)
        }
      } else {
        pendingCalls.delete(msg.reqId)
        pending.reject(new Error(msg.error || 'Unknown error'))
      }
    } else if (msg.type === 'stream-chunk') {
      const pending = pendingCalls.get(msg.reqId)
      if (!pending || !pending.streaming) return
      pending.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const pending = pendingCalls.get(msg.reqId)
      if (!pending || !pending.streaming) return
      pendingCalls.delete(msg.reqId)
      pending.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const pending = pendingCalls.get(msg.reqId)
      if (!pending || !pending.streaming) return
      pendingCalls.delete(msg.reqId)
      pending.streamController?.error(new Error(msg.error || 'Unknown stream error'))
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
