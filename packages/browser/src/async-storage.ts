/**
 * A simplified polyfill for AsyncLocalStorage for browser environments
 */
export class AsyncLocalStorage<T> {
  private static currentStore: any = null;

  getStore(): T | undefined {
    return AsyncLocalStorage.currentStore as T | undefined;
  }

  async run<R>(store: T, callback: () => Promise<R>): Promise<R> {
    const previousStore = AsyncLocalStorage.currentStore;
    
    try {
      // Set the current store
      AsyncLocalStorage.currentStore = store;
      
      // Run the callback
      return await callback();
    } finally {
      // Restore the previous store
      AsyncLocalStorage.currentStore = previousStore;
    }
  }
}

/**
 * Get the current context from AsyncLocalStorage
 */
export function getContext<T = any>(): T | undefined {
  return AsyncLocalStorage.currentStore as T | undefined;
}

/**
 * Run a function with a context stored in AsyncLocalStorage
 */
export async function runWithContext<T, C>(
  context: C,
  fn: () => Promise<T>
): Promise<T> {
  const storage = new AsyncLocalStorage<C>();
  return storage.run(context, fn);
}