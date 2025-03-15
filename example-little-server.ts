// example-little-server.ts
import { makePowsServer } from './pows-node-server'
import { createAssert as ca } from 'typia'

/**
 * Define a minimal "Routes" object with typia-based validation:
 */
export const Routes = {
  server: {
    procs: {
      // We accept { s: string }, return { result: string }
      uppercase: [ca<{ s: string }>(), ca<{ result: string }>()],
    },
    streamers: {},
  },
  client: {
    procs: {},
    streamers: {},
  },
} as const

/**
 * Our server implementations:
 */
const api = makePowsServer(Routes, {
  procs: {
    async uppercase({ s }) {
      return { result: s.toUpperCase() }
    },
  },
  streamers: {},
  port: 8080,
})

console.log('starting api')
api.start().then(() => console.log('started!'))
