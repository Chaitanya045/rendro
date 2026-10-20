/**
 * `Server-Timing` phases for the repository read path (#282).
 *
 * One `ReadTiming` per request records what the request waited on: the
 * authorization decision, each storage read (and which tier answered it) and
 * the first-view ingest window. `header()` turns that into a
 * fixed set of metric names, so the header's cardinality is constant and it
 * never names a repository, path, user or key. Recording is a few clock reads
 * and additions; the header is built once, after the response.
 *
 * In Workers the clock only advances across I/O, so a phase measures the time
 * spent waiting on its I/O, not CPU. That is the part these budgets are about.
 *
 * Search has no phase of its own (#294), and a search response reports its
 * total only to a coarse step: how long the index took is not a signal a
 * reader needs, and real-user monitoring reads the total alone.
 */

/** Where an object came from, in the order the reader tries them. */
export type CacheTier = "memory" | "shared" | "colo" | "r2";
export type TimedPhase = "auth" | "first-view";
export type StorageTier = Exclude<CacheTier, "memory">;

const TIERS: readonly CacheTier[] = ["memory", "shared", "colo", "r2"];
/** Header order: the authorization, the tier, then the waits after it. */
const AFTER_TIER: readonly (TimedPhase | StorageTier)[] = ["shared", "colo", "r2", "first-view"];
/** The step a coarse total is rounded up to, in milliseconds. */
export const COARSE_TOTAL_MS = 10;

function duration(ms: number): string {
  return Math.max(0, ms).toFixed(1);
}

export class ReadTiming {
  private readonly startedAt: number;
  private readonly spent = new Map<TimedPhase | StorageTier, number>();
  private deepest = 0;
  private coarse = false;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  /** Runs `work`, adding its wall time to `phase` whether it resolves or throws. */
  async time<T>(phase: TimedPhase | StorageTier, work: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await work();
    } finally {
      this.spent.set(phase, (this.spent.get(phase) ?? 0) + this.now() - startedAt);
    }
  }

  /** Notes that a read was answered by `tier`; the header reports the deepest tier any read reached. */
  served(tier: StorageTier): void {
    this.deepest = Math.max(this.deepest, TIERS.indexOf(tier));
  }

  /** Report the total only to the next `COARSE_TOTAL_MS` (a search response). */
  coarsen(): void {
    this.coarse = true;
  }

  /**
   * `auth;dur=…, cache;desc=r2, r2;dur=…, total;dur=…`. Only phases that ran
   * appear; `cache` names the slowest tier the request needed, `memory` when
   * every object was already in this isolate.
   */
  header(): string {
    return [
      ...this.part("auth"),
      `cache;desc=${TIERS[this.deepest]}`,
      ...AFTER_TIER.flatMap(phase => this.part(phase)),
      `total;dur=${duration(this.total())}`,
    ].join(", ");
  }

  private total(): number {
    const elapsed = this.now() - this.startedAt;
    return this.coarse ? Math.ceil(elapsed / COARSE_TOTAL_MS) * COARSE_TOTAL_MS : elapsed;
  }

  private part(phase: TimedPhase | StorageTier): string[] {
    const spent = this.spent.get(phase);
    return spent === undefined ? [] : [`${phase};dur=${duration(spent)}`];
  }
}
