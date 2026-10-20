import { writeAdmission } from "../src/middleware/write-admission";
import type { User } from "better-auth/types";
import { renderApiKeyPage } from "@/routes/api-key-pages";
import { renderProjectPage } from "@/routes/project-pages";
import { getRequestListener } from "@hono/node-server";
import { buildBrowserBundle as build } from "./helpers/browser";
import { Hono } from "hono";
import type { Page } from "playwright";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { renderCommentRecoveryLifecycle } from "@/commentor/recovery-session";
import { proxyAuthSignOut } from "@/auth-proxy";
import { createBrowserHarness } from "./helpers/browser";
import { serveFonts } from "./helpers/fonts";

const harness = createBrowserHarness();
let authenticated = true;
let failSignOut = false;
// What the live identity check receives; "signed-out" follows the sign-out state.
let tokenMode: "ok" | "denied" | "unavailable" | "empty" = "ok";
let identity: "reader" | "other" | "signed-out" | "unavailable" | "malformed" = "reader";
const rawKey = "rd_fixture_secret_must_disappear";
const reader = { id: "reader", name: "Reader", email: "reader@example.test" } as User;
beforeEach(() => { authenticated = true; failSignOut = false; identity = "reader"; tokenMode = "ok"; });
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeAll(async () => {
  // Production host, lifecycle and HTTP proxy; deterministic transport lets the
  // test deliver late private updates and mutations after the client closes.
  const parent = await build({ entryPoints: ["src/commentor/parent-entry.ts"], bundle: true, write: false, platform: "browser", plugins: [{ name: "transport", setup(build) {
    build.onResolve({ filter: /^convex\/browser$/ }, () => ({ path: "transport", namespace: "fixture" }));
    build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
      export class ConvexClient {
        constructor() { window.transport = { subscriptions: 0, closes: 0, writes: 0, updates: 0 }; }
        setAuth(token) {
          window.refreshAuth = token; token();
          // Convex's own loop: refetch with forceRefreshToken shortly before a fifteen minute token expires,
          // and schedule the next refetch only once the previous one has settled.
          window.settledRefreshes = 0;
          window.keepTokenFresh = () => { const next = () => setTimeout(async () => { await token({ forceRefreshToken: true }); window.settledRefreshes++; next(); }, 890_000); next(); };
        }
        onPaginatedUpdate_experimental(query, args, options, update) {
          window.transport.subscriptions++;
          queueMicrotask(() => update({ results: [], status: 'Exhausted', loadMore() {} }));
          window.lateUpdate = () => { window.transport.updates++; update({ results: [], status: 'Exhausted', loadMore() {} }); };
          return () => { window.transport.subscriptions--; window.lateUpdate = () => {}; };
        }
        mutation() { window.transport.writes++; return Promise.resolve('reply'); }
        close() { window.transport.closes++; return Promise.resolve(); }
      }`, loader: "js", resolveDir: process.cwd() }));
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
  app.get("/fonts/*", serveFonts);
  app.use("*", writeAdmission);
  app.get("/api/auth/get-session", c => {
    if (identity === "unavailable") return c.json({}, 500);
    if (identity === "malformed") return c.body("not json", 200);
    if (identity === "other") return c.json({ user: { id: "other" } });
    return c.json(authenticated && identity === "reader" ? { user: { id: "reader" } } : null);
  });
  app.get("/api/auth/convex/token", c => {
    if (tokenMode === "denied") return c.json({}, 403);
    if (tokenMode === "unavailable") return c.json({}, 503);
    return c.json(tokenMode === "empty" ? {} : { token: "fixture" });
  });
  app.on(["GET", "POST"], "/api/auth/sign-out", c => proxyAuthSignOut(c.req.raw));
  app.get("/sign-in", c => c.html('<form method="post" action="/sign-in"><button>Sign in as reader</button></form>'));
  app.post("/sign-in", c => { authenticated = true; return c.redirect("/viewer"); });
  app.post("/r/acme/docs/comment-access", c => c.json({ expiresAt: Date.now() + 300_000 }));
  app.get("/r/acme/docs/files/guide.md", c => c.html(`<h1>Private document</h1><script>
    addEventListener('message', event => {
      if (event.data.type === 'commentor-parent-response' && event.data.requestId === 'write') document.body.dataset.writeResult = String(event.data.ok);
      if (event.data.type === 'commentor-parent-ready' && event.data.userId) parent.postMessage({type:'commentor-parent-request',requestId:'subscribe',method:'subscribe',args:{documentPath:'guide.md'}}, '*');
    });
    window.lateWrite = () => parent.postMessage({type:'commentor-parent-request',requestId:'write',method:'reply.add',args:{documentPath:'guide.md',threadId:'thread',body:'Late'}}, '*');
  </script>`));
  app.get("/organizations/org/api-keys", c => c.html(renderApiKeyPage(reader, "org")));
  app.get("/organizations/org/projects", c => c.html(renderProjectPage(reader, "org")));
  app.get("/api/rendro/management/access", c => c.json({ id: "org", name: "Fixture", userId: "reader", member: { userId: "reader", role: "owner" } }));
  app.get("/api/auth/organization/list", c => c.json([{ id: "org", name: "Private organization", slug: "private" }]));
  app.get("/api/rendro/credentials", c => c.json({ credentials: [] }));
  app.post("/api/rendro/credentials", c => c.json({ rawKey }));
  app.get("/api/rendro/projects", c => c.json({ projects: [] }));
  app.get("/api/rendro/projects/get", c => c.json({ project: { name: "Project" } }));
  // The frame shows the document this shell names (#296).
  app.get("/viewer", c => c.html(`<!doctype html><html><body>
    <form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form>
    <iframe id="content-frame" data-navigation="1" data-document="1" src="/r/acme/docs/files/guide.md"></iframe>
    <script>window.RENDRO_REPO_COMMENT_CONFIG={repoId:1,accessUrl:'/r/acme/docs/comment-access',convexUrl:'https://convex.invalid'};</script>
    ${renderCommentRecoveryLifecycle(c.req.query("as") ?? "reader")}<script src="/commentor-parent.js"></script></body></html>`));
  const listener = getRequestListener(app.fetch);
  await harness.start((req, res) => { void listener(req, res); }, assets);
  vi.stubEnv("SITE_URL", harness.origin);
});

/** Serve documents without any script, as a browser with JavaScript disabled receives them. */
async function withoutScripts(page: Page) {
  await page.route(url => url.origin === harness.origin, async route => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch({ maxRedirects: 0 });
    return route.fulfill({ response, body: (await response.text()).replace(/<script\b[\s\S]*?<\/script>/g, "") });
  });
}

type Transport = { subscriptions: number; closes: number; writes: number; updates: number };
it("refetches HTML for a cached v19 controller and clears state on sign-out", async () => {
  const page = await harness.newPage();
  // Pin the pre-#75 version and its incompatible organization-context contract.
  // Using the current version here would hide the missing-bump regression.
  const staleBundle = await build({ stdin: { sourcefile: "tests/fixtures/stale-management.js", contents: `
    window.RendroManagementPages={version:"19",pages:{projects:{
      state:'{}',dialogs:'',title:'Stale projects',mount:function(){
        window.staleControllerMounted=true;
        window.RendroUI.organizationContext={display:function(){return {name:"Stale organization"};}};
      }
    }}};
  ` } });
  await page.route("**/management-pages.js?*", route => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: staleBundle.outputFiles[0].text }));
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
  await expect.poll(async () => (await transport()).subscriptions).toBe(1);
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
  await expect.poll(async () => (await transport()).subscriptions).toBe(1);
  expect(await tabB.locator("#rendro-signed-out").count()).toBe(0);
  expect(tabB.url()).toBe(url);
});

it("keeps the session and subscriptions on failure, then allows retry", async () => {
  const page = await harness.newPage();
  await page.goto(`${harness.origin}/viewer`);
  await expect.poll(() => page.evaluate(() => (window as unknown as { transport: Transport }).transport?.subscriptions)).toBe(1);
  failSignOut = true;
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alert").waitFor();
  expect(authenticated).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 1, closes: 0 });
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

it("never reveals a key whose creation response arrives after the account signed out elsewhere", async () => {
  const tabA = await harness.newPage();
  const tabB = await tabA.context().newPage();
  await tabA.goto(`${harness.origin}/viewer`);
  await tabB.goto(`${harness.origin}/organizations/org/api-keys`);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false, delivered!: () => void;
  const answered = new Promise<void>(resolve => { delivered = resolve; });
  await tabB.route(url => url.pathname === "/api/rendro/credentials", async route => {
    if (route.request().method() !== "POST") return route.continue();
    held = true;
    await gate;
    await route.continue();
    delivered();
  });
  await tabB.locator("#api-key-create").click();
  await tabB.locator('#key-form [name="name"]').fill("Late key");
  await tabB.locator('#key-form button[type="submit"]').click();
  await expect.poll(() => held).toBe(true);

  await tabA.bringToFront();
  await tabA.getByRole("button", { name: "Sign out", exact: true }).click();
  await tabB.locator("#rendro-signed-out").waitFor();
  release(); await answered;
  // Let the page process the response that is now delivered to the disposed form.
  await tabB.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  expect(await tabB.locator("dialog[open]").count()).toBe(0);
  expect(await tabB.locator("#raw-key").textContent()).toBe("");
  expect(await tabB.locator("body").textContent()).not.toContain(rawKey);
  expect(await tabB.locator("#copy-key").evaluate((button: HTMLButtonElement) => button.onclick)).toBeNull();
});

it("closes the key-creation dialog and its top-layer select popover on cross-tab sign-out", async () => {
  const tabA = await harness.newPage();
  const tabB = await tabA.context().newPage();
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

it("shows the sign-out confirmation for GET without revoking, then signs out natively and permits signing back in", async () => {
  const page = await harness.newPage();
  await withoutScripts(page);
  await page.context().addCookies([{ name: "better-auth.session_token", value: "opaque-session", url: harness.origin }]);
  const response = await page.goto(`${harness.origin}/api/auth/sign-out`);
  expect(response!.status()).toBe(200);
  expect(response!.headers()).toMatchObject({ allow: "POST", "cache-control": "no-store" });
  expect(await page.getByRole("heading", { name: "Sign out of Rendro?" }).isVisible()).toBe(true);
  expect(await page.getByText("end your session in all open Rendro tabs").isVisible()).toBe(true);
  // Following or prefetching the URL must not revoke anything.
  expect(authenticated).toBe(true);
  expect((await page.context().cookies()).map(cookie => cookie.name)).toEqual(["better-auth.session_token"]);
  const posted = page.waitForResponse(candidate => candidate.request().method() === "POST" && new URL(candidate.url()).pathname === "/api/auth/sign-out");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const confirmation = await posted;
  // Same-origin native POST, no script involved.
  expect(confirmation.request().headers().origin).toBe(harness.origin);
  expect(confirmation.status()).toBe(200);
  await page.getByRole("heading", { name: "You're signed out" }).waitFor();
  expect(authenticated).toBe(false);
  expect(await page.context().cookies()).toEqual([]);
  // The complete page is self-sufficient: it offers Sign in and that works.
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/sign-in");
  await page.getByRole("button", { name: "Sign in as reader" }).click();
  await page.waitForURL("**/viewer");
  expect(authenticated).toBe(true);
});

it("answers a failed native sign-out with Try again, keeping the session and cookies until a retry succeeds", async () => {
  const page = await harness.newPage();
  await withoutScripts(page);
  await page.context().addCookies([{ name: "better-auth.session_token", value: "opaque-session", url: harness.origin }]);
  await page.goto(`${harness.origin}/api/auth/sign-out`);
  failSignOut = true;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("heading", { name: "Sign-out wasn't completed" }).waitFor();
  expect(await page.getByText("We couldn't confirm that your session ended. Please try again.").isVisible()).toBe(true);
  expect(authenticated).toBe(true);
  expect((await page.context().cookies()).map(cookie => cookie.name)).toEqual(["better-auth.session_token"]);
  failSignOut = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await page.getByRole("heading", { name: "You're signed out" }).waitFor();
  expect(authenticated).toBe(false);
  expect(await page.context().cookies()).toEqual([]);
});

const draftKey = 'commentor-operations:["reader","draft"]';
const overlay = (page: Page) => page.locator("#rendro-signed-out");
const restore = (page: Page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
async function openViewerWithDraft(page: Page) {
  await page.goto(`${harness.origin}/viewer`);
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).subscriptions).toBe(1);
  await page.evaluate(key => sessionStorage.setItem(key, "local draft"), draftKey);
}

it.each(["a different account", "no session"] as const)("hides a restored page and keeps its drafts in the original namespace when the live identity is %s", async change => {
  const page = await harness.newPage();
  await openViewerWithDraft(page);
  identity = change === "no session" ? "signed-out" : "other";
  await restore(page);
  await overlay(page).waitFor();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("rendro-signed-out");
  expect(await page.locator("#content-frame").isVisible()).toBe(false);
  expect(await page.evaluate(() => [...document.body.children].filter(child => child.id !== "rendro-signed-out").every(child => (child as HTMLElement).inert))).toBe(true);
  // Old data is no longer served, but stays bound to the account that wrote it.
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 0, closes: 1 });
  expect(await page.evaluate(key => sessionStorage.getItem(key), draftKey)).toBe("local draft");
  expect(await page.evaluate(() => sessionStorage.getItem("commentor-recovery-user"))).toBe("reader");
  if (change === "a different account") {
    // The other account loading in this tab removes the first account's drafts instead of hydrating them.
    await page.goto(`${harness.origin}/viewer?as=other`);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).subscriptions).toBe(1);
    expect(await page.evaluate(() => ({ drafts: Object.keys(sessionStorage).filter(key => key.startsWith("commentor-operations:")), owner: sessionStorage.getItem("commentor-recovery-user") })))
      .toEqual({ drafts: [], owner: "other" });
  }
});

it("does not mistake a failed identity check on restore for a sign-out, and still signs out once the session is gone", async () => {
  const page = await harness.newPage();
  await openViewerWithDraft(page);
  const checked = () => page.waitForEvent("requestfinished", { predicate: request => request.url().includes("/api/auth/get-session") });
  for (const failure of ["unavailable", "malformed", "offline"] as const) {
    if (failure === "offline") {
      await page.route("**/api/auth/get-session*", route => route.abort("connectionrefused"));
      const failed = page.waitForEvent("requestfailed", { predicate: request => request.url().includes("/api/auth/get-session") });
      await restore(page);
      await failed;
      await page.unroute("**/api/auth/get-session*");
    } else {
      identity = failure;
      const finished = checked();
      await restore(page);
      await finished;
    }
    // Frame-synchronize with the page so any (incorrect) teardown would already have run.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await overlay(page).count(), failure).toBe(0);
    expect(await page.locator("#content-frame").isVisible(), failure).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport), failure).toMatchObject({ subscriptions: 1, closes: 0 });
    expect(await page.evaluate(key => sessionStorage.getItem(key), draftKey)).toBe("local draft");
  }
  // The earlier failures left the checker usable.
  identity = "signed-out";
  await restore(page);
  await overlay(page).waitFor();
});

type Refresh = Window & { refreshAuth(args?: { forceRefreshToken: boolean }): Promise<string | null>; keepTokenFresh(): void; settledRefreshes: number; lateUpdate(): void };
const refresh = (page: Page) => page.evaluate(() => (window as unknown as Refresh).refreshAuth());
const lateUpdate = (page: Page) => page.evaluate(() => (window as unknown as Refresh).lateUpdate());

it("renews the comment token only after confirming the identity, and survives transient and offline failures without ending the session", async () => {
  const page = await harness.newPage();
  // The host's own first renewal (identity check, then token) must finish before the one under test.
  const initialToken = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/convex/token");
  await page.goto(`${harness.origin}/viewer`);
  await initialToken;
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).subscriptions).toBe(1);
  const requested: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/auth/")) requested.push(path); });
  expect(await refresh(page)).toBe("fixture");
  expect(requested).toEqual(["/api/auth/get-session", "/api/auth/convex/token"]);
  tokenMode = "unavailable";
  expect(await refresh(page)).toBeNull();
  await page.context().setOffline(true);
  await expect(refresh(page)).rejects.toThrow();
  await page.context().setOffline(false);
  // Neither failure is an access loss: the viewer keeps serving comments.
  await lateUpdate(page);
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport.updates)).toBe(1);
  expect(await overlay(page).count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 1, closes: 0 });
  tokenMode = "ok";
  expect(await refresh(page)).toBe("fixture");
});

it("ends the comment session when the identity check at token renewal finds the account gone", async () => {
  const page = await harness.newPage();
  // The host's own first renewal (identity check, then token) must finish first: a renewal asked for while it is in
  // flight joins it and returns its token, so the account would not look gone yet.
  const initialToken = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/convex/token");
  await openViewerWithDraft(page);
  await initialToken;
  identity = "signed-out";
  expect(await refresh(page)).toBeNull();
  await overlay(page).waitFor();
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 0, closes: 1 });
  expect(await page.evaluate(key => sessionStorage.getItem(key), draftKey)).toBe("local draft");
  // The next renewal attempt stays inert instead of re-requesting a token.
  const tokenRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/auth/convex/token") tokenRequests.push(request.url()); });
  expect(await refresh(page)).toBeNull();
  expect(tokenRequests).toEqual([]);
});

/** What the browser reports for a tab in the background. */
const setVisibility = (page: Page, state: "visible" | "hidden") => page.evaluate(state => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);

it("holds the comment token refresh of a hidden tab for an hour, renews when it returns, and still ends a session whose account is gone", async () => {
  const page = await harness.newPage();
  const initialToken = page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/convex/token");
  await page.clock.install();
  await page.goto(`${harness.origin}/viewer`);
  await initialToken;
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).subscriptions).toBe(1);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1_000);
  const requested: string[] = [];
  page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/auth/")) requested.push(path); });
  const refreshes = () => requested.filter(path => path === "/api/auth/convex/token").length;
  // The next refresh is only scheduled once the previous one has settled, so move the clock after that.
  const settled = (count: number) => expect.poll(() => page.evaluate(() => (window as unknown as Refresh).settledRefreshes)).toBe(count);
  await page.evaluate(() => (window as unknown as Refresh).keepTokenFresh());

  // A visible tab refreshes shortly before each token expires: an identity check and a token every ~15 minutes.
  await page.clock.fastForward(890_000);
  await expect.poll(refreshes).toBe(1);
  expect(requested).toEqual(["/api/auth/get-session", "/api/auth/convex/token"]);
  await settled(1);

  requested.length = 0;
  await setVisibility(page, "hidden");
  await page.clock.fastForward(60 * 60_000);
  // A marker request queues behind anything the page sent before it, so nothing hides in flight.
  await page.evaluate(() => fetch("/api/auth/marker"));
  expect(requested, "requests during an hour hidden").toEqual(["/api/auth/marker"]);
  // The refresh is held, not dropped: the client still has the session, and the next one is not scheduled yet.
  expect(await page.evaluate(() => (window as unknown as { transport: Transport }).transport)).toMatchObject({ subscriptions: 1, closes: 0 });
  expect(await overlay(page).count()).toBe(0);

  requested.length = 0;
  await setVisibility(page, "visible");
  await expect.poll(refreshes).toBe(1);
  expect(requested).toEqual(["/api/auth/get-session", "/api/auth/convex/token"]);
  await settled(2);
  // Back to its normal rhythm.
  requested.length = 0;
  await page.clock.fastForward(890_000);
  await expect.poll(refreshes).toBe(1);
  await settled(3);

  // The identity check still gates a refresh held while hidden.
  await setVisibility(page, "hidden");
  await page.clock.fastForward(890_000);
  requested.length = 0;
  identity = "signed-out";
  await setVisibility(page, "visible");
  await overlay(page).waitFor();
  expect(requested).toEqual(["/api/auth/get-session"]);
});
