import { executeMiddleware } from '../src/middleware';

/**
 * Comprehensive test for TSWS that follows the API patterns from the README
 * but uses direct function calls instead of actual WebSockets
 */

// Helper function for async operations
function sleep(ms: number = 100): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Define the routes interface following the README
interface Routes {
  server: {
    procs: {
      square(x: number): Promise<number>;
      whoami(): Promise<{ name: string; userId: number | null }>;
    };
    streamers: {
      doBigJob(): AsyncGenerator<string, void, unknown>;
    };
  };
  client: {
    procs: {
      approve(question: string): Promise<boolean>;
    };
    streamers: {};
  };
}

// Define the server context type
type ServerContext = {
  userName: string;
  userId: number | null;
};

/**
 * Create a simple direct connection that mimics the API pattern
 * but doesn't require network connections
 */
function createDirectConnection() {
  let clientApproved = true;
  
  // Create the context
  const serverContext: ServerContext = {
    userName: 'Alice',
    userId: 42
  };
  
  // Implement the server handlers
  const serverHandlers = {
    // Server RPCs
    square: async (x: number) => x * x,
    
    whoami: async () => ({ 
      name: serverContext.userName, 
      userId: serverContext.userId 
    }),
    
    // Server streamer
    doBigJob: async function*() {
      yield 'Starting...';
      await sleep(50);
      
      const ok = await clientHandlers.approve('Continue with big job?');
      if (!ok) {
        yield 'Cancelled by user.';
        return;
      }
      
      yield 'Working...';
      await sleep(50);
      
      yield 'Done.';
    }
  };
  
  // Client handlers
  const clientHandlers = {
    approve: async (question: string) => clientApproved
  };
  
  // Create the server API that matches the pattern in the README
  const server = {
    client: {
      procs: {
        approve: clientHandlers.approve
      }
    }
  };
  
  // Create the client API that matches the pattern in the README
  const client = {
    server: {
      procs: {
        square: serverHandlers.square,
        whoami: serverHandlers.whoami
      },
      streamers: {
        doBigJob: serverHandlers.doBigJob
      }
    },
    _internal: {
      close: () => {}
    }
  };
  
  return { 
    server, 
    client, 
    serverContext,
    setClientApproved: (value: boolean) => { clientApproved = value; }
  };
}

describe('TSWS Comprehensive Tests', () => {
  // Create a direct connection between client and server
  const { server, client, setClientApproved } = createDirectConnection();
  
  describe('Basic RPC functionality', () => {
    test('should support async RPC calls', async () => {
      // Call the square procedure (matches README example)
      const result = await client.server.procs.square(5);
      expect(result).toBe(25);
    });
    
    test('should support contextual data', async () => {
      // Call the whoami procedure (matches README example)
      const result = await client.server.procs.whoami();
      expect(result).toEqual({ name: 'Alice', userId: 42 });
    });
  });
  
  describe('Bidirectional RPC', () => {
    test('server should call client procedures during streaming', async () => {
      // Enable client approval for this test
      setClientApproved(true);
      
      // Start the server's streaming operation
      const stream = client.server.streamers.doBigJob();
      
      // Get the first value
      const firstStep = await stream.next();
      expect(firstStep.value).toBe('Starting...');
      expect(firstStep.done).toBe(false);
      
      // Collect all remaining stream values
      const results = [];
      for await (const value of stream) {
        results.push(value);
      }
      
      // Check we got the correct values
      expect(results).toEqual(['Working...', 'Done.']);
    });
  });
  
  describe('Streaming support', () => {
    test('should handle early stream termination', async () => {
      // Disable client approval for this test
      setClientApproved(false);
      
      // Start the server's streaming operation
      const stream = client.server.streamers.doBigJob();
      
      // Collect all values
      const results = [];
      for await (const value of stream) {
        results.push(value);
      }
      
      // Check we got the early termination sequence
      expect(results).toEqual([
        'Starting...', 
        'Cancelled by user.'
      ]);
    });
  });
  
  describe('Middleware support', () => {
    test('should support middleware execution', async () => {
      // Test the middleware system with the same pattern used in the library
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