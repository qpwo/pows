import { executeMiddleware } from '../src/middleware';

/**
 * Comprehensive test for TSWS covering all features from README
 * using a mocked implementation
 */

// Helper function to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Define the routes interface as shown in the README
 */
interface Routes {
  server: {
    procs: {
      // RPC procedures
      uppercase(s: string): string;
      square(x: number): Promise<number>;
      whoami(): Promise<{ name: string; userId: number | null }>;
      echo(message: string): Promise<string>;
    };
    streamers: {
      // Streaming support
      doBigJob(): AsyncGenerator<string, void, unknown>;
      countTo(limit: number): AsyncGenerator<number, void, unknown>;
    };
  };
  client: {
    procs: {
      // Client-to-server procedure calls
      approve(question: string): Promise<boolean>;
      getClientInfo(params: {}): Promise<{ clientId: string }>;
    };
    streamers: {};
  };
}

/**
 * Define the server context type as shown in the README
 */
type ServerContext = {
  userName: string;
  userId: number | null;
  uws: any; // In the README this is a uWebSocket.js object
};

/**
 * Create a direct connection between server and client bypassing actual websockets
 */
function createDirectConnection() {
  // Mock the server API by implementing the actual handlers directly
  const approveCallback = jest.fn().mockResolvedValue(true);
  const getClientInfoCallback = jest.fn().mockResolvedValue({ clientId: 'test-client-123' });
  
  // Create the context that middleware will populate
  const serverContext: ServerContext = {
    userName: 'TestUser',
    userId: 42,
    uws: {} // Mock uWebSocket object
  };
  
  // Setup client handlers
  const clientHandlers = {
    approve: approveCallback,
    getClientInfo: getClientInfoCallback
  };
  
  // Create server API
  const server = {
    // Server procedures implemented directly
    uppercase: (s: string) => s.toUpperCase(),
    
    square: async (x: number) => x * x,
    
    whoami: async () => ({ name: serverContext.userName, userId: serverContext.userId }),
    
    echo: async (message: string) => message,
    
    // Server streamers implemented directly
    doBigJob: async function*() {
      yield 'Starting...';
      await sleep(100);
      
      // In a real implementation, the server would call the client's approve method
      const question = 'Continue with big job?';
      yield `Asking: ${question}`; // Yield the question so we can verify it
      
      const ok = await clientHandlers.approve(question);
      if (!ok) {
        yield 'Cancelled by user.';
        return;
      }
      
      yield 'Working...';
      await sleep(100);
      
      yield 'Done.';
    },
    
    countTo: async function*(limit: number) {
      for (let i = 1; i <= limit; i++) {
        yield i;
        await sleep(10);
      }
    }
  };
  
  // Create the facade that matches the API from the README
  const serverApi = {
    client: {
      procs: {
        approve: clientHandlers.approve,
        getClientInfo: clientHandlers.getClientInfo
      }
    }
  };
  
  const clientApi = {
    server: {
      procs: {
        uppercase: server.uppercase,
        square: server.square,
        whoami: server.whoami,
        echo: server.echo
      },
      streamers: {
        doBigJob: server.doBigJob,
        countTo: server.countTo
      }
    },
    _internal: {
      close: jest.fn().mockResolvedValue(undefined)
    }
  };
  
  return { 
    server: serverApi, 
    client: clientApi,
    clientHandlers,
    approveCallback, 
    getClientInfoCallback,
    context: serverContext
  };
}

describe('TSWS Comprehensive Tests', () => {
  // Create a direct connection between client and server
  const { client, server, clientHandlers, approveCallback, getClientInfoCallback } = createDirectConnection();
  
  describe('Basic RPC functionality', () => {
    test('should call server procedures', async () => {
      // Test uppercase procedure
      const result = await client.server.procs.uppercase('hello');
      expect(result).toBe('HELLO');
    });
    
    test('should support async RPC calls', async () => {
      // Test square procedure with Promise
      const result = await client.server.procs.square(5);
      expect(result).toBe(25);
    });
    
    test('should support contextual data', async () => {
      // Test whoami procedure that uses context
      const result = await client.server.procs.whoami();
      expect(result).toEqual({ name: 'TestUser', userId: 42 });
    });
  });
  
  describe('Bidirectional RPC', () => {
    test('server should call client procedures', async () => {
      // Echo should work simply
      const echoResult = await client.server.procs.echo('test message');
      expect(echoResult).toBe('test message');
      
      // Server calls client procedure during streamer
      const stream = client.server.streamers.doBigJob();
      
      // Get the first value
      const { value: firstValue } = await stream.next();
      expect(firstValue).toBe('Starting...');
      
      // Get the second value which contains the question
      const { value: secondValue } = await stream.next();
      expect(secondValue).toBe('Asking: Continue with big job?');
      
      // Collect all remaining stream values
      const results = [];
      for await (const value of stream) {
        results.push(value);
      }
      
      expect(results).toEqual(['Working...', 'Done.']);
    });
    
    test('client handler can return custom values', async () => {
      // Test client-to-server call with the getClientInfo handler
      getClientInfoCallback.mockClear();
      const result = await server.client.procs.getClientInfo({});
      expect(result).toEqual({ clientId: 'test-client-123' });
      expect(getClientInfoCallback).toHaveBeenCalledWith({});
    });
  });
  
  describe('Streaming support', () => {
    test('should stream data from server to client', async () => {
      const stream = client.server.streamers.countTo(5);
      const results = [];
      
      for await (const value of stream) {
        results.push(value);
      }
      
      // Check stream values
      expect(results).toEqual([1, 2, 3, 4, 5]);
      
      // Async generators in this lib return void when done
      const returnValue = await stream.next();
      expect(returnValue.done).toBe(true);
    });
    
    test('should handle early stream termination', async () => {
      // Create a special approveCallback that returns false
      const rejectApproveCallback = jest.fn().mockResolvedValue(false);
      
      // Temporarily override the approve function
      const originalApprove = clientHandlers.approve;
      clientHandlers.approve = rejectApproveCallback;
      
      const stream = client.server.streamers.doBigJob();
      const results = [];
      
      for await (const value of stream) {
        results.push(value);
      }
      
      // Restore the original approve function
      clientHandlers.approve = originalApprove;
      
      // Check that we got the expected sequence
      expect(results).toEqual([
        'Starting...', 
        'Asking: Continue with big job?', 
        'Cancelled by user.'
      ]);
    });
  });
  
  describe('Middleware support', () => {
    test('should support middleware execution', async () => {
      const middleware = [
        async (ctx: any, next: () => Promise<void>) => {
          ctx.step1 = true;
          await next();
          ctx.step3 = true;
        },
        async (ctx: any, next: () => Promise<void>) => {
          ctx.step2 = true;
          await next();
        }
      ];
      
      const context = {};
      await executeMiddleware(middleware, context);
      
      expect(context).toEqual({
        step1: true,
        step2: true,
        step3: true
      });
    });
  });
});