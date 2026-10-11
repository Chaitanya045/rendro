import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { Hono } from "hono";
import type { User } from "better-auth/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import projectDocs from "@/routes/project-docs";
import publicDocs from "@/routes/public-v2";
import shareDocs from "@/routes/share-v2";
import * as minio from "@/minio";

const privateBase = "/organizations/org/projects/project/docs";
const manifestKey = "tenants/org/projects/project/deployments/deploy/manifest.json";
const documents = ["guide/page.html", "guide/other.html"];
const requests: string[] = [];
let browser: Browser;
let server: Server;
let origin: string;
let publisherBase = "";

function publisherHtml(path: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">${publisherBase}<title>Fragment fixture</title>
    <style>body{margin:0}nav{position:fixed;top:0;background:white}section{height:900px}h2{margin:0}</style>
    </head><body data-path="${path}"><nav>
    <a href="#details">Bare fragment</a><a href="page.html#details">Explicit same page</a>
    <a href="other.html#section">Other page</a><a href="#日本語">Unicode</a>
    <a href="#caf%C3%A9">Encoded</a><a href="#legacy">Legacy name</a>
    <a href="#">Empty hash</a><a href="#ToP">Top</a><a href="#missing">Missing</a>
    </nav><section><textarea>Comment draft</textarea></section>
    <h2 id="details">Details</h2><section></section><h2 id="section">Section</h2>
    <section></section><h2 id="日本語">Unicode target</h2><section></section>
    <h2 id="café">Encoded target</h2><section></section><a name="legacy">Named target</a><section></section>
    </body></html>`;
}

beforeAll(async () => {
  const bundle = async (path: string) => (await build({ entryPoints: [path], bundle: true, write: false, format: "iife", platform: "browser" })).outputFiles[0].text;
  const viewer = await bundle("src/viewer/entry.ts");
  const tree = await bundle("src/lazy-tree/lazy-tree.ts");
  vi.spyOn(minio, "getObjectText").mockResolvedValue(JSON.stringify({ version: 1,
    files: documents.map(path => ({ path, contentType: "text/html", size: 100 })) }));
  vi.spyOn(minio, "getObjectStream").mockImplementation(key => {
    const path = documents.find(path => key.endsWith(`/files/${path}`));
    return Promise.resolve(path ? new Response(publisherHtml(path)).body : null);
  });
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith("/deployments/active")) return Promise.resolve(Response.json({ project: { name: "Docs" }, deployment: { manifestKey } }));
    if (url.pathname.endsWith("/publications/public")) return Promise.resolve(Response.json({ publication: { slug: "fixture", pathPrefix: "", entryFile: documents[0] }, project: { name: "Docs" }, deployment: { manifestKey } }));
    if (url.pathname.endsWith("/shares/public")) return Promise.resolve(Response.json({ grant: { documentPath: documents[0], expiresAt: Date.now() + 60_000 }, project: { name: "Docs" }, deployment: { manifestKey } }));
    return Promise.resolve(new Response(null, { status: 404 }));
  }));
  const app = new Hono<{ Variables: { user?: User } }>();
  app.get("/private-viewer.js", c => c.body(viewer, 200, { "Content-Type": "text/javascript" }));
  app.get("/lazy-tree.js", c => c.body(tree, 200, { "Content-Type": "text/javascript" }));
  app.use("*", async (c, next) => {
    c.set("user", { id: "test", name: "Test", email: "test@example.test" } as User);
    await next();
  });
  app.route("/", projectDocs);
  app.route("/", publicDocs);
  app.route("/", shareDocs);
  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, origin);
      // Record no ticket capabilities, only canonical document loads.
      if (url.pathname.includes("/view/")) requests.push("ticket-request");
      else requests.push(url.pathname);
      const result = await app.request(url.href, { headers: { Cookie: "better-auth.session_token=fixture.signature" } });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(error => response.destroy(error as Error));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined) });
}, 30_000);

beforeEach(() => { publisherBase = ""; requests.length = 0; });

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(base: string, hash = ""): Promise<{ page: Page; frame: Frame }> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  page.setDefaultNavigationTimeout(3000);
  // No external fonts/services are needed by this isolated route fixture.
  await page.route(url => url.origin !== origin, route => route.request().url().includes("cdn.tailwindcss.com")
    ? route.fulfill({ contentType: "text/javascript", body: "window.tailwind = {};" }) : route.abort());
  await page.goto(origin + base + hash);
  const frame = page.frames().find(frame => frame !== page.mainFrame())!;
  await frame.waitForSelector("#details");
  return { page, frame };
}

async function atTarget(frame: Frame, id: string) {
  await expect.poll(() => frame.evaluate(id => Math.round(document.getElementById(id)?.getBoundingClientRect().top ?? -1), id)).toBe(0);
}

// Uses the actual route injectors, shell, and bundled bridge/tree in Chromium's
// opaque-origin sandbox; DOM mocks cannot detect ticket-base navigations.
describe("viewer fragment navigation in Chromium", () => {
  it.each([privateBase, "/p/fixture", "/s/fixture"])("scrolls without a reload and restores Unicode deep links in %s", async base => {
    const { page, frame } = await open(base);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await frame.locator("textarea").fill("Unsent comment draft");
      const loads = requests.filter(path => path === `${base}/files/${documents[0]}`).length;
      const historyLength = await page.evaluate(() => history.length);
      for (const label of ["Bare fragment", "Explicit same page"]) {
        await frame.getByRole("link", { name: label, exact: true }).click();
        await atTarget(frame, "details");
        await expect.poll(() => new URL(page.url()).hash).toBe("#details");
      }
      expect(await frame.locator("textarea").inputValue()).toBe("Unsent comment draft");
      expect(requests.filter(path => path === `${base}/files/${documents[0]}`).length).toBe(loads);
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
      expect(frame.url()).toBe(`${origin}${base}/files/${documents[0]}`);
      await frame.getByRole("link", { name: "Unicode", exact: true }).click();
      await atTarget(frame, "日本語");
      await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#日本語");
      await page.reload();
      const reloaded = page.frames().find(frame => frame !== page.mainFrame())!;
      await reloaded.waitForSelector("#details");
      await atTarget(reloaded, "日本語");
      await reloaded.getByRole("link", { name: "Encoded", exact: true }).click();
      await atTarget(reloaded, "café");
      await reloaded.getByRole("link", { name: "Legacy name", exact: true }).click();
      await expect.poll(() => reloaded.evaluate(() => Math.round(document.getElementsByName("legacy")[0].getBoundingClientRect().top))).toBe(0);
      const position = await reloaded.evaluate(() => scrollY);
      await reloaded.getByRole("link", { name: "Missing", exact: true }).click();
      expect(await reloaded.evaluate(() => scrollY)).toBe(position);
      for (const label of ["Empty hash", "Top"]) {
        await reloaded.getByRole("link", { name: "Bare fragment", exact: true }).click();
        await atTarget(reloaded, "details");
        await reloaded.getByRole("link", { name: label, exact: true }).click();
        await expect.poll(() => reloaded.evaluate(() => scrollY)).toBe(0);
      }
      expect(requests).not.toContain("ticket-request");
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it.each([privateBase, "/p/fixture"])("preserves cross-page fragments, back/forward and tree navigation in %s", async base => {
    const { page, frame } = await open(base, "#details");
    try {
      await atTarget(frame, "details");
      await frame.getByRole("link", { name: "Other page", exact: true }).click();
      await frame.waitForURL(`${origin}${base}/files/${documents[1]}`);
      await atTarget(frame, "section");
      expect(new URL(page.url()).searchParams.get("doc")).toBe(documents[1]);
      expect(new URL(page.url()).hash).toBe("#section");
      await page.reload();
      let current = page.frames().find(frame => frame !== page.mainFrame())!;
      await current.waitForSelector("#section");
      await atTarget(current, "section");
      await page.evaluate(() => history.back());
      await expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${origin}${base}/files/${documents[0]}`);
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await atTarget(current, "details");
      expect(new URL(page.url()).hash).toBe("#details");
      await page.evaluate(() => history.forward());
      await expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${origin}${base}/files/${documents[1]}`);
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await atTarget(current, "section");
      await page.locator('.tree-item[data-path$="/guide/page.html"] .tree-link').click();
      await expect.poll(() => page.frames().find(frame => frame !== page.mainFrame())?.url()).toBe(`${origin}${base}/files/${documents[0]}`);
      current = page.frames().find(frame => frame !== page.mainFrame())!;
      await expect.poll(() => current.evaluate(() => scrollY)).toBe(0);
      expect(new URL(page.url()).hash).toBe("");
    } finally { await page.close(); }
  }, 15_000);

  it.each(["../", "https://publisher.test/docs/"])("keeps bare fragments local with publisher base %s", async href => {
    publisherBase = `<base href="${href}">`;
    const { page, frame } = await open(privateBase);
    try {
      await frame.getByRole("link", { name: "Bare fragment", exact: true }).click();
      await atTarget(frame, "details");
      await expect.poll(() => new URL(page.url()).hash).toBe("#details");
      expect(frame.url()).toBe(`${origin}${privateBase}/files/${documents[0]}`);
      expect(requests.filter(path => path === `${privateBase}/files/${documents[0]}`)).toHaveLength(1);
      expect(requests).not.toContain("ticket-request");
    } finally { await page.close(); }
  });

  it("rejects forged sources/origins, malformed hashes and stale-document messages", async () => {
    const { page } = await open(privateBase);
    try {
      const url = page.url();
      await page.evaluate(() => {
        const frame = document.getElementById("content-frame") as HTMLIFrameElement;
        const data = { type: "doc-fragment", path: "guide/page.html", fragment: "#details" };
        for (const event of [
          { data, source: window, origin: "null" },
          { data, source: frame.contentWindow, origin: location.origin },
          { data: { ...data, path: "guide/other.html" }, source: frame.contentWindow, origin: "null" },
          ...[null, {}, "x", "#" + "x".repeat(4096)].flatMap(fragment => ["doc-fragment", "doc-navigate"].map(type => ({
            data: { ...data, type, fragment }, source: frame.contentWindow, origin: "null",
          }))),
        ]) window.dispatchEvent(new MessageEvent("message", event));
      });
      expect(page.url()).toBe(url);
    } finally { await page.close(); }
  });
});
