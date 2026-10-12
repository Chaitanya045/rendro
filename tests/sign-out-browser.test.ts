import type { User } from "better-auth/types";
import { renderApiKeyPage } from "@/routes/api-key-pages";
import { renderSharePage } from "@/routes/share-pages";
import { renderProjectPage } from "@/routes/project-pages";
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
let revokedShares = 0;
const rawKey = "rd_fixture_secret_must_disappear";
const reader = { id: "reader", name: "Reader", email: "reader@example.test" } as User;
beforeEach(() => { authenticated = true; failSignOut = false; revokedShares = 0; });
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
  for (const [path, entry] of [["/management-query.js", "src/management-query/browser.ts"], ["/select.js", "src/ui/select-browser.ts"]]) {
    const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: "browser" });
    assets.set(path, bundle.outputFiles[0].text);
  }
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
  app.get("/organizations/org/api-keys", c => c.html(renderApiKeyPage(reader, "org")));
  app.get("/organizations/org/projects", c => c.html(renderProjectPage(reader, "org")));
  app.get("/organizations/org/projects/project/shares", c => c.html(renderSharePage(reader, "org", "project")));
  app.get("/api/rendro/management/access", c => c.json({ id: "org", name: "Fixture", userId: "reader", member: { userId: "reader", role: "owner" } }));
  app.get("/api/auth/organization/list", c => c.json([{ id: "org", name: "Private organization", slug: "private" }]));
  app.get("/api/rendro/credentials", c => c.json({ credentials: [] }));
  app.post("/api/rendro/credentials", c => c.json({ rawKey }));
  app.get("/api/rendro/projects", c => c.json({ projects: [] }));
  app.get("/api/rendro/projects/get", c => c.json({ project: { name: "Project", activeDeploymentId: "deployment" } }));
  app.get("/api/rendro/shares", c => c.json({ shares: [{ _id: "grant", documentPath: "private.html", deploymentId: "deployment", expiresAt: Date.now() + 86400000 }] }));
  app.post("/api/rendro/shares/revoke", c => { revokedShares++; return c.json({ success: true }); });
  app.get("/viewer", c => c.html(`<!doctype html><html><body>
    <form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form>
    <iframe id="content-frame" src="/organizations/org/projects/project/docs/files/guide.html"></iframe>
    <script>window.RENDRO_SHARE_CONFIG={organizationId:'org',projectId:'project',convexUrl:'https://convex.invalid'};</script>
    ${renderCommentRecoveryLifecycle("reader")}<script src="/commentor-parent.js"></script></body></html>`));
  const listener = getRequestListener(app.fetch);
  await harness.start((req, res) => { void listener(req, res); }, assets);
});

