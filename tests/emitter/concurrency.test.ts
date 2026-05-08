import { describe, it, expect, vi } from 'vitest';
import { runConcurrent, runSequential } from '../../src/emitter/concurrency.js';

describe('runConcurrent', () => {
  it('runs all tasks and returns their results', async () => {
    const results = await runConcurrent([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('returns an empty array for no tasks', async () => {
    expect(await runConcurrent([])).toEqual([]);
  });

  it('launches all tasks before any resolves', async () => {
    const started: number[] = [];
    await runConcurrent([
      async () => {
        started.push(1);
        await Promise.resolve();
      },
      async () => {
        started.push(2);
        await Promise.resolve();
      },
    ]);
    expect(started).toEqual([1, 2]);
  });

  it('rejects if any task rejects', async () => {
    await expect(
      runConcurrent([() => Promise.resolve('ok'), () => Promise.reject(new Error('boom'))]),
    ).rejects.toThrow('boom');
  });
});

describe('runSequential', () => {
  it('runs all tasks and returns their results in order', async () => {
    const results = await runSequential([
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array for no tasks', async () => {
    expect(await runSequential([])).toEqual([]);
  });

  it('executes tasks in strict order', async () => {
    const order: number[] = [];
    await runSequential([
      async () => {
        order.push(1);
      },
      async () => {
        order.push(2);
      },
      async () => {
        order.push(3);
      },
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('does not start the next task until the previous resolves', async () => {
    const order: string[] = [];
    let resolve1!: () => void;

    const runPromise = runSequential([
      () =>
        new Promise<void>((res) => {
          resolve1 = res;
          order.push('task1-started');
        }),
      async () => {
        order.push('task2-started');
      },
    ]);

    // task1 has started but not resolved — task2 must not have started yet
    expect(order).toContain('task1-started');
    expect(order).not.toContain('task2-started');

    resolve1();
    await runPromise;

    expect(order).toContain('task2-started');
  });

  it('rejects immediately on the first failing task', async () => {
    const secondTask = vi.fn().mockResolvedValue('never');
    await expect(
      runSequential([() => Promise.reject(new Error('first fails')), secondTask]),
    ).rejects.toThrow('first fails');
    expect(secondTask).not.toHaveBeenCalled();
  });
});
