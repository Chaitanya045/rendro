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

function appPolicy(nonce: string, path: string, embeddedError = false): string {
  const viewerShell = /^\/(?:docs|p|public)(?:\/|$)/.test(path) || /\/docs$/.test(path);
  const dynamicStyles = viewerShell || /^\/organizations(?:\/|$)/.test(path);
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${viewerShell ? " https://cdn.tailwindcss.com" : ""}`,
    "script-src-attr 'none'",
    // Tailwind creates style elements; management navigation inserts page CSS,
    // and the shell uses inline style attributes for sizing/loading feedback.
    `style-src 'self' ${dynamicStyles ? "'unsafe-inline'" : `'nonce-${nonce}'`} https://fonts.googleapis.com`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https://lh3.googleusercontent.com",
    `connect-src ${connectionSources()}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    `frame-ancestors ${embeddedError ? "'self'" : "'none'"}`,
  ].join("; ");
}

function documentRoute(path: string): boolean {
  return /^\/organizations\/[^/]+\/projects\/[^/]+\/docs\/(?:files\/|view\/[^/]+\/files\/)/.test(path)
    || /^\/(?:p|s)\/[^/]+\/files\//.test(path)
    || /^\/public\/[^/]+\/[^/]+\/files\//.test(path)
    || /^\/(?:files\/|share\/[^/]+$)/.test(path);
}

/** Outermost middleware in both runtimes, including assets, errors and preflights. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64");
  await nonceContext.run(nonce, next);
  c.header("X-Content-Type-Options", "nosniff");
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=15552000");
  }
  // In particular, never downgrade the private viewer/share no-referrer policy.
  if (!c.res.headers.has("Referrer-Policy")) c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", permissionsPolicy);
  if (!/^text\/html(?:;|$)/i.test(c.res.headers.get("Content-Type") ?? "")) return;

  const document = documentRoute(c.req.path);
  // Document routes serve publisher HTML only on success. Their HTML errors
  // are server-authored pages and need the same nonce policy as other app HTML.
  if (document && c.res.status < 400) {
    // Modern documents already carry an opaque-origin sandbox. Legacy private
    // /files uses same-origin auth for its comment widget; retain that contract.
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", c.req.path.startsWith("/files/")
        ? "frame-ancestors 'self'; object-src 'none'"
        : "sandbox allow-scripts allow-forms allow-popups allow-downloads; frame-ancestors 'self'");
    }
    c.header("X-Frame-Options", "SAMEORIGIN");
  } else {
    // Nonces must never be reused from a stored response. Preserve private
    // no-store policies; replace public/revalidation policies on all app shells.
    const cacheControl = c.res.headers.get("Cache-Control") ?? "";
    c.header("Cache-Control", /(?:^|,)\s*private\s*(?:,|$)/i.test(cacheControl)
      ? "private, no-store" : "no-store");
    c.header("Content-Security-Policy", appPolicy(nonce, c.res.status >= 400 ? "" : c.req.path, document));
    // Styled document errors must remain visible inside the owning viewer.
    c.header("X-Frame-Options", document ? "SAMEORIGIN" : "DENY");
  }
};
