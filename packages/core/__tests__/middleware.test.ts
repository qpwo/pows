import { executeMiddleware, runWithContext, getContext } from '../src/middleware';

describe('Middleware utilities', () => {
  describe('executeMiddleware', () => {
    it('should execute middleware in order', async () => {
      const operations: string[] = [];
      
      const middleware1 = async (ctx: any, next: () => Promise<void>) => {
        operations.push('middleware1 before');
        await next();
        operations.push('middleware1 after');
      };
      
      const middleware2 = async (ctx: any, next: () => Promise<void>) => {
        operations.push('middleware2 before');
        await next();
        operations.push('middleware2 after');
      };
      
      await executeMiddleware([middleware1, middleware2], {});
      
      expect(operations).toEqual([
        'middleware1 before',
        'middleware2 before',
        'middleware2 after',
        'middleware1 after'
      ]);
    });
    
    it('should modify context', async () => {
      const ctx = { value: 0 };
      
      const middleware1 = async (ctx: any, next: () => Promise<void>) => {
        ctx.value = 1;
        await next();
        ctx.value = 3;
      };
      
      const middleware2 = async (ctx: any, next: () => Promise<void>) => {
        expect(ctx.value).toBe(1);
        ctx.value = 2;
        await next();
      };
      
      await executeMiddleware([middleware1, middleware2], ctx);
      
      expect(ctx.value).toBe(3);
    });
    
    it('should support empty middleware stack', async () => {
      const ctx = { value: 'test' };
      await executeMiddleware([], ctx);
      expect(ctx.value).toBe('test');
    });
  });
  
  describe('runWithContext and getContext', () => {
    it('should set context for the duration of a function', async () => {
      const ctx = { user: 'test' };
      
      const result = await runWithContext(ctx, async () => {
        const currentCtx = getContext();
        expect(currentCtx).toBe(ctx);
        return 'done';
      });
      
      expect(result).toBe('done');
      expect(getContext()).toBeUndefined();
    });
    
    it('should restore previous context after nested calls', async () => {
      const outerCtx = { level: 'outer' };
      const innerCtx = { level: 'inner' };
      
      await runWithContext(outerCtx, async () => {
        expect(getContext()).toBe(outerCtx);
        
        await runWithContext(innerCtx, async () => {
          expect(getContext()).toBe(innerCtx);
        });
        
        expect(getContext()).toBe(outerCtx);
      });
      
      expect(getContext()).toBeUndefined();
    });
  });
});