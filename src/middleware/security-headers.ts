import { apiCacheControl } from "../../shared/http-cache";
import { nonceContext } from "./html-nonce";
import type { MiddlewareHandler } from "hono";
import { CONVEX_SITE_URL, CONVEX_URL } from "@/config";

const permissionsPolicy = [
  "accelerometer", "autoplay", "camera", "display-capture", "encrypted-media",
  "fullscreen", "geolocation", "gyroscope", "magnetometer", "microphone",
  "midi", "payment", "picture-in-picture", "publickey-credentials-get",
  "screen-wake-lock", "usb", "xr-spatial-tracking",
].map(feature => `${feature}=()`).join(", ");

function connectionSources(): string {
  const sources = new Set(["'self'"]);
  for (const configured of [CONVEX_URL, CONVEX_SITE_URL]) {
    if (!configured) continue;
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    sources.add(url.origin);
    if (configured === CONVEX_URL) {
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      sources.add(url.origin);
    }
  }
  return [...sources].join(" ");
}

function appPolicy(nonce: string, embeddedError = false): string {
  // Every trusted page, including the repository docs shell, accepts only
  // nonced <style> elements and same-origin stylesheets.
  return [
    "default-src 'self'",
    // Nonced scripts and the scripts they load. 'self' is the fallback for
    // browsers without 'strict-dynamic' (CSP3 browsers ignore it here).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "script-src-attr 'none'",
    `style-src 'self' 'nonce-${nonce}'`,
    // Shells use authored style attributes for sizing and loading feedback.
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connectionSources()}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embeddedError ? "'self'" : "'none'"}`,
  ].join("; ");
}

/** Repository document frames and assets (#234): /r/{owner}/{repo}[/{ref}]/files/… and the ticket form. */
const repoDocument = /^\/r\/[^/]+\/[^/]+(?:\/[~@][^/]+)?\/(?:files\/|view\/[^/]+\/files\/)/;

function documentRoute(path: string): boolean {
  return repoDocument.test(path);
}

/** Outermost middleware in both runtimes, including assets, errors and preflights. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
  await nonceContext.run(nonce, next);
  // Apply after downstream handlers (including Hono's error handler), so local
  // denials, proxy failures and malformed/unmatched capability paths inherit it.
  const capability = /^\/(?:reset-password|verify-email)(?:\/|$)/.test(c.req.path);
  if (/^\/api(?:\/|$)/.test(c.req.path)) {
    c.header("Cache-Control", apiCacheControl(c.req.raw, c.res));
    // API data is never a cross-origin subresource: refuse no-cors embedding
    // (script/img/style loads from other sites). CORS fetches are unaffected.
    c.header("Cross-Origin-Resource-Policy", "same-origin");
  } else if (capability || !c.res.headers.has("Cache-Control")) {
    c.header("Cache-Control", "private, no-store");
  }
  if (capability) c.header("Referrer-Policy", "no-referrer");
  // Only the shared asset-error helper may opt an empty, untyped failure out.
  // HTML (including styled document errors) always retains nosniff and CSP.
  const emptyAssetError = c.get("emptyAssetError") === true && c.res.status >= 400
    && c.res.body === null && !c.res.headers.has("Content-Type");
  c.header("X-Content-Type-Options", emptyAssetError ? undefined : "nosniff");
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=15552000");
  }
  // In particular, never downgrade a route's own no-referrer policy.
  if (!c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", permissionsPolicy);
  if (!/^text\/html(?:;|$)/i.test(c.res.headers.get("Content-Type") ?? "")) return;

  const document = documentRoute(c.req.path);
  // Document routes serve rendered repository HTML only on success. Their HTML errors
  // are server-authored pages and need the same nonce policy as other app HTML.
  if (document && c.res.status < 400) {
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'");
    }
    c.header("X-Frame-Options", "SAMEORIGIN");
  } else {
    // Nonces must never be reused from a stored response. Preserve private
    // no-store policies; replace public/revalidation policies on all app shells.
    // Repository shells (#234) alone keep `private, no-cache`: always revalidated, so a
    // navigation gets a fresh nonce, yet not no-store, so the back/forward cache still works.
    const cacheControl = String(c.res.headers.get("Cache-Control"));
    const revalidatedShell = /^\/r\//.test(c.req.path) && c.res.status < 400 && cacheControl === "private, no-cache";
    // No route serves trusted HTML for shared caches any more (#286): even one that asked would get no-store.
    if (!revalidatedShell) c.header("Cache-Control", "private, no-store");
    c.header("Content-Security-Policy", appPolicy(nonce, document));
    // Styled document errors must remain visible inside the owning viewer.
    c.header("X-Frame-Options", document ? "SAMEORIGIN" : "DENY");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    // Top-level trusted pages get their own browsing context group, so no
    // cross-origin window they open or were opened by can script them. Sign-in
    // uses full-page redirects and comments use the frame's postMessage
    // channel, so neither needs an opener. Framed document errors are exempt.
    if (!document) c.header("Cross-Origin-Opener-Policy", "same-origin");
  }
};
