// example-load-client.ts
import { makeTswsClient } from './tsws-node-client'
import type { Routes } from './example-load-server'

type ClientCtx = {}

// We'll track how many times each call completes in `counters`
// and how many chunks each streamer yields in `chunkCounters`.
const counters: Record<string, number> = {}
const chunkCounters: Record<string, number> = {}

// We'll identify which labels are streamers.
const streamerLabels = new Set(['countUp', 'randomNumbers', 'callClientStreamerX', 'callClientStreamerY'])

// Create the client, with no logs in procs/streamers themselves:
const api = makeTswsClient<Routes, ClientCtx>({
  procs: {
    async clientProcA({ ping }) {
      return { pong: `${ping} -> clientProcA says hi!` }
    },
    async clientProcB({ question }) {
      return { answer: 'clientProcB answer: Definitely yes!' }
    },
  },
  streamers: {
    async *clientStreamerX({ hello }) {
      for (let i = 0; i < 3; i++) {
        yield `clientStreamerX chunk #${i} - responding to "${hello}"`
      }
    },
    async *clientStreamerY({ data }) {
      for (const item of data) {
        yield item * 10
      }
    },
  },
  url: 'ws://localhost:8080',
})

async function main() {
  await api.connect()

  const startTime = Date.now()

  // Define 8 tasks, each calling one server function or streamer.
  const tasks: Array<{ label: string; fn: () => Promise<void> }> = [
    {
      label: 'addOne',
      fn: async () => {
        await api.server.procs.addOne({
          value: Math.floor(Math.random() * 100),
        })
      },
    },
    {
      label: 'double',
      fn: async () => {
        await api.server.procs.double({
          value: Math.floor(Math.random() * 50),
        })
      },
    },
    {
      label: 'countUp',
      fn: async () => {
        const stream = api.server.streamers.countUp({ start: 1, end: 3 })
        for await (const _chunk of stream) {
          chunkCounters['countUp']++
        }
      },
    },
    {
      label: 'randomNumbers',
      fn: async () => {
        const stream = api.server.streamers.randomNumbers({ count: 3 })
        for await (const _chunk of stream) {
          chunkCounters['randomNumbers']++
        }
      },
    },
    {
      label: 'callClientProcA',
      fn: async () => {
        await api.server.procs.callClientProcA({})
      },
    },
    {
      label: 'callClientProcB',
      fn: async () => {
        await api.server.procs.callClientProcB({})
      },
    },
    {
      label: 'callClientStreamerX',
      fn: async () => {
        const stream = api.server.streamers.callClientStreamerX({})
        for await (const _chunk of stream) {
          chunkCounters['callClientStreamerX']++
        }
      },
    },
    {
      label: 'callClientStreamerY',
      fn: async () => {
        const stream = api.server.streamers.callClientStreamerY({})
        for await (const _chunk of stream) {
          chunkCounters['callClientStreamerY']++
        }
      },
    },
  ]

  // Initialize counters and chunkCounters to zero for each label.
  tasks.forEach(({ label }) => {
    counters[label] = 0
    chunkCounters[label] = 0
  })

  // Start each in its own infinite loop
  tasks.forEach(({ label, fn }) => void loopCaller(label, fn))

  // Run for 10 seconds, then print results and exit.
  setTimeout(() => {
    const totalTimeMs = Date.now() - startTime
    const totalTimeSec = totalTimeMs / 1000

    let totalCalls = 0
    let totalChunks = 0

    console.log(`--- Summary after ${totalTimeSec.toFixed(2)}s ---`)
    tasks.forEach(({ label }) => {
      const callCount = counters[label]
      const callRate = callCount / totalTimeSec
      totalCalls += callCount

      if (streamerLabels.has(label)) {
        const chunkCount = chunkCounters[label]
        const chunkRate = chunkCount / totalTimeSec
        totalChunks += chunkCount
        console.log(
          `${label}: calls=${callCount}, rate=${callRate.toFixed(2)}/s, ` + `chunks=${chunkCount}, chunkRate=${chunkRate.toFixed(2)}/s`,
        )
      } else {
        console.log(`${label}: calls=${callCount}, rate=${callRate.toFixed(2)}/s`)
      }
    })

    const totalRate = totalCalls / totalTimeSec
    const totalChunkRate = totalChunks / totalTimeSec
    console.log(
      `Total calls: ${totalCalls}, total rate: ${totalRate.toFixed(2)}/s, ` +
        `total chunks: ${totalChunks}, total chunk rate: ${totalChunkRate.toFixed(2)}/s`,
    )
    process.exit(0)
  }, 10_000)
}

/**
 * loopCaller: calls `fn()` repeatedly, no delay, increments a counter for `label`.
 * If any call throws, we stop (quietly).
 */
async function loopCaller(label: string, fn: () => Promise<void>) {
  while (true) {
    try {
      await fn()
      counters[label]++
    } catch {
      break
    }
  }
}

void main()
