import { securityHeaders } from "./middleware/security-headers";
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
import { faviconAssets, faviconCacheControl } from "./routes/favicon";
import { Hono } from "hono";
import { redactViewerPath } from "./viewer-log";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { sessionMiddleware } from "./middleware/session";
import { logger } from "./logger";
import { registerAuthClientIp } from "./auth-client-ip";
import { renderNotFoundPage } from "./routes/not-found";
import { mountPublicRoutes, mountSessionRoutes } from "./app-routes";
import type { User } from "better-auth/types";

type AssetsBinding = { fetch(request: Request): Response | Promise<Response> };
type WorkerBindings = Record<string, unknown> & { ASSETS?: AssetsBinding };
type WorkerEnv = { Bindings: WorkerBindings; Variables: { user?: User } };

const app = new Hono<WorkerEnv>();
app.use("*", securityHeaders);

async function serveAsset(c: Context<WorkerEnv>): Promise<Response> {
  const assets = c.env?.ASSETS;
  if (assets?.fetch) return assets.fetch(c.req.raw);
  return c.html(renderNotFoundPage({ path: c.req.path }), 404);
}

app.use("*", async (c, next) => {
  // Cloudflare overwrites this header at ingress. Node never trusts it.
  registerAuthClientIp(c.req.raw, c.req.header("CF-Connecting-IP"));
  const env = c.env;
  if (env && typeof process !== "undefined") {
    for (const key of Object.keys(env)) {
      const value = env[key];
      if (typeof value === "string" && process.env[key] === undefined) process.env[key] = value;
    }
  }
  await next();
});

app.use("/api/sync/*", cors());
app.use("*", async (c, next) => { const start = Date.now(); await next(); logger.debug({ method: c.req.method, path: redactViewerPath(c.req.path), status: c.res.status, ms: Date.now() - start }, "request"); });
// Public signed share routes intentionally bypass session middleware.
mountPublicRoutes(app);

// Favicons are public assets and must not trigger a session lookup.
for (const [path, contentType] of Object.entries(faviconAssets)) {
  app.get(path, async (c) => {
    const response = await serveAsset(c);
    if (!response.ok) return response;
    const headers = new Headers(response.headers);
    headers.set("Content-Type", contentType);
    headers.set("Cache-Control", faviconCacheControl);
    return new Response(response.body, { status: response.status, headers });
  });
}

// Public, versioned browser code must not trigger an authenticated session RPC.
app.get("/management-query.js", serveAsset);
app.get("/select.js", serveAsset);
app.get("/management-pages.js", serveAsset);
app.get("/commentor-parent.js", serveAsset);
app.get("/private-viewer.js", serveAsset);
app.use("*", sessionMiddleware);

mountSessionRoutes(app);

// Static files from ASSETS binding
app.get("/lazy-tree.js", serveAsset);
app.get("/commentor.js", serveAsset);
app.get("*", async (c) => {
  const assets = c.env?.ASSETS;
  if (assets?.fetch) {
    const res = await assets.fetch(c.req.raw);
    if (res.status !== 404) return res;
  }
  return c.html(renderNotFoundPage({ path: c.req.path }), 404);
});
app.notFound((c) => c.html(renderNotFoundPage({ path: c.req.path }), 404));

app.onError((err, c) => {
  logger.error({ errorType: err.name, path: redactViewerPath(c.req.path) }, "Unhandled error");
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
