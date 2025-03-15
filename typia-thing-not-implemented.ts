import {createAssert as ca} from 'typia'

type Empty = Record<string, never>
const Routes = {
  server: {
    procs: {
      square: [ ca<{ x: number }>(), ca<{ result: number }>() ],
      whoami: [ ca<Empty>(), ca<{ name: string, userId: number }>() ],
      errorTest: [ ca<{ msg: string }>(), ca<Empty>() ],
    },
    streamers: {
      doBigJob: [ ca<Empty>(), ca<string>() ],
    }
  },
  client: {
    procs: {
      approve: [ ca<{ question: string }>(), ca<{ approved: boolean }>() ],
    },
    streamers: {}
  }
} as const

makeTswsClient(Routes,...)
makeTswsServer(Routes,...)
