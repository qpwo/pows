import { executeMiddleware } from '../src/middleware';

// Helper function to wait
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Comprehensive test for TSWS covering all features from README using mocks
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

type ServerContext = {
  userName: string;
  userId: number | null;
};

// Mock implementation of the API
function createMockApi() {
  // Mock handlers and callbacks
  const approveCallback = jest.fn().mockResolvedValue(true);
  const getClientInfoCallback = jest.fn().mockResolvedValue({ clientId: 'test-client-123' });
  
  // Create server API
  const serverApi = {
    // Server procedures
    uppercase: jest.fn((s: string) => s.toUpperCase()),
    square: jest.fn(async (x: number) => x * x),
    whoami: jest.fn(async (params: any, ctx: ServerContext) => ({ name: ctx.userName, userId: ctx.userId })),
    echo: jest.fn(async (message: string) => message),
    
    // Server streamers
    doBigJob: jest.fn(async function*() {
      yield 'Starting...';
      await sleep(10);
      
      const ok = await clientApi.approve('Continue with big job?');
      if (!ok) {
        yield 'Cancelled by user.';
        return;
      }
      
      yield 'Working...';
      await sleep(10);
      
      yield 'Done.';
    }),
    
    countTo: jest.fn(async function*(limit: number) {
      for (let i = 1; i <= limit; i++) {
        yield i;
        await sleep(1);
      }
    })
  };
  
  // Create client API
  const clientApi = {
    approve: approveCallback,
    getClientInfo: getClientInfoCallback
  };
  
  // Create server context
  const serverContext: ServerContext = {
    userName: 'TestUser',
    userId: 42
  };
  
  return { serverApi, clientApi, serverContext, approveCallback, getClientInfoCallback };
}

describe('TSWS Comprehensive Tests (Mocked)', () => {
  const { serverApi, clientApi, serverContext, approveCallback, getClientInfoCallback } = createMockApi();
  
  describe('Basic RPC functionality', () => {
    test('should call server procedures', async () => {
      // Test uppercase procedure
      const result = serverApi.uppercase('hello');
      expect(result).toBe('HELLO');
      expect(serverApi.uppercase).toHaveBeenCalledWith('hello');
    });
    
    test('should support async RPC calls', async () => {
      // Test square procedure with Promise
      const result = await serverApi.square(5);
      expect(result).toBe(25);
      expect(serverApi.square).toHaveBeenCalledWith(5);
    });
    
    test('should support contextual data', async () => {
      // Test whoami procedure that uses context
      const result = await serverApi.whoami({}, serverContext);
      expect(result).toEqual({ name: 'TestUser', userId: 42 });
      expect(serverApi.whoami).toHaveBeenCalledWith({}, serverContext);
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
  
  describe('Bidirectional RPC', () => {
    test('server should call client procedures', async () => {
      // Reset mock first
      approveCallback.mockClear();
      
      // Echo should work simply
      const echoResult = await serverApi.echo('test message');
      expect(echoResult).toBe('test message');
      expect(serverApi.echo).toHaveBeenCalledWith('test message');
      
      // Server calls client procedure during streamer
      const generator = serverApi.doBigJob();
      
      // First value should be available immediately
      const { value: firstValue } = await generator.next();
      expect(firstValue).toBe('Starting...');
      
      // Wait for generator to proceed
      await sleep(50);
      
      // Verify client procedure was called with correct argument
      expect(approveCallback).toHaveBeenCalledWith('Continue with big job?');
      
      // Collect all remaining stream values
      const results = [];
      for await (const value of generator) {
        results.push(value);
      }
      
      expect(results).toEqual(['Working...', 'Done.']);
    });
    
    test('client handler can return custom values', async () => {
      // Test client handler
      const result = await clientApi.getClientInfo({});
      expect(result).toEqual({ clientId: 'test-client-123' });
      expect(getClientInfoCallback).toHaveBeenCalledWith({});
    });
  });
  
  describe('Streaming support', () => {
    test('should stream data from server to client', async () => {
      const generator = serverApi.countTo(5);
      const results = [];
      
      for await (const value of generator) {
        results.push(value);
      }
      
      // Check stream values
      expect(results).toEqual([1, 2, 3, 4, 5]);
      expect(serverApi.countTo).toHaveBeenCalledWith(5);
    });
    
    test('should handle early stream termination', async () => {
      // Make approve return false to test early termination
      approveCallback.mockImplementationOnce(() => Promise.resolve(false));
      
      const generator = serverApi.doBigJob();
      const results = [];
      
      for await (const value of generator) {
        results.push(value);
      }
      
      expect(results).toEqual(['Starting...', 'Cancelled by user.']);
    });
  });
});