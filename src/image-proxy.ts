import { constantTimeEqual } from "../shared/constant-time";
import { isProxyableImageUrl } from "@/image-proxy-target";

/*
 * Signed same-origin image URLs, like GitHub's camo. Ingest rewrites every
 * external image to `/img/<sig>/<encoded-url>`, where `encoded-url` is the
 * base64url of the exact URL and `sig` the base64url HMAC-SHA256 of that URL
 * under IMAGE_PROXY_SECRET. The proxy route serves only URLs it signed, so it
 * is not an open proxy.
 */

export const IMAGE_PROXY_PREFIX = "/img/";
/** Longer URLs are not proxied: the image loses its src. Keeps proxy paths well under URL limits. */
export const MAX_PROXIED_URL_CHARS = 2048;

const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const ENCODED = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

// The key is imported once per isolate. A different secret (only tests switch) re-imports.
let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]) };
  }
  return cachedKey.key;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, url: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(url))));
}

/**
 * The proxy path for an external image, or null when the URL must not be
 * proxied (not http(s), a blocked target, or too long). Ingest passes URLs
 * already normalized by `new URL().href`, which are ASCII.
 */
export async function imageProxyPath(secret: string, url: string): Promise<string | null> {
  if (url.length > MAX_PROXIED_URL_CHARS || !isProxyableImageUrl(url)) return null;
  return `${IMAGE_PROXY_PREFIX}${await sign(secret, url)}/${base64url(encoder.encode(url))}`;
}

/**
 * The URL a proxy path names, or null unless it is exactly a path this secret
 * produced. The encoding must be canonical, so each URL has one signed path,
 * and the signature is compared as a string, so no character of it can vary.
 */
export async function verifyImageProxyPath(secret: string, path: string): Promise<string | null> {
  if (!path.startsWith(IMAGE_PROXY_PREFIX)) return null;
  const [signature, encoded, ...rest] = path.slice(IMAGE_PROXY_PREFIX.length).split("/");
  if (rest.length || !SIGNATURE.test(signature) || !ENCODED.test(encoded ?? "") || encoded.length > Math.ceil(MAX_PROXIED_URL_CHARS * 4 / 3)) return null;
  let url: string;
  try {
    url = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  // atob yields one char per byte; signed URLs are ASCII, so anything else is not ours.
  if (/[^\x20-\x7e]/.test(url) || base64url(encoder.encode(url)) !== encoded) return null;
  return constantTimeEqual(signature, await sign(secret, url)) ? url : null;
}