type Transport = { subscriptions: number; closes: number; writes: number; updates: number };
it("refetches HTML for a cached v19 controller and clears state on sign-out", async () => {
  const page = await harness.newPage();
  await page.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
  // Pin the pre-#75 version and its incompatible organization-context contract.
  // Using the current version here would hide the missing-bump regression.
  await page.route("**/management-pages.js?*", route => route.fulfill({ contentType: "text/javascript", body: `
    window.RendroManagementPages={version:"19",pages:{projects:{
      state:'{}',dialogs:'',title:'Stale projects',mount:function(){
        window.staleControllerMounted=true;
        window.RendroUI.organizationContext={display:function(){return {name:"Stale organization"};}};
      }
    }}};
  ` }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${harness.origin}/organizations/org/api-keys`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { RendroManagementPages: { version: string } }).RendroManagementPages?.version)).toBe("19");
  const [refreshedHtml] = await Promise.all([
    page.waitForResponse(response => response.url() === `${harness.origin}/organizations/org/projects` && response.request().resourceType() === "fetch"),
    page.getByRole("link", { name: "Projects", exact: true }).click(),
  ]);
  expect(refreshedHtml.status()).toBe(200);
  await expect.poll(() => page.locator("#project-list").count()).toBe(1);
  type ManagementWindow = {
    staleControllerMounted?: boolean;
    __RENDRO_PAGE_STATE__: unknown;
    RendroUI: {
      request(path: string): Promise<unknown>;
      organizationContext: { display(id: string): unknown };
    };
  };
  await page.evaluate(() => (window as unknown as ManagementWindow).RendroUI.request("/api/auth/organization/list"));
  await expect.poll(() => page.evaluate(() => (window as unknown as ManagementWindow).RendroUI.organizationContext.display("org"))).not.toBeNull();
  expect(await page.evaluate(() => (window as unknown as ManagementWindow).staleControllerMounted)).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as ManagementWindow).__RENDRO_PAGE_STATE__)).not.toBeNull();
  await page.locator('form[action="/api/auth/sign-out"]').evaluate((form: HTMLFormElement) => form.requestSubmit());
  await page.locator("#rendro-signed-out").waitFor();
  expect(await page.evaluate(() => (window as unknown as ManagementWindow).__RENDRO_PAGE_STATE__)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as ManagementWindow).RendroUI.organizationContext.display("org"))).toBeNull();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("rendro-organization-list-")))).toEqual([]);
  expect(errors).toEqual([]);
});

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
  expect(await tabB.locator("iframe").isVisible()).toBe(false);
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

// Exercise the real renderers/controllers: the secret's cleanup owns both its
// DOM text and copy closures. No injected sign-out/dialog implementation.
it.each(["broadcast", "storage", "focus", "own-form"])("scrubs the open API-key reveal and focuses usable sign-in via %s", async mode => {
  const tabA = await harness.newPage();
  const context = tabA.context();
  if (mode === "storage") await context.addInitScript(() => { Object.defineProperty(window, "BroadcastChannel", { value: undefined }); });
  // Separate contexts simulate a missed cross-tab signal; focus must read the server.
  const tabB = mode === "focus" ? await harness.newPage() : await context.newPage();
  await tabB.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
  const errors: string[] = [];
  tabB.on("pageerror", error => errors.push(error.message));
  await tabA.goto(`${harness.origin}/viewer`);
  await tabB.goto(`${harness.origin}/organizations/org/api-keys`);
  await tabB.evaluate(() => (window as unknown as { RendroUI: { request: (path: string) => Promise<unknown> } }).RendroUI.request("/api/auth/organization/list"));
  const cachedOrganizations = () => tabB.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("rendro-organization-list-")));
  await expect.poll(cachedOrganizations).toHaveLength(1);
  await tabB.locator("#api-key-create").click();
  await tabB.locator('#key-form [name="name"]').fill("Fixture key");
  await tabB.locator('#key-form button[type="submit"]').click();
  await tabB.locator("#secret-dialog[open]").waitFor();
  expect(await tabB.locator("#raw-key").textContent()).toBe(rawKey);
  expect(await tabB.locator("#secret-confirmed").isChecked()).toBe(false);

  if (mode === "own-form") {
    await tabB.locator('form[action="/api/auth/sign-out"]').evaluate((form: HTMLFormElement) => form.requestSubmit());
  } else {
    await tabA.bringToFront();
    await tabA.getByRole("button", { name: "Sign out", exact: true }).click();
    await tabA.locator("#rendro-signed-out").waitFor();
    if (mode === "focus") await tabB.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  const overlay = tabB.locator("#rendro-signed-out");
  await overlay.waitFor();
  expect(await tabB.locator("dialog[open]").count()).toBe(0);
  expect(await tabB.locator("#raw-key").textContent()).toBe("");
  await expect.poll(cachedOrganizations).toEqual([]);
  expect(await tabB.locator("body").textContent()).not.toContain(rawKey);
  expect(await tabB.locator("#copy-key").evaluate((button: HTMLButtonElement) => button.onclick)).toBeNull();
  expect(await tabB.locator("#copy-env").evaluate((button: HTMLButtonElement) => button.onclick)).toBeNull();
  expect(await overlay.evaluate(element => document.activeElement === element)).toBe(true);
  expect(await overlay.getAttribute("aria-live")).toBe("polite");
  expect(await overlay.ariaSnapshot()).toContain(`status "You're signed out"`);
  await tabB.keyboard.press("Tab");
  expect(await overlay.getByRole("link", { name: "Sign in", exact: true }).evaluate(element => document.activeElement === element)).toBe(true);
  await tabB.keyboard.press("Enter");
  await tabB.waitForURL("**/sign-in");
  expect(errors).toEqual([]);
});

it("cancels an open private-share revocation confirmation in the other tab", async () => {
  const tabA = await harness.newPage();
  const tabB = await tabA.context().newPage();
  await tabB.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
  await tabA.goto(`${harness.origin}/viewer`);
  await tabB.goto(`${harness.origin}/organizations/org/projects/project/shares`);
  await tabB.getByRole("button", { name: "Revoke", exact: true }).click();
  const dialog = tabB.getByRole("dialog", { name: "Revoke private share?" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("private.html");
  await tabA.bringToFront();
  await tabA.getByRole("button", { name: "Sign out", exact: true }).click();
  const overlay = tabB.locator("#rendro-signed-out");
  await overlay.waitFor();
  expect(await tabB.locator("dialog[open]").count()).toBe(0);
  expect(await overlay.evaluate(element => document.activeElement === element)).toBe(true);
  expect(revokedShares).toBe(0);
  await overlay.getByRole("link", { name: "Sign in", exact: true }).click();
  await tabB.waitForURL("**/sign-in");
});

it("closes the key-creation dialog and its top-layer select popover on cross-tab sign-out", async () => {
  const tabA = await harness.newPage();
  const tabB = await tabA.context().newPage();
  await tabB.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
  await tabA.goto(`${harness.origin}/viewer`);
  await tabB.goto(`${harness.origin}/organizations/org/api-keys`);
  await tabB.locator("#api-key-create").click();
  await tabB.getByRole("combobox", { name: "Expiration", exact: true }).click();
  expect(await tabB.locator(":popover-open").count()).toBe(1);
  await tabA.bringToFront();
  await tabA.getByRole("button", { name: "Sign out", exact: true }).click();
  await tabB.locator("#rendro-signed-out").waitFor();
  expect(await tabB.locator("dialog[open], :popover-open").count()).toBe(0);
  await tabB.getByRole("link", { name: "Sign in", exact: true }).click();
  await tabB.waitForURL("**/sign-in");
});
