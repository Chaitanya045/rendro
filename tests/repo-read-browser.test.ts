import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RENDERER_VERSION } from "@/ingest/limits";
import { blobKey, manifestKey } from "@/ingest/orchestrator/keys";
import { gitBlobId } from "@/ingest/github/git-objects";
import { r2Store, RepoContent } from "@/ingest/orchestrator/store";
import { imageProxyPath } from "@/image-proxy";
import worker from "@/worker";
import { browserStep, bundleBrowserAsset, createBrowserHarness } from "./helpers/browser";
import { TEST_CONTENT_SEALER } from "./helpers/ingest-fixture";
import { nonceContext } from "@/middleware/html-nonce";
import { READINESS_HEADER, renderPreparingPage } from "@/repo-read/preparing";
import { styleManifest } from "@/routes/style-manifest";
import { viewerScript } from "@/viewer/markup";
import { privateRepo, publicRepo, repoReadFixture, users } from "./helpers/repo-read-fixture";

/*
 * Repository document frames in Chromium (#234), served by the real Worker app over real snapshots. A page holds a
 * signed image-proxy image (#224), an image from the repository, and an external image ingest would never emit. The
 * frame is an opaque sandbox in a same-origin parent, as in the viewer. The proxied and repository images must render
 * (in a private repository the repository image goes through the frame's asset ticket); the external one must be
 * stopped by the frame's policy before any request leaves (the harness fails the test if one does). A link the reader
 * opens in a new tab from a private frame is the cookie-authorized URL, never the ticket's (#293).
 */
const harness = createBrowserHarness();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const EXTERNAL = "https://images.example.com/track.png";
let fixture: Awaited<ReturnType<typeof repoReadFixture>>;
const requests: string[] = [];

async function send(response: ServerResponse, reply: Response) {
  const headers = new Headers(reply.headers);
  const cookies = headers.getSetCookie();
  headers.delete("set-cookie");
  response.writeHead(reply.status, [...Object.entries(Object.fromEntries(headers)).flat(), ...cookies.flatMap(cookie => ["Set-Cookie", cookie])]);
  response.end(Buffer.from(await reply.arrayBuffer()));
}

/** Adds `docs/images.md` with the three images to a repository's served snapshot, sealed as ingest seals a private one (#263). */
async function addImagesPage(repo: typeof publicRepo, commit: string) {
  const content = new RepoContent(r2Store(fixture.bucket), { ...repo, installationId: null }, TEST_CONTENT_SEALER);
  const pixel = await gitBlobId(new Uint8Array(PNG));
  const render = `render/v${RENDERER_VERSION}/markdown/${"a".repeat(40)}/${"b".repeat(32)}`;
  const proxied = await imageProxyPath(process.env.IMAGE_PROXY_SECRET as string, "https://images.example.com/badge.png") as string;
  await content.putBytes(blobKey(repo.id, pixel), new Uint8Array(PNG));
  await content.putJson(`gh/v1/repo/${repo.id}/${render}`, {
    title: "Images", headings: [],
    html: `<p><img id="proxied" src="${proxied}" alt="proxied"> <img id="repository" src="img/pixel.png" alt="repository"> <img id="external" src="${EXTERNAL}" alt="external"></p>`
      // Wide blocks exactly as ingest emits them since #270: keyboard-reachable scroll regions.
      + `<pre tabindex="0" id="wide-code">${"wide code ".repeat(60)}</pre><table tabindex="0" id="wide-table"><tr><td>${"wide table ".repeat(40)}</td></tr></table>`,
  });
  const key = manifestKey(repo.id, commit, RENDERER_VERSION);
  const manifest = await content.getJson<{ files: Record<string, unknown> }>(key) as { files: Record<string, unknown> };
  manifest.files["docs/images.md"] = { sha: "a".repeat(40), size: 1, render, title: "Images" };
  manifest.files["docs/img/pixel.png"] = { sha: pixel, size: PNG.length };
  await content.putJson(key, manifest);
}

