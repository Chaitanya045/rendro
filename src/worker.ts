// Cloudflare Workers entry point

// Polyfill DOMParser for Workers (used by AWS SDK XML parser for R2/S3)
let needsPolyfill = typeof DOMParser === "undefined";
if (!needsPolyfill) {
  try {
    const doc = new DOMParser().parseFromString("<root/>", "text/xml");
    needsPolyfill = typeof doc.getElementsByTagName !== "function";
  } catch { needsPolyfill = true; }
}
  // DOM Node type constants
  const ELEMENT_NODE = 1, TEXT_NODE = 3, DOCUMENT_NODE = 9;
  // @ts-expect-error — AWS SDK XML parser needs Node global
  globalThis.Node = { ELEMENT_NODE, TEXT_NODE, DOCUMENT_NODE, ATTRIBUTE_NODE: 2, CDATA_SECTION_NODE: 4, COMMENT_NODE: 8, DOCUMENT_FRAGMENT_NODE: 11 };

  class XmlNode {
    nodeType: number;
    nodeName: string;
    tagName: string;
    children: XmlNode[];
    attributes: Record<string, string>;
    #text = "";
    constructor(tag: string, attrs: Record<string, string> = {}, isText = false) {
      this.nodeType = isText ? TEXT_NODE : ELEMENT_NODE;
      this.nodeName = isText ? "#text" : tag;
      this.tagName = tag;
      this.children = [];
      this.attributes = attrs;
    }
    get textContent(): string { return this.#text; }
    set textContent(v: string) { this.#text = v; }
    get childNodes(): XmlNode[] { return this.children; }
    get firstChild(): XmlNode | null { return this.children[0] || null; }
    getElementsByTagName(name: string): XmlNode[] {
      const results: XmlNode[] = [];
      for (const c of this.children) {
        if (c.nodeType === ELEMENT_NODE && c.tagName === name) results.push(c);
        results.push(...c.getElementsByTagName(name));
      }
      return results;
    }
  }

  function parseXml(xml: string): XmlNode {
    // Strip XML declaration, doctype, comments
    xml = xml.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
    const root = new XmlNode("#document", {});
    root.nodeType = DOCUMENT_NODE;
    const tagRE = /<(\/?)(\w+)([^>]*?)>/g;
    const stack: XmlNode[] = [root];
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRE.exec(xml)) !== null) {
      const beforeText = xml.slice(lastIdx, match.index).trim();
      if (beforeText && stack.length > 0) {
        const textNode = new XmlNode("#text", {}, true);
        textNode.textContent = beforeText;
        stack[stack.length - 1].children.push(textNode);
      }
      const [, closing, tag, attrs] = match;
      if (closing) {
        if (stack.length > 1 && stack[stack.length - 1].tagName === tag) stack.pop();
      } else {
        const attrMap: Record<string, string> = {};
        const attrRE = /(\w+)\s*=\s*"([^"]*)"/g;
        let am: RegExpExecArray | null;
        while ((am = attrRE.exec(attrs)) !== null) attrMap[am[1]] = am[2];
        const node = new XmlNode(tag, attrMap);
        if (stack.length > 0) stack[stack.length - 1].children.push(node);
        if (!match[0].endsWith("/>")) stack.push(node);
      }
      lastIdx = tagRE.lastIndex;
    }
    // If root has exactly one element child, that's the documentElement
    return root;
  }

  // @ts-expect-error — DOMParser polyfill
  globalThis.DOMParser = class {
    parseFromString(source: string, _mime: string) {
      return parseXml(source);
    }
  };

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthInstance } from "./auth";
import { auth as eagerAuth, getAuth } from "./auth";
import { sessionMiddleware } from "./middleware/session";
import appRoutes from "./routes/app";
import docsRoutes from "./routes/docs";
import { logger } from "./logger";
import type { User } from "better-auth/types";

let auth: AuthInstance | null = null;

const app = new Hono<{ Variables: { user?: User } }>();

app.use("*", async (c, next) => {
  const env = c.env as Record<string, unknown>;
  if (env && typeof process !== "undefined") {
    for (const key of Object.keys(env)) {
      if (env[key] !== undefined && process.env[key] === undefined) {
        process.env[key] = String(env[key]);
      }
    }
  }
  if (!auth) {
    auth = eagerAuth ?? await getAuth(env);
  }
  await next();
});

app.use("/api/sync/*", cors());

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.debug({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start }, "request");
});

app.use("*", async (c, next) => {
  await sessionMiddleware(c, next);
});

app.get("/api/auth/me", (c) => c.json(c.get("user") || { user: null }));

app.get("/api/auth/sign-out", async (c) => {
  if (!auth) return c.text("Auth not ready", 503);
  await auth.api.signOut({ headers: c.req.raw.headers });
  return c.redirect("/");
});

app.on(["POST", "GET"], "/api/auth/*", async (c) => {
  if (!auth) return c.text("Auth not ready", 503);
  try {
    const res = await auth.handler(c.req.raw);
    if (res.status >= 400 || (res.status >= 300 && res.status < 400)) {
      const loc = res.headers.get("location") || "";
      logger.warn({ status: res.status, location: loc, path: c.req.path }, "Auth response");
    }
    return res;
  } catch (err: unknown) {
    const e = err as Error;
    logger.error({ err: { message: e.message, stack: e.stack } }, "Auth handler error");
    return c.json({ error: e.message || "Auth error" }, 500);
  }
});

app.route("/", appRoutes);
app.route("/", docsRoutes);

app.get("/health", (c) => c.text("ok"));

app.onError((err) => {
  logger.error({ err: { message: err.message, stack: err.stack } }, "Unhandled error");
  return new Response(JSON.stringify({
    error: err.message,
    stack: typeof err.stack === "string" ? err.stack.split("\n").slice(0, 8) : undefined,
  }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
});

export default app;
