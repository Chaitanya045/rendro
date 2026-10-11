import { Hono } from "hono";
import type { User } from "better-auth/types";
import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth } from "better-auth/minimal";
import { testUtils } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Window as DOMWindow } from "happy-dom";
import { createAuthOptions } from "../convex/auth";
import projectDocs from "@/routes/project-docs";
import { sessionMiddleware } from "@/middleware/session";
import * as minio from "@/minio";
import { createViewerTicket } from "@/viewer-ticket";
import { viewerHtmlForms } from "./fixtures/private-viewer-html";

const base = "/organizations/org-a/projects/project-a/docs";
const manifestKey = "tenants/org-a/projects/project-a/deployments/deploy-a/manifest.json";
const files = [
  { path: "guide/index.html", contentType: "text/html; charset=utf-8", content: '<!doctype html><html><head><link rel="stylesheet" href="assets/site.css"></head><body><img src="assets/image.png"><a href="next.html">Next</a></body></html>' },
  { path: "guide/next.html", contentType: "text/html", content: "<body>Next document</body>" },
  { path: "guide/assets/site.css", contentType: "text/css; charset=utf-8", content: '@import "nested/theme.css"; body { background: url(image.png) }' },
  { path: "guide/assets/nested/theme.css", contentType: "text/css", content: '@font-face { font-family: Docs; src: url(../font.woff2) }' },
  { path: "guide/assets/image.png", contentType: "image/png", content: "png-fixture" },
  { path: "guide/assets/font.woff2", contentType: "font/woff2", content: "font-fixture" },
];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture() {
  const database: Record<string, unknown[]> = { user: [], session: [], account: [], verification: [] };
  const configured = createAuthOptions({} as never);
  const auth = betterAuth({
    ...configured, database: memoryAdapter(database), baseURL: "http://localhost:3000",
    advanced: { database: { generateId: "uuid" as const } }, rateLimit: { enabled: false }, plugins: [testUtils()],
  });
  const context = await auth.$context;
  const user = context.test!.createUser({ email: "viewer@rendro.invalid", emailVerified: true });
  await context.test!.saveUser(user);
  const login = await context.test!.login({ userId: user.id });
  const cookie = login.headers.get("cookie")!;
  const state = { member: true, manifestKey, activeCalls: 0, sessionCalls: 0, failSession: false, failActive: undefined as (() => Promise<Response> | Response) | undefined };
  const backend = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/auth/get-session") {
      state.sessionCalls++;
      if (state.failSession) return new Response(null, { status: 503, headers: { "Retry-After": "60" } });
      return auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers }));
    }
    if (url.pathname === "/api/rendro/deployments/active") {
      state.activeCalls++;
      if (state.failActive) return state.failActive();
      // Real persisted Better Auth session validation, with mutable membership
      // and project/deployment results at the Convex HTTP boundary.
      const session = await auth.api.getSession({ headers });
      if (!session || !state.member) return Response.json({ error: "Forbidden" }, { status: 403 });
      if (url.searchParams.get("organizationId") !== "org-a" || url.searchParams.get("projectId") !== "project-a") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json({ project: { name: "Private docs" }, deployment: { manifestKey: state.manifestKey } });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", backend);
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1, files }));
  const objects = vi.spyOn(minio, "getObjectStream").mockImplementation(key => {
    const entry = files.find(file => key.endsWith(`/files/${file.path}`));
    return Promise.resolve(entry ? new Response(entry.content).body : null);
  });
  const app = new Hono<{ Variables: { user?: User } }>();
  app.use("*", sessionMiddleware);
  app.route("/", projectDocs);
  async function document() {
    const response = await app.request(`${base}/files/guide/index.html`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    const href = html.match(/<base data-rendro-viewer href="([^"]+)"/)?.[1];
    expect(href).toBeTruthy();
    return { html, url: new URL(href!, "http://localhost"), response };
  }
  return { app, cookie, state, objects, document, revoke: () => context.internalAdapter.deleteSession(login.session.token) };
}

