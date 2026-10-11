import { getRequestListener } from "@hono/node-server";
import { build } from "esbuild";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { renderCommentRecoveryLifecycle } from "@/commentor/recovery-session";
import { proxyAuthSignOut } from "@/auth-proxy";
import { createBrowserHarness } from "./helpers/browser";

const harness = createBrowserHarness();
let authenticated = true;
let failSignOut = false;
beforeEach(() => { authenticated = true; failSignOut = false; });
afterAll(() => vi.unstubAllGlobals());
beforeAll(async () => {
  // Production host, lifecycle and HTTP proxy; deterministic transport lets the
  // test deliver late private updates and mutations after the client closes.
  const parent = await build({ entryPoints: ["src/commentor/parent-entry.ts"], bundle: true, write: false, platform: "browser", plugins: [{ name: "transport", setup(build) {
    build.onResolve({ filter: /^convex\/browser$/ }, () => ({ path: "transport", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export class ConvexClient {
        constructor() { window.transport = { subscriptions: 0, closes: 0, writes: 0, updates: 0 }; }
        setAuth(token) { token(); }
        onUpdate(query, args, update) {
          window.transport.subscriptions++;
          window.lateUpdate = () => { window.transport.updates++; update('deploy-2'); };
          return () => { window.transport.subscriptions--; window.lateUpdate = () => {}; };
        }
        onPaginatedUpdate_experimental(query, args, options, update) {
          window.transport.subscriptions++;
          queueMicrotask(() => update({ results: [], status: 'Exhausted', loadMore() {} }));
          return () => { window.transport.subscriptions--; };
        }
        mutation() { window.transport.writes++; return Promise.resolve('reply'); }
        close() { window.transport.closes++; return Promise.resolve(); }
      }`, loader: "js" }));
  } }] });
  const assets = new Map([["/commentor-parent.js", parent.outputFiles[0].text]]);
  vi.stubGlobal("fetch", vi.fn(() => {
    if (failSignOut) return Promise.resolve(new Response(null, { status: 503 }));
    authenticated = false;
    return Promise.resolve(Response.json({ success: true }));
  }));
  const app = new Hono();
  app.get("/api/auth/get-session", c => c.json(authenticated ? { user: { id: "reader" } } : null));
  app.get("/api/auth/convex/token", c => c.json({ token: "fixture" }));
  app.on(["GET", "POST"], "/api/auth/sign-out", c => proxyAuthSignOut(c.req.raw));
  app.get("/sign-in", c => c.html('<form method="post" action="/sign-in"><button>Sign in as reader</button></form>'));
  app.post("/sign-in", c => { authenticated = true; return c.redirect("/viewer"); });
  app.get("/organizations/org/projects/project/docs/files/guide.html", c => c.html(`<h1>Private document</h1><script>
    addEventListener('message', event => {
      if (event.data.type === 'commentor-parent-response' && event.data.requestId === 'write') document.body.dataset.writeResult = String(event.data.ok);
      if (event.data.type === 'commentor-parent-ready' && event.data.userId) parent.postMessage({type:'commentor-parent-request',requestId:'subscribe',method:'subscribe',args:{documentPath:'guide.html'}}, '*');
    });
    window.lateWrite = () => parent.postMessage({type:'commentor-parent-request',requestId:'write',method:'reply.add',args:{documentPath:'guide.html',threadId:'thread',body:'Late'}}, '*');
  </script>`));
  app.get("/viewer", c => c.html(`<!doctype html><html><body>
    <form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form>
    <iframe id="content-frame" src="/organizations/org/projects/project/docs/files/guide.html"></iframe>
    <script>window.RENDRO_SHARE_CONFIG={organizationId:'org',projectId:'project',convexUrl:'https://convex.invalid'};</script>
    ${renderCommentRecoveryLifecycle("reader")}<script src="/commentor-parent.js"></script></body></html>`));
  const listener = getRequestListener(app.fetch);
  await harness.start((req, res) => { void listener(req, res); }, assets);
});

type Transport = { subscriptions: number; closes: number; writes: number; updates: number };
it.each(["broadcast", "storage", "native-form"])("tears down a background viewer within 2 seconds via %s and signs back in without a loop", async mode => {
  const tabA = await harness.newPage();
  const context = tabA.context();
  if (mode === "storage") await context.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { value: undefined }); });
  const tabB = await context.newPage();
  // Native form navigation in A must still broadcast from the success page.
  if (mode === "native-form") await tabA.route("**/viewer", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "") });
  });
  await tabA.goto(`${harness.origin}/viewer`);
  await tabB.goto(`${harness.origin}/viewer`);
  const transport = () => tabB.evaluate(() => (window as unknown as { transport: Transport }).transport);
  await expect.poll(async () => (await transport()).subscriptions).toBe(2);
  await tabB.evaluate(() => sessionStorage.setItem('commentor-operations:["reader","draft"]', "local draft"));
  await tabA.bringToFront();
  const before = await transport();
  const url = tabB.url();
  const started = Date.now();
  await tabA.getByRole("button", { name: "Sign out", exact: true }).click();
  await tabB.locator("#rendro-signed-out").waitFor({ timeout: 2_000 });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await transport()).toMatchObject({ subscriptions: 0, closes: 1 });
  await tabB.evaluate(() => (window as unknown as { lateUpdate: () => void }).lateUpdate());
  await tabB.frameLocator("iframe").locator("body").evaluate(() => (window as unknown as { lateWrite: () => void }).lateWrite());
  await expect.poll(() => tabB.frameLocator("iframe").locator("body").getAttribute("data-write-result")).toBe("false");
  expect(await transport()).toMatchObject({ writes: before.writes, updates: before.updates });
  expect(await tabB.evaluate(() => sessionStorage.getItem('commentor-operations:["reader","draft"]'))).toBe("local draft");
  expect(tabB.url()).toBe(url);
  await tabB.getByRole("link", { name: "Sign in", exact: true }).click();
  await tabB.getByRole("button", { name: "Sign in as reader" }).click();
  await expect.poll(async () => (await transport()).subscriptions).toBe(2);
  expect(await tabB.locator("#rendro-signed-out").count()).toBe(0);
  expect(tabB.url()).toBe(url);
});

it("keeps the session and subscriptions on failure, then allows retry", async () => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/viewer`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { transport: Transport }).transport?.subscriptions)).toBe(2);
  failSignOut = true;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alert").waitFor();
  expect(authenticated).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 2, closes: 0 });
  failSignOut = false;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator("#rendro-signed-out").waitFor();
  expect(authenticated).toBe(false);
});
