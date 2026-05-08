/**
 * @module emitter/concurrency
 * Lightweight task-execution helpers used by the manifest runner to honour the
 * `concurrent` flag on grouped manifest events. Tasks are thunks
 * (`() => Promise<T>`) so they are not started until the relevant helper fires
 * them.
 */

/**
 * Executes all tasks simultaneously and resolves when every task has settled.
 * Equivalent to `Promise.all`, but accepts thunks rather than pre-started
 * promises so callers control when execution begins.
 *
 * @param tasks - Array of async thunks to run in parallel.
 * @returns An array of results in the same order as the input tasks.
 */
export async function runConcurrent<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  return Promise.all(tasks.map((t) => t()));
}

/**
 * Executes tasks one after another, waiting for each to complete before
 * starting the next. Used for sequential event groups in the manifest where
 * ordering matters for SDLC pipeline simulation.
 *
 * @param tasks - Array of async thunks to run in sequence.
 * @returns An array of results in the same order as the input tasks.
 */
export async function runSequential<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  for (const task of tasks) {
    results.push(await task());
  }
  return results;
}
