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

/**
 * Starts tasks as capacity allows, at most `limit` at a time and (once one is
 * running) at most `maxBytes` of declared payload in flight. A producer that
 * reads from a stream awaits `submit` before pulling the next item, so a full
 * pool applies backpressure to the stream instead of buffering it. One task
 * larger than `maxBytes` still runs, alone. The first failure stops new work;
 * `settle` waits for running work, and `failure` then holds the error.
 */
export class BoundedTasks {
  private active = 0;
  private bytes = 0;
  private failed: { error: unknown } | null = null;
  private waiting: Array<() => void> = [];
  private idle: Array<() => void> = [];

  constructor(private readonly limit: number, private readonly maxBytes: number) {}

  /** The first task failure, or null. */
  get failure(): { error: unknown } | null {
    return this.failed;
  }

  /** Waits for capacity, then starts `task` without awaiting it. Returns false, starting nothing, once a task has failed. */
  async submit(bytes: number, task: () => Promise<void>): Promise<boolean> {
    while (this.failed === null && this.active > 0 && (this.active >= Math.max(1, this.limit) || this.bytes + bytes > this.maxBytes)) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    if (this.failed !== null) return false;
    this.active += 1;
    this.bytes += bytes;
    void task().catch((error: unknown) => { this.failed ??= { error }; }).finally(() => {
      this.active -= 1;
      this.bytes -= bytes;
      const sleepers = this.waiting;
      this.waiting = [];
      for (const resolve of sleepers) resolve();
      if (this.active === 0) for (const resolve of this.idle.splice(0)) resolve();
    });
    return true;
  }

  /** Resolves once nothing is running. Never rejects: read `failure`. */
  async settle(): Promise<void> {
    if (this.active === 0) return;
    await new Promise<void>((resolve) => this.idle.push(resolve));
  }
}
