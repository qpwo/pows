// example-load-client.ts
import { makePowsClient } from './pows-node-client'
import { Routes3 } from './example-load-server' // We import the same Routes3 object

type ClientCtx = {}

// We'll track how many times each call completes in `counters`
// and how many chunks each streamer yields in `chunkCounters`.
const counters: Record<string, number> = {}
const chunkCounters: Record<string, number> = {}

// We'll identify which labels are streamers.
const streamerLabels = new Set(['countUp', 'randomNumbers', 'callClientStreamerX', 'callClientStreamerY'])

/**
 * Create the client, providing local (client) procs and streamers,
 * plus the route definitions from the server. "procs" and "streamers"
 * here implement the callbacks the server might call, i.e. "clientProcA", etc.
 */
const api = makePowsClient<typeof Routes3, ClientCtx>(Routes3, {
  procs: {
    // Changed to accept a string and return a string
    async clientProcA(ping) {
      return `${ping} -> clientProcA says hi!`
    },
    async clientProcB(question) {
      return 'clientProcB answer: Definitely yes!'
    },
  },
  streamers: {
    // Now accepts a string, yields strings
    async *clientStreamerX(hello) {
      for (let i = 0; i < 3; i++) {
        yield `clientStreamerX chunk #${i} - responding to "${hello}"`
      }
    },
    // Now accepts an array of numbers, yields numbers
    async *clientStreamerY(data) {
      for (const item of data) {
        yield item * 10
      }
    },
  },
  url: 'ws://localhost:8082',
})

async function main() {
  await api.connect()

  const startTime = Date.now()

  // Define 8 tasks, each calling one server function or streamer.
  const tasks: Array<{ label: string; fn: () => Promise<void> }> = [
    {
      label: 'addOne',
      fn: async () => {
        await api.server.procs.addOne(Math.floor(Math.random() * 100))
      },
    },
    {
      label: 'double',
      fn: async () => {
        await api.server.procs.double(Math.floor(Math.random() * 50))
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
        const stream = api.server.streamers.randomNumbers(3)
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
    const totalTrips = totalCalls + totalChunks
    const totalTripRate = totalTrips / totalTimeSec
    console.log(
      // `Total calls: ${totalCalls}, total rate: ${totalRate.toFixed(2)}/s, ` +
      // `total chunks: ${totalChunks}, total chunk rate: ${totalChunkRate.toFixed(2)}/s`,
      `total trips: ${totalTrips}, total trip rate: ${totalTripRate.toFixed(2)}/s`,
    )
    process.exit(0)
  }, 10_000)
}

/**
 * loopCaller: calls `fn()` repeatedly, no delay, increments a counter for `label`.
 * If any call throws, we stop (quietly).
 */
async function loopCaller(label: string, fn: () => Promise<void>) {
  let errored = false
  while (true) {
    try {
      await fn()
      counters[label]++
    } catch (e) {
      if (!errored) {
        errored = true
        console.error(`Error in ${label}:`, e)
      } else {
        process.stdout.write('(e)')
      }
    }
  }
}

void main()
