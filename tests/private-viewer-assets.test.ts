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
  const state = { member: true, manifestKey, activeCalls: 0 };
  const backend = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/auth/get-session") {
      return auth.handler(new Request("http://localhost:3000/api/auth/get-session", { headers }));
    }
    if (url.pathname === "/api/rendro/deployments/active") {
      state.activeCalls++;
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

  it("routes relative and canonical document links through the shell and keeps fragment links in place", async () => {
    const f = await fixture();
    const { html } = await f.document();
    const win = new DOMWindow({ url: `http://localhost${base}/files/guide/index.html`, settings: {
      enableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
    } });
    try {
      win.document.write(html);
      const post = vi.spyOn(win, "postMessage");
      const link = win.document.querySelector("a")!;
      link.click();
      expect(post).toHaveBeenCalledWith({ type: "doc-navigate", path: "guide/next.html" }, "*");
      post.mockClear();
      link.href = `${base}/files/guide/next.html`;
      link.click();
      expect(post).toHaveBeenCalledWith({ type: "doc-navigate", path: "guide/next.html" }, "*");
      post.mockClear();
      link.href = "#section";
      link.click();
      expect(post).not.toHaveBeenCalled();
      expect(win.location.pathname).toBe(`${base}/files/guide/index.html`);
      expect(win.location.hash).toBe("#section");
    } finally { await win.happyDOM.close(); }
  });
});