beforeAll(async () => {
  // The frame's own navigation bridge and renewal client, built from source.
  const viewer = await bundleBrowserAsset("src/viewer/entry.ts");
  await harness.start((request, response) => {
    const url = new URL(request.url ?? "/", harness.origin);
    requests.push(url.pathname);
    if (url.pathname === "/viewer") {
      response.writeHead(200, { "Content-Type": "text/html" });
      // `?shell=<pinned base>` adds the private shell's ticket renewal, as a private repository's shell carries it.
      const shell = url.searchParams.get("shell");
      response.end(`<!doctype html><iframe id="content-frame" name="content-frame" sandbox="allow-scripts allow-popups" src="${url.searchParams.get("frame") ?? ""}" width="600" height="400"></iframe>`
        + (shell ? viewerScript("parent", { base: shell }) : ""));
      return;
    }
    if (url.pathname === "/preparing-fixture") {
      // The page exactly as the readinessResponse serves it (#270): the theme runtime runs under a nonce.
      const body = nonceContext.run("n0nce-browser", () => renderPreparingPage("preparing", 5));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", [READINESS_HEADER]: "preparing", "Retry-After": "5" });
      response.end(body);
      return;
    }
    if (url.pathname === `/styles/${styleManifest["repo-doc"]}`) {
      // The frame's real stylesheet, so the focus ring of the scroll regions is testable.
      response.writeHead(200, { "Content-Type": "text/css" });
      response.end(readFileSync(new URL(`../public/styles/${styleManifest["repo-doc"]}`, import.meta.url)));
      return;
    }
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []));
    void Promise.resolve(worker.request(url.href, { headers }, fixture.env, fixture.ctx)).then(reply => send(response, reply));
  }, new Map([["/private-viewer.js", viewer]]));
});

beforeEach(async () => {
  requests.length = 0;
  fixture = await repoReadFixture();
  await addImagesPage(publicRepo, fixture.commits.public);
  await addImagesPage(privateRepo, fixture.commits.private);
  // The session backend knows the reader; the image proxy's upstream answers with a PNG. Nothing else is reachable.
  vi.mocked(fetch).mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/auth/get-session")) {
      const now = new Date().toISOString();
      return Promise.resolve(/reader-token/.test(new Headers(init?.headers).get("cookie") ?? "") ? Response.json({
        user: { id: users.reader, email: "reader@example.test", name: "Reader", emailVerified: true, image: null, createdAt: now, updatedAt: now },
        session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      }) : Response.json(null));
    }
    return Promise.resolve(url === "https://images.example.com/badge.png" ? new Response(PNG, { headers: { "Content-Type": "image/png" } }) : new Response(null, { status: 404 }));
  });
});

