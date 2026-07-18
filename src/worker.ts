// Cloudflare Workers entry point
// Auth is proxied to Convex HTTP actions. Database tables are in Convex component.

// DOMParser/Node polyfill for Workers (AWS SDK XML parser for R2/S3).
// Must be an IIFE — esbuild tree-shakes conditional blocks.
;(() => {
  const hasDOMParser = typeof (globalThis as any).DOMParser !== "undefined"
    && typeof new (globalThis as any).DOMParser().parseFromString("<r/>", "text/xml").getElementsByTagName === "function";
  if (hasDOMParser) return;

  const E = 1, T = 3, D = 9;
  (globalThis as any).Node = { ELEMENT_NODE: E, TEXT_NODE: T, DOCUMENT_NODE: D, ATTRIBUTE_NODE: 2, CDATA_SECTION_NODE: 4, COMMENT_NODE: 8, DOCUMENT_FRAGMENT_NODE: 11 };

  class X {
    nodeType = E; nodeName = ""; tagName = "";
    children: X[] = []; attributes: Record<string, string> = {};
    textContent = "";
    constructor(tag: string, attrs: Record<string, string> = {}, isText = false) {
      this.nodeType = isText ? T : E; this.nodeName = isText ? "#text" : tag;
      this.tagName = tag; this.attributes = attrs;
    }
    get childNodes() { return this.children; }
    get nodeValue() { return this.textContent; }
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

  (globalThis as any).DOMParser = class {
    parseFromString(s: string) {
      const doc = p(s);
      const el = doc.children.find((c: X) => c.nodeType === E) ?? doc.children[0] ?? doc;
      return { documentElement: el, getElementsByTagName: el.getElementsByTagName.bind(el), childNodes: el.children };
    }
  };
})();
import shareRoutes from "@/routes/share";

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
app.use("*", async (c, next) => { const start = Date.now(); await next(); logger.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request"); });
// Public signed share routes intentionally bypass session middleware.
app.route("/", shareRoutes);

app.use("*", async (c, next) => { await sessionMiddleware(c, next); });

// Sign-out: GET → POST
app.get("/api/auth/sign-out", async (c) => {
  const cookie = c.req.raw.headers.get("cookie") || "";
  await fetch(`${CONVEX_SITE}/api/auth/sign-out`, { method: "POST", headers: { cookie, "content-type": "application/json" }, redirect: "manual" });
  const res = new Response(null, { status: 302, headers: { Location: "/" } });
  res.headers.append("Set-Cookie", "__Secure-better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
  res.headers.append("Set-Cookie", "better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax");
  return res;
});

// Proxy auth to Convex
app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
  const target = `${CONVEX_SITE}${c.req.path}${new URL(c.req.url).search}`;
  const headers = new Headers();
  const cookie = c.req.raw.headers.get("cookie");
  const ct = c.req.raw.headers.get("content-type");
  const origin = c.req.raw.headers.get("origin");
  if (cookie) headers.set("cookie", cookie);
  if (ct) headers.set("content-type", ct);
  if (origin) headers.set("origin", origin);
  const init: RequestInit = { method: c.req.method, headers, redirect: "manual" };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = await c.req.raw.text();
  try {
    const upstream = await fetch(target, init);
    const setCookies = upstream.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const cleaned = setCookies.map((sc: string) => sc.replace(/;\s*Domain=[^;]+;?/gi, ";"));
      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("set-cookie");
      for (const sc of cleaned) respHeaders.append("set-cookie", sc);
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }
    return upstream;
  } catch (err: any) {
    logger.error({ err: err.message }, "Auth proxy error");
    return c.json({ error: "Auth unavailable" }, 502);
  }
});

app.route("/", appRoutes);
app.route("/", docsRoutes);
app.get("/health", (c) => c.text("ok"));

// Static files from ASSETS binding
app.get("/lazy-tree.js", async (c) => { const a = (c.env as any).ASSETS; if (a?.fetch) return a.fetch(c.req.raw); return c.notFound(); });
app.get("/commentor.js", async (c) => { const a = (c.env as any).ASSETS; if (a?.fetch) return a.fetch(c.req.raw); return c.notFound(); });
app.get("*", async (c) => { const a = (c.env as any).ASSETS; if (a?.fetch) return a.fetch(c.req.raw); return c.notFound(); });

app.onError((err, c) => {
  logger.error({ err: { message: err.message, stack: err.stack }, path: c.req.path }, "Unhandled error");
  return c.json({ error: err.message, path: c.req.path }, 500);
});

export default app;
