// tsws-browser-client.ts

/**
 * The same protocol as before. We'll repeat it for clarity.
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

export function makeTswsBrowserClient<
  Routes extends {
    server: {
      procs: Record<string, (...args: any) => any>
      streamers: Record<string, (...args: any) => AsyncGenerator<any, any, any>>
    }
    client: {
      procs: Record<string, (...args: any) => any>
      streamers: Record<string, (...args: any) => AsyncGenerator<any, any, any>>
    }
  }
>(
  clientImpl: Partial<Routes['client']['procs']> &
    Partial<Routes['client']['streamers']>,
  options: {
    url: string
    onClose?: (ev: CloseEvent) => void
    onError?: (ev: Event) => void
  }
) {
  const { url, onClose, onError } = options
  let ws: WebSocket | null = null

  // track pending requests from us -> server
  const pendingRequests = new Map<
    string,
    {
      resolve: (val: any) => void
      reject: (err: any) => void
    }
  >()

  interface InboundStream {
    queue: { value: unknown; done?: boolean }[]
    done: boolean
    error: any
    onData?: () => void
  }
  const inboundStreams = new Map<string, InboundStream>()

  function connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(url)
      ws.onopen = () => {
        resolve()
      }
      ws.onerror = (ev) => {
        onError?.(ev)
        reject(new Error('WebSocket connection error'))
      }
      ws.onclose = (ev) => {
        onClose?.(ev)
      }
      ws.onmessage = (event) => {
        let msg: TswsMessage
        try {
          msg = JSON.parse(event.data)
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
            // server calling client
            handleServerCall(msg)
            break
          }
          case 'stream_start': {
            // server starting a stream on client
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
      }
    })
  }

  function close() {
    if (ws) {
      ws.close()
    }
  }

  async function handleServerCall(msg: TswsMessage) {
    if (!('procName' in msg)) return
    const { procName, args, id } = msg
    if (msg.type === 'rpc' && msg.route === 'client') {
      const fn = (clientImpl as any)[procName]
      if (typeof fn !== 'function') {
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

  const server = {
    procs: new Proxy(
      {},
      {
        get(_target, prop: string) {
          return async (...callArgs: unknown[]) => {
            if (!ws || ws.readyState !== ws.OPEN) {
              throw new Error('WebSocket not open')
            }
            const id = newId()
            return new Promise((resolve, reject) => {
              pendingRequests.set(id, { resolve, reject })
              const msg: TswsMessage = {
                type: 'rpc',
                route: 'server',
                id,
                procName: prop,
                args: callArgs,
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
          return (...callArgs: unknown[]) => {
            if (!ws || ws.readyState !== ws.OPEN) {
              throw new Error('WebSocket not open')
            }
            const id = newId()

            const streamObj: InboundStream = {
              queue: [],
              done: false,
              error: null,
            }
            inboundStreams.set(id, streamObj)

            // send request
            const msg: TswsMessage = {
              type: 'stream_start',
              route: 'server',
              id,
              procName: prop,
              args: callArgs,
            }
            ws.send(JSON.stringify(msg))

            const gen = (async function* () {
              try {
                while (!streamObj.done) {
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

  return {
    connect,
    close,
    server,
  }
}