async function openFrame(path: string, cookie?: string) {
  const page = await harness.newPage();
  if (cookie) await page.context().addCookies([{ name: cookie.split("=")[0], value: cookie.split("=")[1], url: harness.origin }]);
  // Record policy violations in every frame, including the opaque one, before its own scripts run.
  await page.addInitScript(() => {
    const store = window as unknown as { violations: string[] };
    store.violations = [];
    document.addEventListener("securitypolicyviolation", event => store.violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  await browserStep(`open ${path}`, () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(path)}`, { waitUntil: "load" }));
  const frame = () => page.frames().find(candidate => candidate.name() === "content-frame" && candidate.url().includes("/files/docs/images.md"));
  await expect.poll(() => frame()?.evaluate(() => [...document.images].every(image => image.complete)) ?? false).toBe(true);
  const content = frame()!;
  return {
    widths: await content.evaluate(() => Object.fromEntries([...document.images].map(image => [image.id, image.naturalWidth]))),
    sources: await content.evaluate(() => Object.fromEntries([...document.images].map(image => [image.id, image.currentSrc || image.src]))),
    violations: await content.evaluate(() => (window as unknown as { violations: string[] }).violations),
  };
}

describe("repository document frames in Chromium", () => {
  it("render proxied and repository images in a public frame and block an external one", async () => {
    const result = await openFrame(`/r/${publicRepo.owner}/${publicRepo.name}/@${fixture.commits.public}/files/docs/images.md`);
    expect(result.widths).toEqual({ proxied: 1, repository: 1, external: 0 });
    expect(result.violations).toContain(`img-src ${EXTERNAL}`);
    expect(requests.some(path => path.startsWith("/img/"))).toBe(true);
  });

  it("renders the preparing page in the reader's appearance, including dark (#270)", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const page = await harness.newPage({ colorScheme });
      await browserStep(`open the preparing page in ${colorScheme}`, () => page.goto(`${harness.origin}/preparing-fixture`));
      await page.waitForFunction(() => document.querySelector('main[data-readiness="preparing"]') !== null);
      // The shared theme runtime resolved the emulated appearance onto html.dark, which the page's stylesheet follows.
      expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(colorScheme === "dark");
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor))
        .toBe(colorScheme === "dark" ? "rgb(9, 9, 11)" : "rgb(250, 250, 250)");
      expect(await page.evaluate(() => getComputedStyle(document.querySelector("main")!).borderColor))
        .toBe(colorScheme === "dark" ? "rgb(39, 39, 42)" : "rgb(228, 228, 231)");
      await page.close();
    }
  });

  it("render proxied images and ticketed repository images in a private frame and block an external one", async () => {
    const result = await openFrame(`/r/${privateRepo.owner}/${privateRepo.name}/@${fixture.commits.private}/files/docs/images.md`, "better-auth.session_token=reader-token.sig");
    expect(result.widths).toEqual({ proxied: 1, repository: 1, external: 0 });
    // The opaque frame sends no cookies: the repository image loaded through the ticket in its own URL.
    expect(result.sources.repository).toMatch(/\/view\/v1\.[\w-]+\.[\w-]+\/files\/docs\/img\/pixel\.png$/);
    expect(result.sources.proxied).toMatch(/\/img\/[\w-]{43}\/[\w-]+$/);
    expect(result.violations).toContain(`img-src ${EXTERNAL}`);
  });

  it("opens a middle-clicked or ctrl-clicked link of a private frame at its cookie-authorized URL, with no ticket in it", async () => {
    const page = await harness.newPage();
    await page.context().addCookies([{ name: "better-auth.session_token", value: "reader-token.sig", url: harness.origin }]);
    const pinned = `/r/${privateRepo.owner}/${privateRepo.name}/@${fixture.commits.private}`;
    await browserStep("open the private frame", () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(`${pinned}/files/docs/index.md`)}`, { waitUntil: "load" }));
    const frame = page.frames().find(candidate => candidate.name() === "content-frame")!;
    // The bridge is running: a plain click would go to the shell, a modified one is left to the browser.
    await expect.poll(() => frame.evaluate(() => document.querySelector('script[data-viewer="navigation"]') !== null)).toBe(true);
    const link = frame.locator("a", { hasText: "guide" });
    const expected = `${harness.origin}${pinned}/files/docs/guide/start.md`;
    // What "Copy link address" copies.
    expect(await link.evaluate(anchor => (anchor as HTMLAnchorElement).href)).toBe(expected);
    const clicks: Array<[string, Parameters<typeof link.click>[0]]> = [["middle", { button: "middle" }], ["ctrl", { modifiers: ["Control"] }]];
    for (const [name, options] of clicks) {
      const opened = page.context().waitForEvent("page");
      await browserStep(`${name}-click the link`, () => link.click(options));
      const tab = await browserStep(`wait for the ${name}-click tab`, () => opened);
      await browserStep(`load the ${name}-click tab`, () => tab.waitForLoadState("load"));
      expect(tab.url(), name).toBe(expected);
      expect(new URL(tab.url()).pathname, name).not.toContain("/view/");
      // The reader's own cookie opens it.
      await expect.poll(() => tab.locator("h1").textContent(), { message: name }).toBe("Start here");
      await tab.close();
    }
    await page.close();
  });

  it("renews a private frame's image ticket through the shell, with no <base>, and reloads the image under the new ticket", async () => {
    const page = await harness.newPage();
    await page.context().addCookies([{ name: "better-auth.session_token", value: "reader-token.sig", url: harness.origin }]);
    const opened = Date.now();
    await page.clock.setFixedTime(opened);
    const pinned = `/r/${privateRepo.owner}/${privateRepo.name}/@${fixture.commits.private}`;
    // The external image the frame's policy blocks fails as the page loads, and a failed resource renews at once.
    // Wait for that renewal to be answered, so the shell is free and the image settled before the ticket ages.
    const loadRenewal = page.waitForResponse(response => new URL(response.url()).pathname === `${pinned}/viewer-ticket`);
    await browserStep("open the private frame in a shell", () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(`${pinned}/files/docs/images.md`)}&shell=${encodeURIComponent(pinned)}`, { waitUntil: "load" }));
    await browserStep("answer the renewal a blocked image forced at load", async () => (await loadRenewal).finished());
    const frame = page.frames().find(candidate => candidate.name() === "content-frame")!;
    const image = () => frame.evaluate(() => {
      const element = document.getElementById("repository") as HTMLImageElement;
      // `src` is what the renewal sets; `currentSrc` is what loaded, and is briefly empty while a new source loads.
      return { src: element.src, current: element.currentSrc, width: element.naturalWidth, base: document.querySelector("base") !== null };
    });
    await expect.poll(async () => { const now = await image(); return now.current === now.src && now.width === 1; }).toBe(true);
    const first = await image();
    expect(first.base).toBe(false);
    expect(first.src).toContain(`${pinned}/view/`);
    try {
      // Halfway through the ticket's five minutes, for the page and the server alike. A request the shell is still
      // busy with drops this one; the next is due 40 s later, past both thirty-second spacings.
      vi.useFakeTimers({ toFake: ["Date"] });
      let swapped = false;
      for (let attempt = 0; attempt < 4 && !swapped; attempt++) {
        const at = opened + 160_000 + attempt * 40_000;
        vi.setSystemTime(at);
        await page.clock.setFixedTime(at);
        await frame.evaluate(() => window.dispatchEvent(new Event("focus")));
        swapped = await expect.poll(async () => (await image()).src, { timeout: 2_000 }).not.toBe(first.src).then(() => true, () => false);
      }
      expect(swapped, "The image never moved to a renewed ticket").toBe(true);
    } finally {
      vi.useRealTimers();
    }
    const renewed = await image();
    expect(renewed.src).toMatch(new RegExp(`${pinned}/view/v1\\.[\\w-]+\\.[\\w-]+/files/docs/img/pixel\\.png$`));
    // The image reloads from the new ticket.
    await expect.poll(async () => { const now = await image(); return now.current === renewed.src && now.width === 1; }).toBe(true);
    expect(requests).toContain(`${pinned}/viewer-ticket`);
    expect(requests).toContain(new URL(renewed.src).pathname);
    await page.close();
  });

  it("keeps the wide pre and table blocks reachable from the keyboard with a visible focus ring (#270)", async () => {
    const page = await harness.newPage();
    await browserStep("open the wide-block frame", () => page.goto(`${harness.origin}/viewer?frame=${encodeURIComponent(`/r/${publicRepo.owner}/${publicRepo.name}/@${fixture.commits.public}/files/docs/images.md`)}`));
    const frame = () => page.frames().find(candidate => candidate.name() === "content-frame" && candidate.url().includes("/files/docs/images.md"));
    await expect.poll(() => frame() !== undefined && frame()!.evaluate(() => document.readyState === "complete").catch(() => false)).toBe(true);
    const content = frame()!;
    // Both scroll regions take focus, and the stylesheet's :focus-visible ring applies (script focus
    // counts when the reader has not used a pointer; the axe scan proves the attribute on real renders).
    const focused = await content.evaluate(() => {
      const reached: Array<[string, string, string]> = [];
      for (const selector of ["pre#wide-code", "table#wide-table"]) {
        const element = document.querySelector<HTMLElement>(selector)!;
        element.focus();
        if (document.activeElement === element) {
          const style = getComputedStyle(element);
          reached.push([selector, style.outlineWidth, style.outlineColor]);
        }
      }
      return reached;
    });
    expect(focused).toEqual([["pre#wide-code", "2px", "rgb(9, 105, 218)"], ["table#wide-table", "2px", "rgb(9, 105, 218)"]]);
    await page.close();
  });
});
