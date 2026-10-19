import type { ServerResponse } from "node:http";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_VERSION } from "@/ingest/limits";
import { blobKey, manifestKey } from "@/ingest/orchestrator/keys";
import { gitBlobId } from "@/ingest/github/git-objects";
import { imageProxyPath } from "@/image-proxy";
import worker from "@/worker";
import { browserStep, createBrowserHarness } from "./helpers/browser";
import { privateRepo, publicRepo, repoReadFixture, users } from "./helpers/repo-read-fixture";

/*
 * Repository document frames in Chromium (#234), served by the real Worker app over real snapshots. A page holds a
 * signed image-proxy image (#224), an image from the repository, and an external image ingest would never emit. The
 * frame is an opaque sandbox in a same-origin parent, as in the viewer. The proxied and repository images must render
 * (in a private repository the repository image goes through the frame's asset ticket); the external one must be
 * stopped by the frame's policy before any request leaves (the harness fails the test if one does).
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

/** Adds `docs/images.md` with the three images to a repository's served snapshot. */
async function addImagesPage(repoId: number, commit: string) {
  const encoder = new TextEncoder();
  const pixel = await gitBlobId(new Uint8Array(PNG));
  const render = `render/v${RENDERER_VERSION}/markdown/${"a".repeat(40)}/${"b".repeat(32)}`;
  const proxied = await imageProxyPath(process.env.IMAGE_PROXY_SECRET as string, "https://images.example.com/badge.png") as string;
  await fixture.bucket.put(blobKey(repoId, pixel), new Uint8Array(PNG));
  await fixture.bucket.put(`gh/v1/repo/${repoId}/${render}`, encoder.encode(JSON.stringify({
    title: "Images", headings: [],
    html: `<p><img id="proxied" src="${proxied}" alt="proxied"> <img id="repository" src="img/pixel.png" alt="repository"> <img id="external" src="${EXTERNAL}" alt="external"></p>`,
  })));
  const key = manifestKey(repoId, commit, RENDERER_VERSION);
  const manifest = fixture.bucket.json<{ files: Record<string, unknown> }>(key) as { files: Record<string, unknown> };
  manifest.files["docs/images.md"] = { sha: "a".repeat(40), size: 1, render, title: "Images" };
  manifest.files["docs/img/pixel.png"] = { sha: pixel, size: PNG.length };
  await fixture.bucket.put(key, encoder.encode(JSON.stringify(manifest)));
}

beforeAll(async () => {
  await harness.start((request, response) => {
    const url = new URL(request.url ?? "/", harness.origin);
    requests.push(url.pathname);
    if (url.pathname === "/viewer") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<!doctype html><iframe name="content-frame" sandbox="allow-scripts allow-popups" src="${url.searchParams.get("frame") ?? ""}" width="600" height="400"></iframe>`);
      return;
    }
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => typeof value === "string" ? [[name, value] as [string, string]] : []));
    void Promise.resolve(worker.request(url.href, { headers }, fixture.env, fixture.ctx)).then(reply => send(response, reply));
  });
});

beforeEach(async () => {
  requests.length = 0;
  fixture = await repoReadFixture();
  await addImagesPage(publicRepo.id, fixture.commits.public);
  await addImagesPage(privateRepo.id, fixture.commits.private);
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

  it("render proxied images and ticketed repository images in a private frame and block an external one", async () => {
    const result = await openFrame(`/r/${privateRepo.owner}/${privateRepo.name}/@${fixture.commits.private}/files/docs/images.md`, "better-auth.session_token=reader-token.sig");
    expect(result.widths).toEqual({ proxied: 1, repository: 1, external: 0 });
    // The opaque frame sends no cookies: the repository image loaded through the ticket in the frame's base URL.
    expect(result.sources.repository).toMatch(/\/view\/v1\.[\w-]+\.[\w-]+\/files\/docs\/img\/pixel\.png$/);
    expect(result.sources.proxied).toMatch(/\/img\/[\w-]{43}\/[\w-]+$/);
    expect(result.violations).toContain(`img-src ${EXTERNAL}`);
  });
});
