// tsws-node-client.ts

import WebSocket from 'ws'
import { RoutesConstraint } from './tsws-node-server'

/**
 * Client context that is passed to "client" procs when called by the server.
 * It includes the raw ws (Node 'ws' module).
 */
export type TswsClientContext<Routes extends RoutesConstraint, ClientContext> = ClientContext & {
  ws: WebSocket
}

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

export interface TswsClient<Routes extends RoutesConstraint, ClientContext> {
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

export function makeTswsClient<
  Routes extends RoutesConstraint,
  ClientContext = {}
>(opts: TswsClientOpts<Routes, ClientContext>): TswsClient<Routes, ClientContext> {
  const { procs: clientProcs, streamers: clientStreamers, url, onOpen, onClose } = opts

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

  // The context we pass to client procs (server->client calls).
  const clientCtx: TswsClientContext<Routes, ClientContext> = {
    ...({} as ClientContext),
    get ws() {
      return ws!
    },
  }

  // Build the main API object
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
        ws.onmessage = (ev) => {
          handleMessage(String(ev.data)).catch((err) => {
            console.error('Error in handleMessage:', err)
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

    // We'll create dynamic proxies for server.procs and server.streamers:
    server: {
      procs: new Proxy(
        {},
        {
          get(_target, methodName) {
            return (args: any) => callRemoteProc('server', methodName as string, args)
          },
        }
      ) as any,
      streamers: new Proxy(
        {},
        {
          get(_target, methodName) {
            return (args: any) => callRemoteStreamer('server', methodName as string, args)
          },
        }
      ) as any,
    },
  }

  // Send JSON only if ws is open
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

  function callRemoteStreamer(
    side: 'server' | 'client',
    method: string,
    args: any
  ): AsyncGenerator<any> {
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

  async function handleMessage(jsonStr: string) {
    let msg: any
    try {
      msg = JSON.parse(jsonStr)
    } catch (e) {
      console.error('Invalid JSON from server:', jsonStr)
      return
    }

    // type='rpc' => server calling the client
    if (msg.type === 'rpc') {
      const side = msg.side as 'server' | 'client'
      const reqId = msg.reqId
      const method = msg.method
      const args = msg.args
      const isStream = !!msg.streaming

      if (side === 'client') {
        // The server is calling our client procs/streamers
        if (!isStream) {
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
            sendJson({ type: 'rpc-res', reqId, ok: false, error: err?.message || String(err) })
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
          // indicate streaming start
          sendJson({ type: 'rpc-res', reqId, ok: true, streaming: true })
          pushClientStream(reqId, gen).catch((err) => {
            console.error('Client streamer error:', err)
          })
        }
      } else {
        // side='server' from the server => nonsense. error out:
        sendJson({
          type: 'rpc-res',
          reqId,
          ok: false,
          error: "Got side='server' call on the client; ignoring.",
        })
      }
    }

    // type='rpc-res' => response to something we called server->client
    else if (msg.type === 'rpc-res') {
      const reqId = msg.reqId
      const pc = pendingCalls.get(reqId)
      if (!pc) return
      if (msg.ok) {
        if (!msg.streaming) {
          pendingCalls.delete(reqId)
          pc.resolve(msg.data)
        } else {
          // streaming started
          pc.resolve(undefined)
        }
      } else {
        pendingCalls.delete(reqId)
        pc.reject(new Error(msg.error || 'Unknown error'))
      }
    }

    // type='stream-chunk' => server is sending us a chunk
    else if (msg.type === 'stream-chunk') {
      const reqId = msg.reqId
      const pc = pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      pc.streamController?.push(msg.chunk)
    } else if (msg.type === 'stream-end') {
      const reqId = msg.reqId
      const pc = pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      pendingCalls.delete(reqId)
      pc.streamController?.end()
    } else if (msg.type === 'stream-error') {
      const reqId = msg.reqId
      const pc = pendingCalls.get(reqId)
      if (!pc || !pc.streaming) return
      pendingCalls.delete(reqId)
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
