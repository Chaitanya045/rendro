// Cloudflare Workers entry point
// Auth is proxied to Convex HTTP actions. Database tables are in Convex component.

// Polyfill DOMParser for Workers (used by AWS SDK XML parser for R2/S3)
let needsPolyfill = typeof DOMParser === "undefined";
if (!needsPolyfill) {
  try { const doc = new DOMParser().parseFromString("<root/>", "text/xml"); needsPolyfill = typeof doc.getElementsByTagName !== "function"; }
  catch { needsPolyfill = true; }
}
if (needsPolyfill) {
  const E = 1, T = 3, D = 9;
  // @ts-expect-error
  globalThis.Node = { ELEMENT_NODE: E, TEXT_NODE: T, DOCUMENT_NODE: D, ATTRIBUTE_NODE: 2, CDATA_SECTION_NODE: 4, COMMENT_NODE: 8, DOCUMENT_FRAGMENT_NODE: 11 };
  class X {
    nodeType: number; nodeName: string; tagName: string;
    children: X[] = []; attributes: Record<string, string> = {};
    #text = "";
    constructor(tag: string, attrs: Record<string, string> = {}, isText = false) {
      this.nodeType = isText ? T : E; this.nodeName = isText ? "#text" : tag;
      this.tagName = tag; this.attributes = attrs;
    }
    get textContent() { return this.#text; }
    set textContent(v: string) { this.#text = v; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    getElementsByTagName(n: string): X[] {
      const r: X[] = [];
      for (const c of this.children) { if (c.nodeType === E && c.tagName === n) r.push(c); r.push(...c.getElementsByTagName(n)); }
      return r;
    }
  }
  function p(xml: string): X {
    xml = xml.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
    const root = new X("#document"); root.nodeType = D;
    const re = /<(\/?)(\w+)([^>]*?)>/g; const stack = [root]; let li = 0; let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const bt = xml.slice(li, m.index).trim();
      if (bt && stack.length) { const tn = new X("#text", {}, true); tn.textContent = bt; stack[stack.length - 1].children.push(tn); }
      const [, cl, tg, ats] = m;
      if (cl) { if (stack.length > 1 && stack[stack.length - 1].tagName === tg) stack.pop(); }
      else {
        const am: Record<string, string> = {}; const ar = /(\w+)\s*=\s*"([^"]*)"/g; let a: RegExpExecArray | null;
        while ((a = ar.exec(ats)) !== null) am[a[1]] = a[2];
        const n = new X(tg, am); if (stack.length) stack[stack.length - 1].children.push(n);
        if (!m[0].endsWith("/>")) stack.push(n);
      }
      li = re.lastIndex;
    }
    return root;
  }
  // @ts-expect-error
  globalThis.DOMParser = class { parseFromString(s: string) { return p(s); } };
}

import { Hono } from "hono";
import { cors } from "hono/cors";
import { sessionMiddleware } from "./middleware/session";
import appRoutes from "./routes/app";
import docsRoutes from "./routes/docs";
import { logger } from "./logger";
import { CONVEX_URL } from "./config";
import type { User } from "better-auth/types";

const app = new Hono<{ Variables: { user?: User } }>();
const CONVEX_SITE = CONVEX_URL.replace(".cloud", ".site");

app.use("*", async (c, next) => {
  const env = c.env as Record<string, unknown>;
  if (env && typeof process !== "undefined")
    for (const k of Object.keys(env))
      if (env[k] !== undefined && process.env[k] === undefined)
        process.env[k] = String(env[k]);
  await next();
});

app.use("/api/sync/*", cors());

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request");
});

app.use("*", async (c, next) => { await sessionMiddleware(c, next); });

// Proxy ALL /api/auth/* to Convex HTTP actions
app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
  const target = `${CONVEX_SITE}${c.req.path}${new URL(c.req.url).search}`;
  // Forward only safe headers — cookie is required for OAuth state validation.
  // Skip Host (misroutes on convex.site), connection/content-length/transfer-encoding (hop-by-hop).
  const SAFE = ["cookie", "content-type", "accept", "accept-language", "origin", "referer", "user-agent", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site"];
  const headers = new Headers();
  for (const k of SAFE) {
    const v = c.req.raw.headers.get(k);
    if (v) headers.set(k, v);
  }
  const init: RequestInit = { method: c.req.method, headers, redirect: "manual" };
  if (c.req.method !== "GET" && c.req.method !== "HEAD")
    init.body = await c.req.raw.text();
  try {
    return await fetch(target, init);
  } catch (err: any) {
    logger.error({ err: err.message }, "Auth proxy error");
    return c.json({ error: "Auth unavailable" }, 502);
  }
});



app.route("/", appRoutes);
app.route("/", docsRoutes);
app.get("/health", (c) => c.text("ok"));

app.onError((err, c) => {
  logger.error({ err: { message: err.message, stack: err.stack }, path: c.req.path }, "Unhandled error");
  return c.json({ error: err.message, path: c.req.path }, 500);
});

export default app;
