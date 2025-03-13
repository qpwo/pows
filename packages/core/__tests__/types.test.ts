import { 
  RPCFunction, 
  StreamFunction,
  MiddlewareStack,
  ServerHandlers
} from '../src/types';

// This test is mainly for TypeScript type checking
describe('Type definitions', () => {
  it('should properly type RPC functions', () => {
    // Simple RPC function
    const uppercaseRpc: RPCFunction<string, string> = 
      (params, ctx) => params.toUpperCase();
    
    expect(uppercaseRpc('test', {})).toBe('TEST');
    
    // Async RPC function
    const asyncRpc: RPCFunction<number, Promise<number>> = 
      async (params, ctx) => params * 2;
    
    expect(asyncRpc(5, {})).resolves.toBe(10);
    
    // RPC function with context
    type TestContext = { userId: number };
    const contextRpc: RPCFunction<void, string, TestContext> = 
      (params, ctx) => `User ID: ${ctx.userId}`;
    
    expect(contextRpc(undefined, { userId: 123 })).toBe('User ID: 123');
  });
  
  it('should properly type stream functions', () => {
    // Define an async generator function
    async function* countGenerator(max: number): AsyncGenerator<number, void, unknown> {
      for (let i = 0; i < max; i++) {
        yield i;
      }
    }
    
    // Stream function
    const counterStream: StreamFunction<number, number> = 
      (params, ctx) => countGenerator(params);
    
    // We can't easily test the generator behavior in a unit test, so we just verify it doesn't throw
    expect(() => counterStream(3, {})).not.toThrow();
  });
  
  it('should properly type middleware', () => {
    // Simple middleware function
    const middleware = async (ctx: any, next: () => Promise<void>) => {
      ctx.visited = true;
      await next();
    };
    
    const middlewareStack: MiddlewareStack<any> = [middleware];
    expect(middlewareStack.length).toBe(1);
  });
  
  it('should demonstrate proper server handlers structure', () => {
    interface TestRoutes {
      server: {
        procs: {
          greet(name: string): string;
          double(num: number): Promise<number>;
        };
        streamers: {
          counter(max: number): AsyncGenerator<number, void, unknown>;
        }
      }
    }
    
    // Implementation of handlers
    const handlers: ServerHandlers<TestRoutes, any> = {
      greet: (name, ctx) => `Hello, ${name}!`,
      double: async (num, ctx) => num * 2,
      counter: async function*(max, ctx) {
        for (let i = 0; i < max; i++) {
          yield i;
        }
      }
    };
    
    // Test the implementations
    expect(handlers.greet('World', {})).toBe('Hello, World!');
    expect(handlers.double(5, {})).resolves.toBe(10);
  });
});