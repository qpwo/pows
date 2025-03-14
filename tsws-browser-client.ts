// tsws-browser-client.ts

// Constrain Routes so we can index Routes['client'] / Routes['server'] safely:
export function makeTswsBrowserClient<
  Routes extends {
    server: { procs: Record<string, any>; streamers: Record<string, any> }
    client: { procs: Record<string, any>; streamers: Record<string, any> }
  },
  Context = Record<string, any>,
>(
  clientHandlers: Partial<Routes['client']['procs'] & Routes['client']['streamers']>,
  options: {
    url: string
  },
) {
  let ws: WebSocket
  const wsUrl = options.url

  let globalReqId = 0
  function newRequestId() {
    globalReqId++
    return 'cli_' + globalReqId
  }

  // Track calls from browser->server:
  const pendingClientCalls = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>()

  interface StreamState {
    done: boolean
    queue: any[]
    error: any
  }
  const clientStreams = new Map<string, StreamState>()

  // Proxies to call server.procs
  const serverProcs = new Proxy(
    {},
    {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          return new Promise((resolve, reject) => {
            pendingClientCalls.set(id, { resolve, reject })
            ws.send(
              JSON.stringify({
                type: 'proc',
                side: 'server' as const,
                name: methodName,
                id,
                args,
              }),
            )
          })
        }
      },
    },
  ) as Routes['server']['procs']

  // Proxies to call server.streamers
  const serverStreamers = new Proxy(
    {},
    {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          const state: StreamState = { done: false, queue: [], error: null }
          clientStreams.set(id, state)
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              side: 'server' as const,
              name: methodName,
              id,
              args,
            }),
          )
          return (async function* () {
            try {
              while (true) {
                if (state.queue.length > 0) {
                  yield state.queue.shift()
                  continue
                }
                if (state.error) {
                  throw state.error
                }
                if (state.done) {
                  break
                }
                await new Promise(res => setTimeout(res, 50))
              }
            } finally {
              if (!state.done) {
                ws.send(JSON.stringify({ type: 'stream_stop', id }))
              }
            }
          })()
        }
      },
    },
  ) as Routes['server']['streamers']

  function handleMessage(ev: MessageEvent) {
    let msg: any
    try {
      msg = JSON.parse(ev.data)
    } catch (err) {
      console.error('Browser client received invalid JSON:', ev.data)
      return
    }

    const { type, side, id, name, args } = msg

    // Response to a client->server call:
    if (type === 'proc_result') {
      const pending = pendingClientCalls.get(id)
      if (!pending) return
      pendingClientCalls.delete(id)
      if ('error' in msg) {
        pending.reject(msg.error)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (type === 'stream_chunk') {
      const st = clientStreams.get(id)
      if (!st) return
      st.queue.push(msg.chunk)
      return
    }

    if (type === 'stream_end') {
      const st = clientStreams.get(id)
      if (!st) return
      if (msg.error) {
        st.error = msg.error
      }
      st.done = true
      return
    }

    // Server->client calls:
    if (type === 'proc' && side === 'client') {
      const fn = (clientHandlers as any)[name]
      if (typeof fn !== 'function') {
        ws.send(JSON.stringify({ type: 'proc_result', id, error: `No such client proc: ${name}` }))
        return
      }
      let ctx: Context & { ws: WebSocket } = { ws } as any
      try {
        const result = fn(args, ctx)
        if (result && typeof result[Symbol.asyncIterator] === 'function') {
          ;(async () => {
            try {
              for await (const chunk of result) {
                ws.send(JSON.stringify({ type: 'stream_chunk', id, chunk }))
              }
              ws.send(JSON.stringify({ type: 'stream_end', id }))
            } catch (err) {
              ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
            }
          })()
        } else {
          Promise.resolve(result)
            .then(res => {
              ws.send(JSON.stringify({ type: 'proc_result', id, result: res }))
            })
            .catch(err => {
              ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
            })
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'proc_result', id, error: String(err) }))
      }
      return
    }

    if (type === 'stream_start' && side === 'client') {
      const fn = (clientHandlers as any)[name]
      if (typeof fn !== 'function') {
        ws.send(JSON.stringify({ type: 'stream_end', id, error: `No such client streamer: ${name}` }))
        return
      }
      let ctx: Context & { ws: WebSocket } = { ws } as any
      try {
        const gen = fn(args, ctx)
        if (!gen || typeof gen[Symbol.asyncIterator] !== 'function') {
          ws.send(JSON.stringify({ type: 'stream_end', id, error: `${name} is not an async generator` }))
          return
        }
        ;(async () => {
          try {
            for await (const chunk of gen) {
              ws.send(JSON.stringify({ type: 'stream_chunk', id, chunk }))
            }
            ws.send(JSON.stringify({ type: 'stream_end', id }))
          } catch (err) {
            ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
          }
        })()
      } catch (err) {
        ws.send(JSON.stringify({ type: 'stream_end', id, error: String(err) }))
      }
      return
    }

    if (type === 'stream_stop') {
      // Not implemented.
      return
    }
  }

  return {
    async connect() {
      return new Promise<void>((resolve, reject) => {
        ws = new WebSocket(wsUrl)
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', err => reject(err))
        ws.addEventListener('message', handleMessage)
      })
    },

    server: {
      procs: serverProcs,
      streamers: serverStreamers,
    },
  }
}
