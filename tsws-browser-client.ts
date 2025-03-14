// tsws-browser-client.ts

function isAsyncGenerator(obj: any): obj is AsyncGenerator {
  return obj && typeof obj[Symbol.asyncIterator] === 'function'
}

let globalReqId = 0
function newRequestId() {
  globalReqId++
  return 'cli_' + globalReqId
}

/**
 * Create a Browser WebSocket client (using the native `WebSocket`).
 */
export function makeTswsBrowserClient<Routes, Context = Record<string, any>>(
  clientHandlers: Partial<Routes['client']['procs'] & Routes['client']['streamers']>,
  options: {
    url: string
  },
) {
  const wsUrl = options.url
  let ws: WebSocket

  // Pending calls from the browser -> server
  const pendingClientCalls = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>()

  interface StreamState {
    done: boolean
    queue: any[]
    error: any
  }
  const clientStreams = new Map<string, StreamState>()

  // Proxies for calling `server.procs` and `server.streamers`
  const serverProcs = new Proxy(
    {},
    {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          return new Promise((resolve, reject) => {
            pendingClientCalls.set(id, { resolve, reject })
            const msg = {
              type: 'proc',
              side: 'server' as const,
              name: methodName,
              id,
              args,
            }
            ws.send(JSON.stringify(msg))
          })
        }
      },
    },
  ) as Routes['server']['procs']

  const serverStreamers = new Proxy(
    {},
    {
      get(_, methodName: string) {
        return (...args: any[]) => {
          const id = newRequestId()
          const state: StreamState = { done: false, queue: [], error: null }
          clientStreams.set(id, state)
          // Start
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              side: 'server' as const,
              name: methodName,
              id,
              args,
            }),
          )
          // Return an async generator
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
        if (isAsyncGenerator(result)) {
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
        if (!isAsyncGenerator(gen)) {
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
      // Not fully implemented. You could handle abort logic here.
      return
    }
  }

  return {
    /**
     * Connect to the server in the browser.
     */
    async connect() {
      return new Promise<void>((resolve, reject) => {
        ws = new WebSocket(wsUrl)
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', err => reject(err))
        ws.addEventListener('message', handleMessage)
      })
    },

    /**
     * Expose server calls
     */
    server: {
      procs: serverProcs,
      streamers: serverStreamers,
    },
  }
}