describe("private sandbox asset routing", () => {
  it("skips the redundant cookie lookup on ticket assets while still revalidating authorization", async () => {
    const f = await fixture();
    const { url } = await f.document();
    f.state.sessionCalls = 0;
    const activeBefore = f.state.activeCalls;
    f.state.failSession = true;
    const headers = { Cookie: f.cookie };
    expect((await f.app.request(new URL("assets/site.css", url).href, { headers })).status).toBe(200);
    expect(f.state.sessionCalls).toBe(0);
    expect(f.state.activeCalls).toBe(activeBefore + 1);
    f.state.member = false;
    expect((await f.app.request(new URL("assets/site.css", url).href, { headers })).status).toBe(404);
    expect(f.state.sessionCalls).toBe(0);
    expect(f.state.activeCalls).toBe(activeBefore + 2);
  });

  const routes = ["shell", "canonical", "tree", "renewal", "ticket"] as const;
  function routePath(route: typeof routes[number], ticketUrl: URL) {
    return route === "shell" ? base : route === "canonical" ? `${base}/files/guide/index.html`
      : route === "tree" ? `${base}/tree` : route === "renewal" ? `${base}/viewer-ticket?manifestKey=${manifestKey}`
        : new URL("assets/site.css", ticketUrl).href;
  }
  it.each(routes)("returns retryable 503 for downstream authorization failures on %s", async route => {
    const f = await fixture();
    const { url } = await f.document();
    const failures = [
      () => new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 302, headers: { Location: "/sign-in" } }),
      () => Promise.reject(new Error("secret backend error")),
      () => new Response("secret malformed JSON"),
      () => Response.json({ project: {}, deployment: {} }),
    ];
    f.objects.mockClear();
    for (const fail of failures) {
      f.state.failActive = fail;
      const response = await f.app.request(routePath(route, url), { headers: route === "ticket" ? {} : { Cookie: f.cookie } });
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe(fail === failures[0] ? "60" : "1");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("location")).toBeNull();
      const body = await response.text();
      expect(body).not.toMatch(/secret|Document unavailable/);
      if (route === "tree" || route === "renewal") expect(JSON.parse(body).retryable).toBe(true);
      else if (route === "ticket") expect(body).toBe("Service unavailable");
      else expect(body).toContain('href="">Try again</a>');
    }
    expect(f.objects).not.toHaveBeenCalled();
  });

  describe.each(["ticket", "canonical"])("%s retryable asset failures", route => {
    it.each([
      ["assets/image.png", "image/avif,image/webp,*/*;q=0.8"],
      ["assets/font.woff2", "font/woff2"],
      ["assets/site.css", "text/css,*/*;q=0.1"],
      ["assets/module.js", "*/*"],
      ["image", "image/png"], ["font", "font/woff2"],
      ["stylesheet", "text/css"], ["script", "application/javascript"],
    ])("returns plain 503 for %s (%s)", async (path, accept) => {
      const f = await fixture();
      const { url } = await f.document();
      f.state.failActive = () => new Response("secret upstream diagnostics", {
        status: 503, headers: { "Retry-After": "9" },
      });
      f.objects.mockClear();
      const target = route === "ticket" ? new URL(path, url).href : `${base}/files/guide/${path}`;
      const response = await f.app.request(target, { headers: {
        Accept: accept, ...(route === "canonical" ? { Cookie: f.cookie } : {}),
      } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
      expect(response.headers.get("Retry-After")).toBe("9");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(await response.text()).toBe("Service unavailable");
      expect(f.objects).not.toHaveBeenCalled();
    });

    it("keeps the styled 503 page for HTML document requests", async () => {
      const f = await fixture();
      const { url } = await f.document();
      f.state.failActive = () => new Response(null, { status: 503, headers: { "Retry-After": "9" } });
      const target = route === "ticket" ? url.href : `${base}/files/guide/index.html`;
      const response = await f.app.request(target, { headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        ...(route === "canonical" ? { Cookie: f.cookie } : {}),
      } });
      expect(response.status).toBe(503);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(response.headers.get("Retry-After")).toBe("9");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const body = await response.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain('href="">Try again</a>');
    });
  });

  it.each(routes)("reserves 404 for authoritative absence/denial on %s", async route => {
    const f = await fixture();
    const { url } = await f.document();
    for (const fail of [
      ...[401, 403, 404].map(status => () => new Response(null, { status })),
      () => Response.json(null),
      () => Response.json({ project: { name: "Docs" }, deployment: null }),
    ]) {
      f.state.failActive = fail;
      expect((await f.app.request(routePath(route, url), { headers: route === "ticket" ? {} : { Cookie: f.cookie } })).status).toBe(404);
    }
  });

  it.each(routes.filter(route => route !== "ticket"))("returns 503 for middleware lookup failures on %s", async route => {
    const f = await fixture();
    const { url } = await f.document();
    f.state.failSession = true;
    const response = await f.app.request(routePath(route, url), { headers: { Cookie: f.cookie, Accept: "text/html" } });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it.each([false, true])("bounds downstream authorization timeout including body reads (%s)", async bodyStalls => {
    const f = await fixture();
    const { url } = await f.document();
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal!;
      if (bodyStalls) return Promise.resolve(new Response(new ReadableStream({
        start(controller) { signal.addEventListener("abort", () => controller.error(new Error("timeout"))); },
      })));
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = f.app.request(new URL("assets/site.css", url).href);
    // Ticket decryption uses native WebCrypto before the fetch deadline starts.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(503);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unused cache cookies on the downstream shell and tree lookups too", async () => {
    const f = await fixture();
    const headers = { Cookie: `${f.cookie}; better-auth.session_data=malformed` };
    expect((await f.app.request(base, { headers })).status).toBe(200);
    expect((await f.app.request(`${base}/tree`, { headers })).status).toBe(200);
  });

  it.each(viewerHtmlForms)("establishes the ticket before resources with %s", async (_name, source) => {
    const f = await fixture();
    f.objects.mockImplementation(() => Promise.resolve(new Response(source).body));
    const { html, url } = await f.document();
    expect(html.indexOf("<base ")).toBeLessThan(html.toLowerCase().indexOf("<link "));
    const win = new DOMWindow({ url: `http://localhost${base}/files/guide/index.html`, settings: {
      disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
    } });
    try {
      win.document.write(html);
      expect(new URL(win.document.querySelector("link")!.getAttribute("href")!, win.document.baseURI).href)
        .toBe(new URL("assets/site.css", url).href);
    } finally { await win.happyDOM.close(); }
  });

  it.each([
    ["../shared/", "shared/"],
    [`${base}/files/shared/`, "shared/"],
    ["https://publisher.test/docs/", undefined],
    ["/public/", undefined],
  ])("respects publisher base %s", async (publisherBase, scopedPath) => {
    const f = await fixture();
    const source = `<!doctype html><title>Docs</title><base href="${publisherBase}"><link rel="stylesheet" href="site.css"><body>Docs`;
    f.objects.mockImplementation(() => Promise.resolve(new Response(source).body));
    const response = await f.app.request(`${base}/files/guide/index.html`, { headers: { Cookie: f.cookie } });
    const html = await response.text();
    const win = new DOMWindow({ url: `http://localhost${base}/files/guide/index.html`, settings: {
      disableCSSFileLoading: true, disableJavaScriptFileLoading: true,
    } });
    try {
      win.document.write(html);
      expect(html).toContain(`<base href="${publisherBase}">`);
      const href = new URL(win.document.querySelector("link")!.getAttribute("href")!, win.document.baseURI).href;
      if (scopedPath) {
        expect(href).toContain(`${base}/view/`);
        expect(href).toMatch(new RegExp(`/files/${scopedPath}site.css$`));
      } else {
        expect(html).not.toContain("<base data-rendro-viewer");
        expect(href).toBe(new URL("site.css", new URL(publisherBase, "http://localhost")).href);
      }
    } finally { await win.happyDOM.close(); }
  });

  it("loads CSS, image, nested CSS and font without cookies from the real document base (original regression)", async () => {
    const f = await fixture();
    const { html, url, response } = await f.document();
    expect(response.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(html.indexOf("<base ")).toBeLessThan(html.indexOf('href="assets/site.css"'));
    expect(html).toContain('"transport":"parent"');
    expect(html).toContain('"documentPath":"guide/index.html"');
    const cssUrl = new URL("assets/site.css", url);
    const nestedUrl = new URL("nested/theme.css", cssUrl);
    const requests = [
      [cssUrl, "text/css; charset=utf-8", files[2].content],
      [new URL("image.png", cssUrl), "image/png", "png-fixture"],
      [nestedUrl, "text/css", files[3].content],
      [new URL("../font.woff2", nestedUrl), "font/woff2", "font-fixture"],
    ] as const;
    for (const [assetUrl, contentType, body] of requests) {
      const asset = await f.app.request(assetUrl.href, { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site" } });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("Content-Type")).toBe(contentType);
      expect(asset.headers.get("Access-Control-Allow-Origin")).toBe("null");
      expect(asset.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(asset.headers.get("Cache-Control")).toBe("private, no-store");
      expect(asset.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(await asset.text()).toBe(body);
    }
    expect(f.state.activeCalls).toBe(5);
    expect((await f.app.request(`${base}/files/guide/assets/site.css`)).status).toBe(404);
  });

  it.each(["session", "membership", "manifest"])("rejects an already-issued ticket immediately after %s revocation/change", async reason => {
    const f = await fixture();
    const { url } = await f.document();
    const asset = new URL("assets/image.png", url);
    expect((await f.app.request(asset.href)).status).toBe(200);
    if (reason === "session") await f.revoke();
    if (reason === "membership") f.state.member = false;
    if (reason === "manifest") f.state.manifestKey = manifestKey.replace("deploy-a/", "deploy-b/");
    f.objects.mockClear();
    const denied = await f.app.request(asset.href);
    expect(denied.status).toBe(404);
    expect(f.objects).not.toHaveBeenCalled();
    expect(await denied.text()).not.toContain(url.pathname.split("/view/")[1].split("/")[0]);
  });

  it("denies mismatched scope, unknown manifest entries, and expired tickets before object reads", async () => {
    const f = await fixture();
    const token = await createViewerTicket({ organizationId: "org-a", projectId: "project-a", manifestKey, cookie: f.cookie });
    f.objects.mockClear();
    for (const path of [
      `${base.replace("org-a", "org-b")}/view/${token}/files/guide/assets/image.png`,
      `${base.replace("project-a", "project-b")}/view/${token}/files/guide/assets/image.png`,
      `${base}/view/${token}/files/not-in-manifest.png`,
    ]) expect((await f.app.request(path)).status).toBe(404);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect((await f.app.request(`${base}/view/${token}/files/guide/assets/image.png`)).status).toBe(404);
    expect(f.objects).not.toHaveBeenCalled();
  });

  it("renews with a live parent session beyond the old ticket lifetime, but never from a ticket alone", async () => {
    const f = await fixture();
    const { url } = await f.document();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const endpoint = `${base}/viewer-ticket?${new URLSearchParams({ manifestKey })}`;
    expect((await f.app.request(endpoint)).status).toBe(401);
    expect((await f.app.request(endpoint, { headers: { Cookie: f.cookie }, })).status).toBe(200);
    const renewed = await f.app.request(endpoint, { headers: { Cookie: f.cookie } });
    const { prefix } = await renewed.json() as { prefix: string };
    expect((await f.app.request(new URL("assets/image.png", url).href)).status).toBe(404);
    expect((await f.app.request(`${prefix}guide/assets/image.png`)).status).toBe(200);
    expect((await f.app.request(`${base}/viewer-ticket?manifestKey=another`, { headers: { Cookie: f.cookie } })).status).toBe(404);
    await f.revoke();
    expect((await f.app.request(endpoint, { headers: { Cookie: f.cookie } })).status).toBe(401);
  });

  it("signals a superseded deployment only after full authorization, without extending old tickets", async () => {
    const f = await fixture();
    const { url } = await f.document();
    const endpoint = `${base}/viewer-ticket?${new URLSearchParams({ manifestKey })}`;
    f.state.manifestKey = manifestKey.replace("deploy-a/", "deploy-b/");
    f.objects.mockClear();
    const response = await f.app.request(endpoint, { headers: { Cookie: f.cookie } });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "deployment_superseded" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await f.app.request(new URL("assets/image.png", url).href)).status).toBe(404);
    expect(f.objects).not.toHaveBeenCalled();
    expect((await f.document()).url.pathname).not.toBe(url.pathname);

    const anonymous = await f.app.request(endpoint);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "Authentication required" });
    for (const denied of [endpoint.replace("org-a/projects", "org-b/projects"), endpoint.replace("project-a/docs", "project-b/docs")]) {
      const result = await f.app.request(denied, { headers: { Cookie: f.cookie } });
      expect(result.status).toBe(404);
      expect(await result.json()).toEqual({ error: "Not found" });
    }
    f.state.member = false;
    const nonmember = await f.app.request(endpoint, { headers: { Cookie: f.cookie } });
    expect(nonmember.status).toBe(404);
    expect(await nonmember.json()).toEqual({ error: "Not found" });
    await f.revoke();
    const revoked = await f.app.request(endpoint, { headers: { Cookie: f.cookie } });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "Authentication required" });
  });

  it("keeps tree, canonical deep links, sandbox and parent comment identity", async () => {
    const f = await fixture();
    const shell = await f.app.request(`${base}?doc=guide%2Fnext.html`, { headers: { Cookie: f.cookie } });
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(html).toContain('window.RENDRO_INITIAL_DOC="project-a/guide/next.html"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-downloads"');
    expect(html).toContain('data-viewer="parent"');
    const tree = await f.app.request(`${base}/tree`, { headers: { Cookie: f.cookie } });
    expect(await tree.json()).toEqual({ documents: ["guide/index.html", "guide/next.html"], cursor: null });
  });

  it("installs the shared link bridge with canonical identity and ticket scope", async () => {
    const f = await fixture();
    const { html } = await f.document();
    expect(html).toContain('data-viewer="navigation"');
    const win = new DOMWindow();
    try {
      win.document.write(html);
      const config = JSON.parse(win.document.querySelector('[data-viewer="navigation"]')!.getAttribute("data-config")!);
      expect(config).toEqual({ prefix: `${base}/files/`, ticketBase: `${base}/view/`, documentPath: "guide/index.html", loadedPath: "project-a/guide/index.html" });
    } finally { await win.happyDOM.close(); }
  });
});
