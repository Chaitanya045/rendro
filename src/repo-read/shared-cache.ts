/**
 * The cacheable subrequest path for public, immutable repository objects (#242).
 *
 * `caches.default` is per-colo, and `cache.put` never feeds Cloudflare's Tiered
 * Cache or Cache Reserve. A `fetch()` to a `Cache-Control`-bearing URL does, so
 * a public object that misses this isolate's memory is read through one: the
 * response fills the colo cache and every tier above it, and the next isolate
 * (or colo) reuses it.
 *
 * The URL carries an HMAC over `public\n<storage key>` under
 * REPO_CAPABILITY_SECRET. The route behind it, and any upper cache tier, can
 * therefore only ever hold objects the serving Worker decided are public; the
 * visibility is in the signed payload, so a private key has no valid public
 * signature, and the storage key (which carries the repository id and commit)
 * is in the path, so no two objects share a cache key. Private content stays on
 * the per-colo path.
 */
import { constantTimeEqual } from "../../shared/constant-time";
import { base64url, fromBase64url } from "./capability";

/** A reserved path no user URL names; only the reader route and this module use it. */
export const SHARED_CACHE_PATH = "/__repo-cache/tiered/v1/";
/** The named objects are immutable, so a copy may live as long as Cloudflare keeps it. */
export const SHARED_CACHE_TTL_SECONDS = 31_536_000;

const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** One HMAC key per secret, imported once per isolate (tests switch secrets). */
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keys.set(secret, key);
  }
  return key;
}

async function sign(secret: string, storageKey: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`public\n${storageKey}`));
  return base64url(new Uint8Array(mac));
}

/** The signed, cacheable URL for one public immutable object. */
export async function sharedCacheUrl(secret: string, origin: string, storageKey: string): Promise<string> {
  return `${origin}${SHARED_CACHE_PATH}${await sign(secret, storageKey)}/${base64url(encoder.encode(storageKey))}`;
}

/**
 * The storage key a shared-cache path names, or null unless this secret signed
 * exactly that object. The encoding must be canonical (one URL per object), and
 * the signature is compared in constant time.
 */
export async function verifySharedCachePath(secret: string, path: string): Promise<string | null> {
  if (!path.startsWith(SHARED_CACHE_PATH)) return null;
  const [signature, encoded, ...rest] = path.slice(SHARED_CACHE_PATH.length).split("/");
  if (rest.length || !SIGNATURE.test(signature) || !encoded) return null;
  const bytes = fromBase64url(encoded);
  if (!bytes) return null;
  const storageKey = decoder.decode(bytes);
  if (base64url(encoder.encode(storageKey)) !== encoded) return null;
  if (!constantTimeEqual(signature, await sign(secret, storageKey))) return null;
  return storageKey;
}

/** Reads one signed public object through the cacheable subrequest, or null when it cannot be read. */
export type SharedCacheReader = (storageKey: string) => Promise<Uint8Array | null>;

export function sharedCacheReader(secret: string, origin: string, fetcher: typeof fetch = fetch): SharedCacheReader {
  return async (storageKey) => {
    const url = await sharedCacheUrl(secret, origin, storageKey);
    let response: Response;
    try {
      // `cf` is a Cloudflare extension to RequestInit; cacheEverything makes the subrequest
      // cacheable even where the zone's default rules would not, and cacheTtl matches the
      // immutable object.
      response = await fetcher(url, { cf: { cacheEverything: true, cacheTtl: SHARED_CACHE_TTL_SECONDS } } as RequestInit);
    } catch {
      return null;
    }
    if (!response.ok) {
      // Do not hold the failed subrequest's body open; a cancel failure changes nothing here.
      void response.body?.cancel();
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
