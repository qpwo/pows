import { AsyncLocalStorage } from 'async_hooks';
import { Middleware, MiddlewareStack } from './types';

// Create a global AsyncLocalStorage instance
export const asyncLocalStorage = new AsyncLocalStorage<any>();

/**
 * Execute middleware stack with the given context
 */
export async function executeMiddleware<Context>(
  middlewares: MiddlewareStack<Context>,
  ctx: Context
): Promise<void> {
  let index = 0;
  
  const next = async (): Promise<void> => {
    // If we've run all middleware, we're done
    if (index >= middlewares.length) {
      return;
    }
    
    // Get the current middleware and increment the index
    const middleware = middlewares[index++];
    
    // Execute the middleware with the context and next function
    await middleware(ctx, next);
  };
  
  // Start executing middleware
  await next();
}

/**
 * Get the current context from AsyncLocalStorage
 */
export function getContext<T = any>(): T | undefined {
  return asyncLocalStorage.getStore() as T | undefined;
}

/**
 * Run a function with a context stored in AsyncLocalStorage
 */
export async function runWithContext<T, C>(
  context: C,
  fn: () => Promise<T>
): Promise<T> {
  return asyncLocalStorage.run(context, fn);
}