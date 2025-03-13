import { AsyncLocalStorage } from 'async_hooks';
import { Middleware, MiddlewareStack } from './types';

// Create a global AsyncLocalStorage instance
export const asyncLocalStorage = new AsyncLocalStorage<any>();

/**
 * Execute middleware stack with the given context
 * Optimized for performance with reduced allocations
 */
export async function executeMiddleware<Context>(
  middlewares: MiddlewareStack<Context>,
  ctx: Context
): Promise<void> {
  if (!middlewares.length) return;
  
  let index = 0;
  const middlewaresLength = middlewares.length;
  
  const next = async (): Promise<void> => {
    if (index >= middlewaresLength) return;
    return middlewares[index++](ctx, next);
  };
  
  return next();
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