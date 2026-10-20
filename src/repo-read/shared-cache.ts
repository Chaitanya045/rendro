/**
 * The cacheable subrequest path for public, immutable repository objects (#242).
 *
 * `caches.default` is per-colo, and `cache.put` never feeds Cloudflare's Tiered
 * Cache or Cache Reserve. A `fetch()` to a `Cache-Control`-bearing URL does, so
 * a public object that misses this isolate's memory is read through one: the
 * response fills the colo cache and every tier above it, and the next isolate
 * (or colo) reuses it.
 *
 * The URL carries an HMAC over `public\n<visibility epoch>\n<storage key>`
 * under a key derived from REPO_CAPABILITY_SECRET for this purpose alone
 * (`SHARED_CACHE_KEY_LABEL`), and the epoch rides in the path with it. The
 * route behind it can only ever hold objects the serving Worker decided are
 * public, and only for as long as the repository's visibility epoch (bumped
 * when a repository is privatized, removed or left by its installation) still
 * matches: privatizing kills every outstanding signed URL. A private key has no
 * valid public signature, and the storage key (which carries the repository id
 * and commit) is in the path, so no two objects share a cache key. Private
 * content stays on the per-colo path.
 */
import { constantTimeEqual } from "../../shared/constant-time";
import { base64url, derivedHmacKey, fromBase64url } from "./capability";

/** A reserved path no user URL names; only the reader route and this module use it. */
export const SHARED_CACHE_PATH = "/__repo-cache/tiered/v1/";
/** The named objects are immutable, so a copy may live as long as Cloudflare keeps it. */
export const SHARED_CACHE_TTL_SECONDS = 31_536_000;
/**
 * Negative statuses on the shared path: a revocation 404 may be held briefly
 * (the URL is dead either way), a faulting fill must never be cached — the
 * signed URL is deterministic, so a cached 503 would poison every later read.
 */
const CACHE_TTL_BY_STATUS = { "200-299": SHARED_CACHE_TTL_SECONDS, "404": 60, "500-599": -1 };

const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
/** Canonical decimal epochs only: one URL per object and epoch, so "05" can never stand in for "5". */
const EPOCH = /^(?:0|[1-9]\d{0,14})$/;
/**
 * The shared-cache signing key is `HMAC(REPO_CAPABILITY_SECRET, this label)`, never the raw secret, so
 * no signature here is ever made under a key that also signs capabilities.
 */
export const SHARED_CACHE_KEY_LABEL = "rendro-repo-shared-cache:v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function sign(secret: string, epoch: number, storageKey: string): Promise<string> {
  const key = await derivedHmacKey(secret, SHARED_CACHE_KEY_LABEL);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`public\n${epoch}\n${storageKey}`));
  return base64url(new Uint8Array(mac));
}

/** The signed, cacheable URL for one public immutable object at one visibility epoch. */
export async function sharedCacheUrl(secret: string, origin: string, storageKey: string, epoch: number): Promise<string> {
  return `${origin}${SHARED_CACHE_PATH}${await sign(secret, epoch, storageKey)}/${epoch}/${base64url(encoder.encode(storageKey))}`;
}

/**
 * The storage key and visibility epoch a shared-cache path names, or null
 * unless this secret signed exactly that pair. The encoding must be canonical
 * (one URL per object and epoch), and the signature is compared in constant
 * time. The epoch is re-checked against the store by the caller: the URL only
 * proves what was public when it was minted.
 */
export async function verifySharedCachePath(secret: string, path: string): Promise<{ storageKey: string; epoch: number } | null> {
  if (!path.startsWith(SHARED_CACHE_PATH)) return null;
  const [signature, epoch, encoded, ...rest] = path.slice(SHARED_CACHE_PATH.length).split("/");
  if (rest.length || !SIGNATURE.test(signature) || !EPOCH.test(epoch) || !encoded) return null;
  const bytes = fromBase64url(encoded);
  if (!bytes) return null;
  const storageKey = decoder.decode(bytes);
  if (base64url(encoder.encode(storageKey)) !== encoded) return null;
  if (!constantTimeEqual(signature, await sign(secret, Number(epoch), storageKey))) return null;
  return { storageKey, epoch: Number(epoch) };
}

/** What the platform's cache said about one subrequest, for the dev-only diagnostic. */
export interface SharedCacheProbe {
  /** The response's `CF-Cache-Status`, when the request went through a cache at all. */
  cacheStatus: string | null;
  /** The response's `Age`, when present. */
  age: string | null;
  /** Whether the subrequest returned bytes. */
  served: boolean;
}

/** Reads one signed public object through the cacheable subrequest, or null when it cannot be read. */
export type SharedCacheReader = (repoId: number, storageKey: string) => Promise<Uint8Array | null>;

/**
 * - `visibilityEpoch` reads a repository's current visibility epoch; a failure
 *   skips the shared tier for that read (the per-colo path still answers) so a
 *   broken store never costs a public read its availability.
 * - `probe`, when given, is told what the cache said about each subrequest.
 */
export function sharedCacheReader(
  secret: string,
  origin: string,
  visibilityEpoch: (repoId: number) => Promise<number>,
  fetcher: typeof fetch = fetch,
  probe?: (probe: SharedCacheProbe) => void,
): SharedCacheReader {
  return async (repoId, storageKey) => {
    let epoch: number;
    try {
      epoch = await visibilityEpoch(repoId);
    } catch {
      return null;
    }
    const url = await sharedCacheUrl(secret, origin, storageKey, epoch);
    let response: Response;
    try {
      // `cf` is a Cloudflare extension to RequestInit; cacheEverything makes the subrequest
      // cacheable even where the zone's default rules would not, and the per-status TTLs hold
      // only the immutable 200s — never a faulting fill.
      response = await fetcher(url, { cf: { cacheEverything: true, cacheTtlByStatus: CACHE_TTL_BY_STATUS } } as RequestInit);
    } catch {
      probe?.({ cacheStatus: null, age: null, served: false });
      return null;
    }
    const seen = { cacheStatus: response.headers.get("CF-Cache-Status"), age: response.headers.get("Age"), served: response.ok };
    probe?.(seen);
    if (!response.ok) {
      // Do not hold the failed subrequest's body open; a cancel failure changes nothing here.
      void response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
