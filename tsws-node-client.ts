// tsws-node-client.ts

import WebSocket from 'ws'

function isAsyncGenerator(obj: any): obj is AsyncGenerator {
  return obj && typeof obj[Symbol.asyncIterator] === 'function'
}

let globalReqId = 0
function newRequestId() {
  globalReqId++
  return 'cli_' + globalReqId
}

/**
 * Create a Node.js WebSocket client (using 'ws') with
 * typed server calls + typed client handlers (so the server can call back).
 */
export function makeTswsClient<Routes, Context = Record<string, any>>(
  /**
   * The client’s own `client.procs` / `client.streamers` implementation,
   * i.e. what the server can call.
   */
  clientHandlers: Partial<Routes['client']['procs'] & Routes['client']['streamers']>,
  options: {
    url: string
  }
) {
  const wsUrl = options.url
  let ws: WebSocket

  // Tracks requests from the client->server. Keyed by request ID.
  const pendingClientCalls = new Map<
    string,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >()

  // For streaming calls from client->server
  interface StreamState {
    done: boolean
    queue: any[]
    error: any
  }
  // Map from stream ID to the state
  const clientStreams = new Map<string, StreamState>()

  // For server->client calls, we need to handle them with `clientHandlers`.
  // The server can do either normal calls or streaming calls on the client.

  /**
   * The object that the user calls to invoke `server.procs`.
   */
  const serverProcs = new Proxy(
    {},
    {
      get(_, methodName: string) {
        // Return a function that calls the server's method
        return (...args: any[]) => {
          const id = newRequestId()
          return new Promise((resolve, reject) => {
            pendingClientCalls.set(id, { resolve, reject })
            const msg = {
              type: 'proc',
              side: 'server' as const,
              name: methodName,
              id,
              args
            }
            ws.send(JSON.stringify(msg))
          })
        }
      }
    }
  ) as Routes['server']['procs']

  /**
   * The object that the user calls to invoke `server.streamers`.
   * Each method returns an AsyncGenerator that yields server "chunk" messages.
   */
  const serverStreamers = new Proxy(
    {},
    {
      get(_, methodName: string) {
        // Return a function that starts a streaming call
        return (...args: any[]) => {
          const id = newRequestId()
          // Create the state
          const state: StreamState = {
            done: false,
            queue: [],
            error: null
          }
          clientStreams.set(id, state)

          // Send the start message
          ws.send(
            JSON.stringify({
              type: 'stream_start',
              side: 'server' as const,
              name: methodName,
              id,
              args
            })
          )

          // Return an AsyncGenerator
          return (async function* () {
            try {
              while (true) {
                // If there's something in the queue, yield it
                if (state.queue.length > 0) {
                  yield state.queue.shift()
                  continue
                }
                // If there's an error, throw
                if (state.error) {
                  throw state.error
                }
                // If done, break
                if (state.done) {
                  break
                }
                // Otherwise, wait a bit
                await new Promise(res => setTimeout(res, 50))
              }
            } finally {
              // If generator is closed early, we can send a stop
              if (!state.done) {
                ws.send(JSON.stringify({ type: 'stream_stop', id }))
              }
            }
          })()
        }
      }
    }
  ) as Routes['server']['streamers']

  // Now define how we handle inbound messages (server->client calls or responses).
  function handleMessage(data: WebSocket.Data) {
    let str: string
    if (typeof data === 'string') {
      str = data
    } else {
      str = data.toString()
    }
    let msg: any
    try {
      msg = JSON.parse(str)
    } catch (err) {
      console.error('Client received invalid JSON:', str)
      return
    }

    const { type, side, id, name, args } = msg

    // 1. If it's a response to a client->server call:
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

    // 2. If it's a request from server->client (side === 'client'):
    if (type === 'proc' && side === 'client') {
      const fn = (clientHandlers as any)[name]
      if (typeof fn !== 'function') {
        // Return error
        ws.send(JSON.stringify({ type: 'proc_result', id, error: `No such client proc: ${name}` }))
        return
      }
      let ctx: Context & { ws: WebSocket } = { ws } as any
      try {
        const result = fn(args, ctx)
        if (isAsyncGenerator(result)) {
          // It's a stream
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
      // The server wants to stop the stream. Not fully implemented here.
      return
    }
  }

  return {
    /**
     * Connect to the server. Resolves once the WebSocket is open.
     */
    connect() {
      return new Promise<void>((resolve, reject) => {
        ws = new WebSocket(wsUrl)
        ws.on('open', () => {
          resolve()
        })
        ws.on('error', err => {
          reject(err)
        })
        ws.on('message', handleMessage)
      })
    },

    /**
     * Access the server’s methods:
     *   - `api.server.procs.someMethod(...)`
     *   - `api.server.streamers.someStreamer(...)`
     */
    server: {
      procs: serverProcs,
      streamers: serverStreamers
    }
  }
}
