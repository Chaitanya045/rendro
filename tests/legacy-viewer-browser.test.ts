import rateLimiterTest from "./convex-rate-limiter";
import { seedLegacyMember, registerAuth, seedIdentity } from "./helpers/auth-identity";
import { getRequestListener } from "@hono/node-server";
import { readFile } from "node:fs/promises";
import { buildBrowserBundle as build } from "./helpers/browser";
import { getFunctionName, makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "@/worker";
import * as minio from "@/minio";
import * as deletion from "@/soft-delete";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { mockSecurityBackend, testUser } from "./fixtures/security-headers";
import { browserStep, createBrowserHarness } from "./helpers/browser";
const harness = createBrowserHarness();
const modules = import.meta.glob("../convex/**/*.ts");
const backend = convexTest(schema, modules);
rateLimiterTest.register(backend);
registerAuth(backend);
let author: ReturnType<typeof backend.withIdentity>;
const scope = { orgSlug: "example", filePath: "example/guide/index.html" };
const assetsSeen = new Set<string>();
let attackNavigation = false;
const publisher = `<!doctype html><html><head><link rel="stylesheet" href="assets/site.css">
<script>window.publisherProbe={origin:window.origin};
try{window.publisherProbe.cookies=parent.document.cookie}catch(e){window.publisherProbe.cookies="blocked"}
try{window.publisherProbe.dom=parent.document.body.tagName}catch(e){window.publisherProbe.dom="blocked"}</script>
</head><body><h1 id="top">Legacy document</h1><p id="comment-target">Selectable legacy text</p>
<script>document.body.dataset.mode=new URLSearchParams(location.search).get("mode")||""</script>
<img id="image" src="assets/image.svg"><a id="same" href="#bottom">Same document</a>
<a id="next" href="next.html#destination">Next document</a>
<a id="old-link" href="/files/example/guide/next.html#destination">Old absolute link</a>
<div style="height:1500px"></div><h2 id="bottom">Bottom</h2></body></html>`;

beforeAll(async () => {
  process.env.LEGACY_ORGANIZATION_MAP = "{}";
  const identity = await seedIdentity(backend, testUser);
  await seedLegacyMember(backend, identity.subject, "example");
  testUser.id = identity.subject;
  author = backend.withIdentity(identity);
  mockSecurityBackend();
  vi.spyOn(deletion, "isDeleted").mockResolvedValue(false);
  vi.spyOn(minio, "listImmediate").mockResolvedValue({ entries: [], isTruncated: false });
  vi.mocked(minio.headObject).mockImplementation(key => Promise.resolve({ contentType: key.endsWith(".css") ? "text/css" : key.endsWith(".svg") ? "image/svg+xml" : "text/html" }));
  vi.mocked(minio.getObjectStream).mockImplementation(key => {
    assetsSeen.add(key);
    const content = key.endsWith(".css") ? 'body{color:rgb(1,2,3)}' : key.endsWith(".svg")
      ? '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="green"/></svg>'
      : key.endsWith("next.html") ? '<!doctype html><h1 id="destination">Next legacy document</h1>' : publisher;
    return Promise.resolve(new Response(content + (attackNavigation && key.endsWith(".html") ? `<script>for(let i=0;i<100;i++){parent.postMessage({type:"doc-navigate",path:"guide/next.html",search:"?forged="+i},location.origin);parent.postMessage({type:"doc-loaded",path:"guide/next.html"},location.origin);parent.postMessage({type:"shell-toggle"},location.origin)}</script>` : "")).body);
  });
  const assets = new Map<string, string>();
  for (const [path, entry] of [["/private-viewer.js", "src/viewer/entry.ts"], ["/lazy-tree.js", "src/lazy-tree/lazy-tree.ts"], ["/commentor.js", "src/commentor/commentor.ts"]]) {
    const bundle = await browserStep(`bundle ${path}`, () => build({ entryPoints: [entry], bundle: true, write: false, format: "iife", platform: "browser" }));
    assets.set(path, bundle.outputFiles[0].text);
  }
  // Only the Convex network transport is replaced: the real bridge, adapter,
  // widget, routes and v1 backend mutations/queries run end to end.
  const parent = await browserStep("bundle legacy comment transport fixture", () => build({ stdin: { contents: `
    import { CommentorParentHost, ConvexLegacyCommentBackend } from "./src/commentor/parent-host";
    import { getFunctionName } from "convex/server";
    const listeners=new Set();
    async function call(kind,fn,args){const r=await fetch('/__legacy-comments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,name:getFunctionName(fn),args})});if(!r.ok)throw new Error('fixture operation failed');return r.json()}
    const client={onUpdate(fn,args,update,error){let live=true;const refresh=()=>call('query',fn,args).then(v=>{if(live)update(v)},error);listeners.add(refresh);void refresh();return()=>{live=false;listeners.delete(refresh)}},async mutation(fn,args){const result=await call('mutation',fn,args);await Promise.all([...listeners].map(f=>f()));return result}};
    addEventListener('DOMContentLoaded',()=>{
      const host=new CommentorParentHost(document.getElementById('content-frame'),location.origin,window.RENDRO_LEGACY_COMMENT_CONFIG,new ConvexLegacyCommentBackend(client),${JSON.stringify(testUser.id)});host.start();
    });`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, write: false, platform: "browser" }));
  assets.set("/commentor-parent.js", parent.outputFiles[0].text);
  const allowed = new Set([api.threads.list, api.threads.create, api.threads.resolve, api.threads.archive, api.threads.remove, api.replies.add, api.replies.remove].map(getFunctionName));
  const listener = getRequestListener(async request => {
    if (new URL(request.url).pathname === "/__legacy-comments") {
      if (!request.headers.get("cookie")?.includes("better-auth.session_token=test-session")) return new Response(null, { status: 401 });
      const input = await request.json() as { kind: string; name: string; args: Record<string, unknown> };
      if (!allowed.has(input.name)) return new Response(null, { status: 403 });
      const result = input.kind === "query" ? await author.query(makeFunctionReference<"query">(input.name), input.args)
        : await author.mutation(makeFunctionReference<"mutation">(input.name), input.args);
      return Response.json(result ?? null);
    }
    return worker.fetch(request, { ASSETS: { fetch: async (req: Request) => {
      const path = new URL(req.url).pathname;
      if (assets.has(path)) return new Response(assets.get(path), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
      try { return new Response(await readFile(`public${path}`), { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript; charset=utf-8" : "image/svg+xml" } }); }
      catch { return new Response(null, { status: 404 }); }
    } } });
  });
  await harness.start((request, response) => { void listener(request, response).catch(error => response.destroy(error as Error)); });
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function open(path: string) {
  const page = await harness.newPage();
  await page.context().addCookies([{ name: "better-auth.session_token", value: "test-session", url: harness.origin }, { name: "parent-marker", value: "private", url: harness.origin }]);
  await page.route(url => ["cdn.tailwindcss.com", "fonts.googleapis.com"].includes(url.hostname), route => route.fulfill({ contentType: new URL(route.request().url()).hostname === "cdn.tailwindcss.com" ? "text/javascript; charset=utf-8" : "text/css", body: new URL(route.request().url()).hostname === "cdn.tailwindcss.com" ? "window.tailwind={}" : "" }));
  await browserStep("open legacy URL and follow viewer redirect", () => page.goto(harness.origin + path));
  await browserStep("load legacy publisher iframe", () => page.frameLocator("#content-frame").locator("h1").waitFor());
  return page;
}

describe("legacy opaque viewer in Chromium", () => {
  it("returns migration guidance instead of a legacy key page", async () => {
    const page = await open("/docs/example/guide/index.html");
    const result = await browserStep("submit retired namespace creation", () => page.evaluate(async () => {
      const response = await fetch("/api/orgs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org: "example" }) });
      return { status: response.status, body: await response.json() };
    }));
    expect(result.status).toBe(410);
    expect(result.body.error).toContain("rendro@2");
    expect(await page.locator("#content-frame").count()).toBe(1);
    expect(await page.getByText("Your API key", { exact: true }).count()).toBe(0);
  });
  it("ignores forged navigation in the legacy public shell", async () => {
    attackNavigation = true;
    try {
      const page = await open("/p/product");
      await page.waitForTimeout(1200);
      expect(new URL(page.url()).pathname).toBe("/p/product");
      expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
      expect(await page.evaluate(() => history.length)).toBe(2);
      await page.close();
    } finally { attackNavigation = false; }
  });

  it.each(["click", "Enter"])("blocks legacy message floods and accepts a real %s navigation", async input => {
    attackNavigation = true;
    try {
      const page = await open("/files/example/guide/index.html");
      await page.waitForTimeout(600);
      expect(new URL(page.url()).pathname).toBe("/docs/example/guide/index.html");
      expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
      const frame = page.frames().find(candidate => candidate.parentFrame() === page.mainFrame())!;
      if (input === "click") await frame.locator("#next").click();
      else await frame.locator("#next").press("Enter");
      await page.waitForURL("**/docs/example/guide/next.html#destination");
      await page.waitForTimeout(600);
      expect(new URL(page.url()).searchParams.has("docQuery")).toBe(false);
      expect(await page.evaluate(() => history.length)).toBe(3);
      await page.close();
    } finally { attackNavigation = false; }
  });

  it("runs publisher scripts with no parent access, loads assets, and creates/reads a legacy comment through the bridge", async () => {
    const page = await open("/files/example/guide/index.html#bottom");
    expect(new URL(page.url()).pathname).toBe("/docs/example/guide/index.html");
    const frame = page.frames().find(frame => frame !== page.mainFrame())!;
    expect(await frame.evaluate(() => (window as unknown as { publisherProbe: unknown }).publisherProbe)).toEqual({ origin: "null", cookies: "blocked", dom: "blocked" });
    await expect.poll(() => new URL(page.url()).hash).toBe("#bottom");
    await expect.poll(() => frame.locator("#bottom").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight)).toBe(true);
    expect(await frame.evaluate(() => location.hash)).toBe("");
    await browserStep("load ticket stylesheet and image", () => frame.waitForFunction(() => getComputedStyle(document.body).color === "rgb(1, 2, 3)" && (document.getElementById("image") as HTMLImageElement).naturalWidth === 10));
    expect(assetsSeen.has("example/guide/assets/site.css")).toBe(true);
    expect(assetsSeen.has("example/guide/assets/image.svg")).toBe(true);
    const initialBase = await frame.evaluate(() => document.baseURI);
    await page.clock.setFixedTime(Date.now() + 6 * 60_000);
    await frame.evaluate(() => dispatchEvent(new Event("focus")));
    await browserStep("renew legacy assets through the authenticated parent", () => frame.waitForFunction(previous => document.baseURI !== previous, initialBase));
    await expect.poll(() => new URL(page.url()).hash).toBe("#bottom");
    await expect.poll(() => frame.locator("#bottom").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight)).toBe(true);
    expect(await frame.evaluate(() => location.hash)).toBe("");
    // Open the actual comment widget and submit via its parent transport.
    await browserStep("enable legacy comment widget", () => frame.waitForFunction(() => {
      const button = document.querySelector("#commentor-host")?.shadowRoot?.querySelector('[data-testid="commentor-comment-btn"]') as HTMLButtonElement | null;
      return button && !button.disabled;
    }));
    await frame.getByTestId("commentor-comment-btn").click();
    await frame.locator("#comment-target").click();
    await frame.locator("textarea").fill("Legacy bridge comment");
    await frame.getByTestId("commentor-composer-post").click();
    await expect.poll(async () => (await author.query(api.threads.list, scope)).map(thread => thread.body)).toContain("Legacy bridge comment");
    // Persistence precedes the bridge acknowledgement and composer teardown.
    // Reload only after the UI has consumed the acknowledgement and closed.
    await browserStep("finish the comment acknowledgement and close animation", () =>
      frame.getByTestId("commentor-composer").waitFor({ state: "detached" }));
    await page.reload();
    const reloaded = page.frameLocator("#content-frame");
    await reloaded.getByTestId("commentor-panel-btn").click();
    await browserStep("read persisted legacy comment through bridge", () => reloaded.getByText("Legacy bridge comment", { exact: true }).first().waitFor());
    await page.close();
  });
  it.each(["?mode=print", "?mode=print&doc=other.html&docQuery=%3Fmode%3Dwrong&tag=a&tag=b&value=%252F"])(
    "forwards publisher queries without changing shell selection: %s", async search => {
      const page = await open(`/files/example/guide/index.html${search}#bottom`);
      expect(new URL(page.url()).searchParams.get("docQuery")).toBe(search);
      expect(new URL(page.url()).searchParams.has("doc")).toBe(false);
      const frame = page.frames().find(frame => frame !== page.mainFrame())!;
      expect(await frame.evaluate(() => location.search)).toBe(search);
      expect(await frame.locator("body").getAttribute("data-mode")).toBe("print");
      await expect.poll(() => new URL(page.url()).hash).toBe("#bottom");
      await frame.locator("#next").click();
      await browserStep("leave query-dependent document", () => page.waitForURL("**/docs/example/guide/next.html#destination"));
      await page.frameLocator("#content-frame").locator("#destination").waitFor();
      await page.goBack();
      await page.frameLocator("#content-frame").locator("#next").waitFor();
      expect(await frame.evaluate(() => location.search)).toBe(search);
      expect(await frame.locator("body").getAttribute("data-mode")).toBe("print");
      await page.reload();
      await page.frameLocator("#content-frame").locator("#next").waitFor();
      expect(await page.frames().find(frame => frame !== page.mainFrame())!.evaluate(() => location.search)).toBe(search);
      await page.close();
    },
  );
  it("preserves fragment navigation, legacy absolute links, and cross-document links", async () => {
    const page = await open("/docs/example/guide/index.html");
    const frame = page.frames().find(frame => frame !== page.mainFrame())!;
    await frame.locator("#same").click();
    await expect.poll(() => new URL(page.url()).hash).toBe("#bottom");
    await expect.poll(() => frame.locator("#bottom").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight)).toBe(true);
    expect(await frame.evaluate(() => location.hash)).toBe("");
    await frame.locator("#next").click();
    await browserStep("navigate legacy document through parent", () => page.waitForURL("**/docs/example/guide/next.html#destination"));
    await browserStep("render linked document", () => page.frameLocator("#content-frame").locator("#destination").waitFor());
    await expect.poll(() => page.frameLocator("#content-frame").locator("#destination").evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight)).toBe(true);
    expect(await frame.evaluate(() => location.hash)).toBe("");
    await page.goBack();
    await browserStep("restore shell fragment on Back", () => page.waitForURL("**/docs/example/guide/index.html#bottom"));
    await browserStep("finish restoring the legacy document handlers", () => frame.waitForFunction(() =>
      location.pathname.endsWith("/files/guide/index.html") && document.readyState === "complete"));
    await page.frameLocator("#content-frame").locator("#old-link").click();
    await page.getByRole("button", { name: "Open linked document", exact: true }).click();
    await browserStep("resolve old absolute link through parent", () => page.waitForURL("**/docs/example/guide/next.html#destination"));
    await page.goBack();
    await browserStep("retain the restored document before a confirmed link", () => page.waitForURL("**/docs/example/guide/index.html#bottom"));
    await page.close();
  });
});
