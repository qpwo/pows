// example-little-server.ts
import { makeTswsServer, type RoutesConstraint } from './tsws-node-server'

export interface Routes {
  server: {
    procs: {
      uppercase(_: { s: string }): Promise<{ result: string }>
    }
    streamers: {}
  }
  client: {
    procs: {}
    streamers: {}
  }
}
const __: RoutesConstraint = null as unknown as Routes

var api = makeTswsServer<Routes>({
  procs: {
    async uppercase({ s }) {
      return { result: s.toUpperCase() }
    },
  },
  streamers: {},
  port: 8080, // default
})
console.log('starting api')
api.start().then(() => console.log('started!'))
