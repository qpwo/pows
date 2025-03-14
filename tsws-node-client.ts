// tsws-node-client.ts

import WebSocket from 'ws'

/**
 * A similar protocol definition as the server. For brevity, we replicate it here.
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
    }

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * The client calls "server" methods, and can also implement "client" methods (if the server calls them).
 */
export function makeTswsClient<
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
  ClientContext = {}
>(
  clientImpl: Partial<Routes['client']['procs']> &
    Partial<Routes['client']['streamers']>,
  options: {
    url: string
    /** Called on unexpected close/error (optional) */
    onClose?: (event: { code: number; reason: string }) => void
  }
) {
  const { url, onClose } = options

  let ws: WebSocket | null = null

  // track pending requests from us -> server
  const pendingRequests = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()

  // track streams from us -> server (outbound streams) – not typically needed if
  // we assume the server is only the yield side, but let's keep symmetrical
  const outboundStreams = new Map<
    string,
    {
      generator: AsyncGenerator<unknown, void, unknown> | Generator<unknown, void, unknown>
      cancel?: () => void
    }
  >()

  // track inbound streams from the server -> us
  // i.e. we call server.streamers.foo() and yield as we get data
  interface InboundStream {
    queue: { value: unknown; done?: boolean }[]
    done: boolean
    error: any
    onData?: () => void
  }
  const inboundStreams = new Map<string, InboundStream>()

  // Create a "server" proxy for calling server procs
  const server = {
    procs: new Proxy(
      {},
      {
        get(_target, prop: string) {
          return async (...args: unknown[]) => {
            if (!ws || ws.readyState !== ws.OPEN) {
              throw new Error('WebSocket is not open.')
            }
            const id = newId()
            return new Promise((resolve, reject) => {
              pendingRequests.set(id, { resolve, reject })
              const msg: TswsMessage = {
                type: 'rpc',
                route: 'server',
                id,
                procName: prop,
                args,
              }
              ws.send(JSON.stringify(msg))
            })
          }
        },
      }
    ) as Routes['server']['procs'],
    streamers: new Proxy(
      {},
      {
        get(_target, prop: string) {
          return (...args: unknown[]) => {
            if (!ws || ws.readyState !== ws.OPEN) {
              throw new Error('WebSocket is not open.')
            }
            const id = newId()
            // Start the stream by sending a 'stream_start' message
            const startMsg: TswsMessage = {
              type: 'stream_start',
              route: 'server',
              id,
              procName: prop,
              args,
            }

            // Return an async generator
            const gen = (async function* () {
              // create a record for inbound stream data
              const streamObj: InboundStream = {
                queue: [],
                done: false,
                error: null,
              }
              inboundStreams.set(id, streamObj)

              // Actually send the start message
              ws.send(JSON.stringify(startMsg))

              try {
                while (!streamObj.done) {
                  // Wait until we have something
                  if (!streamObj.queue.length && !streamObj.error) {
                    await new Promise<void>(r => {
                      streamObj.onData = r
                    })
                    streamObj.onData = undefined
                  }
                  if (streamObj.error) {
                    throw streamObj.error
                  }
                  while (streamObj.queue.length) {
                    const chunk = streamObj.queue.shift()!
                    yield chunk.value
                  }
                  if (streamObj.done) {
                    break
                  }
                }
              } finally {
                inboundStreams.delete(id)
              }
            })()
            return gen
          }
        },
      }
    ) as Routes['server']['streamers'],
  }

  // We'll handle messages from the server that call "client" procs/streamers
  async function handleServerCall(msg: TswsMessage) {
    if (!('procName' in msg)) return
    const { procName, args, id } = msg
    if (msg.type === 'rpc' && msg.route === 'client') {
      // This is the server calling the client's procs
      const fn = (clientImpl as any)[procName]
      if (typeof fn !== 'function') {
        // error
        const resp: TswsMessage = {
          type: 'rpc_result',
          id,
          error: `Client procedure not found: ${procName}`,
        }
        ws?.send(JSON.stringify(resp))
        return
      }
      try {
        const result = await fn(args)
        const resp: TswsMessage = {
          type: 'rpc_result',
          id,
          success: result,
        }
        ws?.send(JSON.stringify(resp))
      } catch (err: any) {
        const resp: TswsMessage = {
          type: 'rpc_result',
          id,
          error: String(err?.message || err),
        }
        ws?.send(JSON.stringify(resp))
      }
    } else if (msg.type === 'stream_start' && msg.route === 'client') {
      // The server is starting a stream on the client
      const fn = (clientImpl as any)[procName]
      if (typeof fn !== 'function') {
        const e: TswsMessage = {
          type: 'stream_error',
          id,
          error: `Client streamer not found: ${procName}`,
        }
        ws?.send(JSON.stringify(e))
        return
      }
      try {
        const gen = fn(args)
        // read from generator and push results
        ;(async () => {
          try {
            for await (const val of gen) {
              const resp: TswsMessage = {
                type: 'stream_next',
                id,
                value: val,
              }
              ws?.send(JSON.stringify(resp))
            }
            const done: TswsMessage = {
              type: 'stream_complete',
              id,
            }
            ws?.send(JSON.stringify(done))
          } catch (err: any) {
            const e: TswsMessage = {
              type: 'stream_error',
              id,
              error: String(err?.message || err),
            }
            ws?.send(JSON.stringify(e))
          }
        })()
      } catch (err: any) {
        const e: TswsMessage = {
          type: 'stream_error',
          id,
          error: String(err?.message || err),
        }
        ws?.send(JSON.stringify(e))
      }
    }
  }

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url)
      ws.on('open', () => {
        resolve()
      })
      ws.on('error', (err) => {
        reject(err)
      })
      ws.on('message', (data: Buffer) => {
        let msg: TswsMessage
        try {
          msg = JSON.parse(data.toString())
        } catch (err) {
          return
        }
        switch (msg.type) {
          case 'rpc_result': {
            const pending = pendingRequests.get(msg.id)
            if (pending) {
              pendingRequests.delete(msg.id)
              if (msg.error) {
                pending.reject(new Error(msg.error))
              } else {
                pending.resolve(msg.success)
              }
            }
            break
          }
          case 'rpc': {
            // inbound call (server calling client)
            handleServerCall(msg)
            break
          }
          case 'stream_start': {
            // inbound streaming from server => client
            handleServerCall(msg)
            break
          }
          case 'stream_next': {
            const streamObj = inboundStreams.get(msg.id)
            if (streamObj) {
              streamObj.queue.push({ value: msg.value })
              streamObj.onData?.()
            }
            break
          }
          case 'stream_error': {
            const streamObj = inboundStreams.get(msg.id)
            if (streamObj) {
              streamObj.error = new Error(msg.error)
              streamObj.onData?.()
            }
            break
          }
          case 'stream_complete': {
            const streamObj = inboundStreams.get(msg.id)
            if (streamObj) {
              streamObj.done = true
              streamObj.onData?.()
            }
            break
          }
        }
      })
      ws.on('close', (code, reason) => {
        onClose?.({ code, reason: reason.toString() })
      })
    })
  }

  function close() {
    ws?.close()
  }

  return {
    connect,
    close,
    server,
  }
}
