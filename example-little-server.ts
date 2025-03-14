// example-little-server.ts

import { makeTswsServer } from './tsws-node-server'

export interface Routes {
  server: {
    procs: {
      uppercase(s: string): string
    }
    streamers: {}
  }
  client: {
    procs: {}
    streamers: {}
  }
}

var api = makeTswsServer<Routes>(
  {
    // serverImpl
    uppercase([s]) {
      return s.toUpperCase()
    },
  },
  {
    port: 8080,
  },
)

console.log('starting api')
api.start().then(() => console.log('started!'))
