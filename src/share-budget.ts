export class ShareAssetError extends Error {}

export const MAX_SHARE_WORK = 16_000_000;
export const MAX_SHARE_CPU_MS = 750;

/** One allowance for the entire discovery, including all linked stylesheets.
 * Linear native/library operations reserve their input-sized work before entry.
 * Character loops check the clock every 1,024 units, avoiding a clock syscall
 * per byte. Storage wait time is excluded, but synchronous work is cumulative.
 */
export class WorkBudget {
  used = 0;
  private checkpoint = 0;
  private deadline = performance.now() + MAX_SHARE_CPU_MS;

  charge(units = 1): void {
    this.used += units;
    if (this.used > MAX_SHARE_WORK) this.fail();
    if (this.used >= this.checkpoint) {
      this.check();
      this.checkpoint = this.used + 1024;
    }
  }

  check(): void {
    if (performance.now() > this.deadline) this.fail();
  }

  fail(): never {
    throw new ShareAssetError("document too complex to share");
  }

  async wait<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    // Invoke before starting the wait clock: synchronous storage setup counts.
    const pending = operation();
    this.check();
    const start = performance.now();
    try { return await pending; }
    finally { this.deadline += performance.now() - start; }
  }
}
