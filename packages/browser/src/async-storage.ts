// Simple thread-local storage for browser context
let currentContext: any = null;

/**
 * Get the current context
 */
export function getContext<T = any>(): T | undefined {
  return currentContext as T | undefined;
}

/**
 * Run a function with a context
 */
export async function runWithContext<T, C>(
  context: C,
  fn: () => Promise<T>
): Promise<T> {
  const previousContext = currentContext;
  
  try {
    currentContext = context;
    return await fn();
  } finally {
    currentContext = previousContext;
  }
}

/**
 * Compatibility interface with Node's AsyncLocalStorage
 */
export class AsyncLocalStorage<T> {
  getStore(): T | undefined {
    return currentContext as T | undefined;
  }

  async run<R>(store: T, callback: () => Promise<R>): Promise<R> {
    return runWithContext(store, callback);
  }
}