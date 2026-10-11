import type { LookupResult } from "@/middleware/session";
import { viewerSessionCookie } from "@/viewer-ticket";

export const SESSION_CACHE_TTL_MS = 15_000;
export const SESSION_CACHE_MAX_ENTRIES = 1_024;

type Cacheable = { kind: string; expiresAt?: number };
type Entry<T> = { cookieName: string; until: number; pending: Promise<T>; value?: T };

/** Hash only an unambiguous session cookie value. Never retain cookie strings. */
export async function sessionCacheKey(cookie: string): Promise<string | null> {
  const pairs = viewerSessionCookie(cookie).split("; ").filter(Boolean);
  // Multiple token cookies can have backend-dependent precedence. Bypass them.
  if (pairs.length !== 1) return null;
  const value = pairs[0].slice(pairs[0].indexOf("=") + 1);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Per-isolate LRU; pending entries count toward the same memory bound. */
export class SessionCache<T extends Cacheable> {
  private readonly entries = new Map<string, Entry<T>>();

  clear(): void { this.entries.clear(); }

  async evict(cookie: string): Promise<void> {
    // Delete each presented token independently, including ambiguous headers.
    // Anonymous/invalid sign-out attempts must not flush other users' entries.
    for (const pair of viewerSessionCookie(cookie).split("; ").filter(Boolean)) {
      const key = await sessionCacheKey(pair);
      if (key) this.entries.delete(key);
    }
  }

  async lookup(cookie: string, resolve: () => Promise<T>): Promise<T> {
    const key = await sessionCacheKey(cookie);
    if (!key) return resolve();
    const cookieName = viewerSessionCookie(cookie).split("=", 1)[0];
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && cached.cookieName === cookieName && cached.until > now) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.value ?? cached.pending;
    }
    this.entries.delete(key);
    // Start TTL before the remote read: a slow response must not extend the
    // accepted revocation interval. Hits never move the expiry deadline.
    const entry: Entry<T> = { cookieName, until: now + SESSION_CACHE_TTL_MS, pending: resolve() };
    this.entries.set(key, entry);
    while (this.entries.size > SESSION_CACHE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    try {
      const result = await entry.pending;
      entry.until = Math.min(entry.until, result.expiresAt ?? 0);
      // Identity guards prevent evicted/revoked in-flight reads repopulating.
      if (this.entries.get(key) === entry) {
        if (result.kind === "authenticated" && entry.until > Date.now()) entry.value = result;
        else this.entries.delete(key);
      }
      return result;
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }
}

export const sessionCache = new SessionCache<LookupResult>();

/** Call before translating authoritative denials into redirects/opaque 404s. */
export async function evictRejectedSession(cookie: string, status: number): Promise<void> {
  // Better Auth also uses 400 for rejected membership/permission checks.
  if ([400, 401, 403, 404].includes(status)) await sessionCache.evict(cookie);
}
