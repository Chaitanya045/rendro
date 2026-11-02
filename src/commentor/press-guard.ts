/**
 * Lets a press that began on a control finish before a live update replaces that control (#350).
 *
 * The widget rebuilds its drawer list, pins and open bubble whenever the subscription delivers a change. A `click` is
 * only dispatched when the press and the release land on the same element, so a rebuild between the two removes the
 * pressed button and the click, and with it the reader's action, is silently lost. While a press (pointer or Space) is
 * held inside those regions, the rebuild waits; it runs on a later task once the press has ended, after the click the
 * release produced has been dispatched. A press that never ends (a lost `pointerup`) cannot freeze updates: it is
 * dropped after `cap` milliseconds.
 *
 * The guard holds no widget state. What a rebuild shows is read when it runs, so a deferred rebuild can never put an
 * older state over a newer one: every update that arrives meanwhile only replaces the waiting rebuild.
 */
export class PressGuard {
  private readonly sources = new Set<string>();
  private waiting: (() => void) | null = null;
  private capTimer = 0;
  private flushTimer = 0;

  constructor(private readonly cap = 2_000) {}

  /** Whether a press is in progress, so a rebuild would take its control away. */
  get pressed(): boolean { return this.sources.size > 0; }

  press(source: string): void {
    this.sources.add(source);
    window.clearTimeout(this.capTimer);
    this.capTimer = window.setTimeout(() => this.drop(), this.cap);
  }

  /** The press ended: its click has been, or is about to be, dispatched, so the waiting rebuild runs on the next task. */
  release(source: string): void {
    if (!this.sources.delete(source) || this.sources.size > 0) return;
    window.clearTimeout(this.capTimer);
    this.flushLater();
  }

  /** Runs `apply` now, or once the press has ended. A later call replaces one still waiting. */
  run(apply: () => void): void {
    if (!this.pressed) {
      this.waiting = null;
      apply();
      return;
    }
    this.waiting = apply;
  }

  private drop(): void {
    this.sources.clear();
    this.flushLater();
  }

  private flushLater(): void {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => {
      const apply = this.waiting;
      // A new press may have begun in the meantime: its release will run the rebuild.
      if (this.pressed || !apply) return;
      this.waiting = null;
      apply();
    }, 0);
  }
}
