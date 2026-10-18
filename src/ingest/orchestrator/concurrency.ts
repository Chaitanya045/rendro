/**
 * Run `handle` over a work list that may grow while it runs, at most `limit`
 * at a time. The first failure stops new work and is rethrown once running
 * work settles.
 */
export async function workPool<T>(initial: readonly T[], limit: number, handle: (item: T, push: (next: T) => void) => Promise<void>): Promise<void> {
  const queue = [...initial];
  let active = 0;
  let failure: { error: unknown } | null = null;
  let waiting: Array<() => void> = [];
  const wakeAll = () => {
    const sleepers = waiting;
    waiting = [];
    for (const resolve of sleepers) resolve();
  };
  const push = (next: T) => {
    queue.push(next);
    wakeAll();
  };
  const worker = async () => {
    for (;;) {
      if (failure !== null) return;
      if (queue.length === 0) {
        // Running work may still push more; idle workers wait for it rather than exit.
        if (active === 0) return;
        await new Promise<void>((resolve) => waiting.push(resolve));
        continue;
      }
      const item = queue.shift() as T;
      active += 1;
      try {
        await handle(item, push);
      } catch (error) {
        failure ??= { error };
      } finally {
        active -= 1;
        wakeAll();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Per-isolate coalescing: concurrent callers with the same key share one
 * promise. It only spans one isolate; the per-repo Durable Object is the
 * global layer behind it.
 */
export class SingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing;
    const flight = task().finally(() => { this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }

  get size(): number {
    return this.flights.size;
  }
}
