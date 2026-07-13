// Cloudflare Workers entry point
// Auth is proxied to Convex HTTP actions. Database tables are in Convex component.

// DOMParser/Node polyfill for Workers (AWS SDK XML parser for R2/S3).
// Must be an IIFE — esbuild tree-shakes conditional blocks.
;(() => {
  const hasDOMParser = typeof globalThis.DOMParser !== "undefined"
    && typeof new globalThis.DOMParser().parseFromString("<r/>", "text/xml").getElementsByTagName === "function";
  if (hasDOMParser) return;

  const E = 1, T = 3, D = 9;
  class NodePolyfill {
    static readonly ELEMENT_NODE = E;
    static readonly ATTRIBUTE_NODE = 2;
    static readonly TEXT_NODE = T;
    static readonly CDATA_SECTION_NODE = 4;
    static readonly ENTITY_REFERENCE_NODE = 5;
    static readonly ENTITY_NODE = 6;
    static readonly PROCESSING_INSTRUCTION_NODE = 7;
    static readonly COMMENT_NODE = 8;
    static readonly DOCUMENT_NODE = D;
    static readonly DOCUMENT_TYPE_NODE = 10;
    static readonly DOCUMENT_FRAGMENT_NODE = 11;
    static readonly NOTATION_NODE = 12;
  }
  Object.defineProperty(globalThis, "Node", { value: NodePolyfill, configurable: true });

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

  Object.defineProperty(globalThis, "DOMParser", { value: class {
    parseFromString(s: string, _mimeType?: string) {
      const doc = p(s);
      const el = doc.children.find((c: X) => c.nodeType === E) ?? doc.children[0] ?? doc;
      return { documentElement: el, getElementsByTagName: el.getElementsByTagName.bind(el), childNodes: el.children };
    }
  }, configurable: true });
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

type AssetsBinding = { fetch(request: Request): Response | Promise<Response> };
type WorkerBindings = Record<string, unknown> & { ASSETS?: AssetsBinding };

const app = new Hono<{ Bindings: WorkerBindings; Variables: { user?: User } }>();
const CONVEX_SITE = CONVEX_URL.replace(".cloud", ".site");

const AUTH_COOKIE_NAMES = [
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_data",
  "better-auth.session_data",
  "__Secure-better-auth.state",
  "better-auth.state",
  "__Secure-better-auth.oauth_state",
  "better-auth.oauth_state",
  "__Secure-better-auth.dont_remember",
  "better-auth.dont_remember",
  "__Secure-better-auth.account_data",
  "better-auth.account_data",
  "rendro-dev-user",
] as const;
const COOKIE_CHUNK_SUFFIXES = ["", ".0", ".1", ".2", ".3", ".4"] as const;

function strippedSetCookies(headers: Headers): string[] {
  const setCookies = headers.getSetCookie?.();
  const values = setCookies && setCookies.length > 0
    ? setCookies
    : headers.get("set-cookie") ? [headers.get("set-cookie")!] : [];
  return values.map((sc) => sc.replace(/;\s*Domain=[^;]+;?/gi, ";"));
}

function appendExpiredCookie(headers: Headers, name: string) {
  const attributes = name.startsWith("better-auth") || name.startsWith("__Secure-better-auth")
    ? "Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
    : "Max-Age=0; Path=/; SameSite=Lax";
  const secure = name.startsWith("__Secure-") ? "; Secure" : "";
  headers.append("Set-Cookie", `${name}=; ${attributes}${secure}`);
}

function appendAuthCookieCleanup(headers: Headers) {
  for (const name of AUTH_COOKIE_NAMES) {
    const suffixes = name.includes("session_data") || name.includes("account_data") ? COOKIE_CHUNK_SUFFIXES : [""];
    for (const suffix of suffixes) appendExpiredCookie(headers, `${name}${suffix}`);
  }
}

app.use("*", async (c, next) => {
  const env = c.env;
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
  const upstream = await fetch(`${CONVEX_SITE}/api/auth/sign-out`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    redirect: "manual",
  });
  const headers = new Headers({ Location: "/" });
  for (const sc of strippedSetCookies(upstream.headers)) headers.append("Set-Cookie", sc);
  appendAuthCookieCleanup(headers);
  return new Response(null, { status: 302, headers });
});

// Proxy auth to Convex
app.on(["POST", "GET", "OPTIONS"], "/api/auth/*", async (c) => {
  const target = `${CONVEX_SITE}${c.req.path}${new URL(c.req.url).search}`;
  const headers = new Headers();
  const cookie = c.req.raw.headers.get("cookie");
  const ct = c.req.raw.headers.get("content-type");
  if (cookie) headers.set("cookie", cookie);
  if (ct) headers.set("content-type", ct);
  const init: RequestInit = { method: c.req.method, headers, redirect: "manual" };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") init.body = await c.req.raw.text();
  try {
    const upstream = await fetch(target, init);
    const setCookies = strippedSetCookies(upstream.headers);
    if (setCookies.length > 0) {
      const respHeaders = new Headers(upstream.headers);
      respHeaders.delete("set-cookie");
      for (const sc of setCookies) respHeaders.append("set-cookie", sc);
      return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
    }
    return upstream;
  } catch (err: unknown) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "Auth proxy error");
    return c.json({ error: "Auth unavailable" }, 502);
  }
});

app.route("/", appRoutes);
app.route("/", docsRoutes);
app.get("/health", (c) => c.text("ok"));

// Static files from ASSETS binding
app.get("/lazy-tree.js", async (c) => { const assets = c.env?.ASSETS; if (assets?.fetch) return assets.fetch(c.req.raw); return c.notFound(); });
app.get("/commentor.js", async (c) => { const assets = c.env?.ASSETS; if (assets?.fetch) return assets.fetch(c.req.raw); return c.notFound(); });
app.get("*", async (c) => { const assets = c.env?.ASSETS; if (assets?.fetch) return assets.fetch(c.req.raw); return c.notFound(); });

app.onError((err, c) => {
  logger.error({ err: { message: err.message, stack: err.stack }, path: c.req.path }, "Unhandled error");
  return c.json({ error: err.message, path: c.req.path }, 500);
});

export default app;
