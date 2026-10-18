import { retryAfterMs } from "../../../shared/retry-after";
import { GitHubError } from "./source";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface RateGovernorOptions {
  clock?: Clock;
  /** Requests in flight at once. GitHub's secondary limit is 100 across REST and GraphQL; Workers open 6 connections. */
  maxConcurrent?: number;
  /** Sustained requests per second per endpoint. GitHub allows 900 points per minute per REST endpoint. */
  ratePerSecond?: number;
  burst?: number;
  /** Wait for a secondary limit without Retry-After; GitHub says at least a minute. Doubles per repeat. */
  secondaryBackoffMs?: number;
  maxSecondaryBackoffMs?: number;
  /** Rate-limit waits up to this long happen in place; longer ones surface as a rate-limited error with retryAt. */
  maxInlineWaitMs?: number;
}

export interface RateState {
  remaining: number | null;
  resetAt: number | null;
  blockedUntil: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const SECONDARY = /secondary rate limit|abuse detection/i;

/**
 * Client-side pacing for one token's GitHub budget. It bounds concurrency,
 * paces each endpoint below the per-endpoint secondary limit, and stops all
 * requests once GitHub signals a primary or secondary limit, because
 * continuing while limited risks the integration being banned.
 */
export class RateGovernor {
  private readonly clock: Clock;
  private readonly maxConcurrent: number;
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private readonly secondaryBackoffMs: number;
  private readonly maxSecondaryBackoffMs: number;
  readonly maxInlineWaitMs: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly buckets = new Map<string, Bucket>();
  private consecutiveSecondary = 0;
  private state: RateState = { remaining: null, resetAt: null, blockedUntil: 0 };

  constructor(options: RateGovernorOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.ratePerSecond = options.ratePerSecond ?? 10;
    this.burst = options.burst ?? 10;
    this.secondaryBackoffMs = options.secondaryBackoffMs ?? 60_000;
    this.maxSecondaryBackoffMs = options.maxSecondaryBackoffMs ?? 15 * 60_000;
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? 1_000;
  }

  snapshot(): RateState {
    return { ...this.state };
  }

  /** Wait for a request slot on `endpoint`. Resolves to the release function. */
  async acquire(endpoint: string): Promise<() => void> {
    for (;;) {
      const now = this.clock.now();
      const blockedFor = this.state.blockedUntil - now;
      if (blockedFor > 0) {
        if (blockedFor > this.maxInlineWaitMs) {
          throw new GitHubError("rate-limited", "GitHub rate limit in effect", null, this.state.blockedUntil);
        }
        await this.clock.sleep(blockedFor);
        continue;
      }
      const bucket = this.refill(endpoint, now);
      if (bucket.tokens < 1) {
        await this.clock.sleep(Math.ceil(((1 - bucket.tokens) / this.ratePerSecond) * 1000));
        continue;
      }
      if (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      bucket.tokens -= 1;
      this.active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.waiters.shift()?.();
      };
    }
  }

  /** Record the rate headers of any response. */
  observe(headers: Headers): void {
    const remaining = integerHeader(headers, "x-ratelimit-remaining");
    const reset = integerHeader(headers, "x-ratelimit-reset");
    if (remaining !== null) this.state.remaining = remaining;
    if (reset !== null) this.state.resetAt = reset * 1000;
    // Out of primary quota: send nothing more until the window resets.
    if (this.state.remaining === 0 && this.state.resetAt !== null) {
      this.block(this.state.resetAt);
    }
  }

  /**
   * Classify a 403/429. Returns the time to retry at when it is a rate limit,
   * or null for an ordinary permission error.
   */
  limited(status: number, headers: Headers, message: string): number | null {
    const now = this.clock.now();
    const retryAfter = retryAfterMs(headers.get("retry-after"), now);
    let retryAt: number | null = null;
    if (retryAfter > 0) {
      retryAt = now + retryAfter;
    } else if (this.state.remaining === 0 && this.state.resetAt !== null) {
      retryAt = Math.max(this.state.resetAt, now + 1000);
    } else if (status === 429 || SECONDARY.test(message)) {
      const backoff = this.secondaryBackoffMs * 2 ** this.consecutiveSecondary;
      retryAt = now + Math.min(backoff, this.maxSecondaryBackoffMs);
    }
    if (retryAt === null) return null;
    this.consecutiveSecondary += 1;
    this.block(retryAt);
    return retryAt;
  }

  /** A request succeeded, so secondary-limit backoff starts over. */
  succeeded(): void {
    this.consecutiveSecondary = 0;
  }

  private block(until: number): void {
    this.state.blockedUntil = Math.max(this.state.blockedUntil, until);
  }

  private refill(endpoint: string, now: number): Bucket {
    let bucket = this.buckets.get(endpoint);
    if (!bucket) {
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(endpoint, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.burst, bucket.tokens + (elapsed / 1000) * this.ratePerSecond);
    bucket.updatedAt = now;
    return bucket;
  }
}

function integerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : null;
}
