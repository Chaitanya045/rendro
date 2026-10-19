import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { ingestBranch } from "../src/ingest/orchestrator/ingest";
import { r2Store, type R2BucketLike } from "../src/ingest/orchestrator/store";
import { d1SearchIndex, type SearchD1 } from "../src/search/d1";
import { repoReadWorker, workerConfigWithRepoRead } from "../e2e/repo-read-config";
import { ingestFixture } from "./helpers/ingest-fixture";
import { repoFiles } from "./helpers/repo-read-fixture";

/**
 * The repository read path on real workerd (#234): the production Worker with
 * an R2 bucket of snapshots built by the P3b pipeline, a KV namespace of
 * revocation epochs, a service-bound control Worker speaking the access
 * protocol, and workerd's Cache API. It also measures server time.
 */

interface KvLike { put(key: string, value: string): Promise<void> }
interface ProductEnv { REPO_CONTENT: R2BucketLike; REPO_EPOCHS: KvLike; REPO_SEARCH: SearchD1 }
interface AccessEnv { GRANTS: KvLike }

const root = fileURLToPath(new URL("..", import.meta.url));
// tests/setup.ts replaces fetch with a 404 stub; restore that afterwards.
const originalFetch = globalThis.fetch;
const convexSite = "http://convex.test:3211";
const sessions: Record<string, string> = { "reader-token.sig": "user-reader", "outsider-token.sig": "user-outsider" };
let server: ReturnType<typeof createTestHarness>;
let origin: string;
let directory: string;
let env: ProductEnv;
const ingest = ingestFixture();
const publicRepo = ingest.github.repo("octo", "open-docs", { id: 701 });
const privateRepo = ingest.github.repo("octo", "closed-docs", { id: 702, private: true });
// The search measurement fixture (#251): 1,000 docs pages, indexed at ingest into local D1.
const searchRepo = ingest.github.repo("octo", "big-docs", { id: 703 });
let publicCommit: string;
let privateCommit: string;
const pages = 80;
const searchPages = 1_000;
// Each scenario's sample count; the R2-miss scenario reads every page once.
const samples = 200;

function sessionResponse(request: Request): Response {
  const token = /session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  const user = sessions[token];
  if (!user) return Response.json(null);
  const now = new Date().toISOString();
  return Response.json({
    user: { id: user, email: `${user}@example.test`, name: user, emailVerified: true, image: null, createdAt: now, updatedAt: now },
    session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.fetch(new URL(path, origin), { headers, redirect: "manual" }) as unknown as Promise<Response>;
}

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

/** One request straight to workerd's socket (no harness dispatch), timed to the last body byte. */
function timed(path: string, headers: Record<string, string>): Promise<{ status: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = httpRequest(new URL(path, origin), { agent, headers }, response => {
      response.on("data", () => {});
      response.on("end", () => resolve({ status: response.statusCode as number, ms: performance.now() - started }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Median and p90 of sequential requests, in milliseconds. */
async function sample(count: number, path: (index: number) => string, headers: Record<string, string> = {}): Promise<{ p50: number; p90: number }> {
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const { status, ms } = await timed(path(index), headers);
    expect(status).toBe(200);
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(count * 0.5)], p90: times[Math.floor(count * 0.9)] };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rendro-repo-read-"));
  const files = { ...repoFiles() };
  for (let index = 0; index < pages; index += 1) files[`docs/pages/page-${index}.md`] = `# Page ${index}\n\n${"Some text. ".repeat(300)}\n`;
  publicCommit = publicRepo.commit(files);
  privateCommit = privateRepo.commit(repoFiles("Closed home"));
  const bigFiles: Record<string, string> = {};
  for (let index = 0; index < searchPages; index += 1) {
    bigFiles[`docs/pages/page-${index}.md`] =
      `# Page ${index}\n\nThe zebra${index % 10} section explains installation. ${"Prose follows here. ".repeat(40)}\n`;
  }
  searchRepo.commit(bigFiles);
  // Wrangler's harness hands every outbound Worker fetch to globalThis.fetch: only the session lookup leaves the Worker.
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${convexSite}/api/auth/get-session`)) return Promise.resolve(sessionResponse(request));
    return Promise.reject(new Error(`Blocked outbound fetch to ${new URL(request.url).origin}`));
  };
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  const configPath = join(directory, "wrangler.toml");
  await writeFile(configPath, await workerConfigWithRepoRead(root));
  const vars = {
    NODE_ENV: "production", LOG_LEVEL: "error", CONVEX_URL: "http://convex.test:3210", CONVEX_SITE_URL: convexSite,
    CONVEX_INTERNAL_SECRET: "workerd-convex-internal-secret-0123456789", AUTH_SECRET: "workerd-auth-secret-0123456789",
    REPO_CAPABILITY_SECRET: "workerd-repo-capability-secret-0123456789", IMAGE_PROXY_SECRET: "workerd-image-proxy-secret-0123456789",
  };
  server = createTestHarness({ root, workers: [{ configPath, vars, secrets: vars }, { configPath: repoReadWorker.accessConfig }] });
  origin = (await server.listen()).url.origin;
  env = await server.getWorker<ProductEnv>().getEnv();
  // Build both snapshots with the P3b pipeline straight into the Worker's bucket.
  const deps = { ...ingest.deps, store: r2Store(env.REPO_CONTENT) };
  const etags = { get: () => Promise.resolve(null), set: () => Promise.resolve() };
  for (const repo of [publicRepo, privateRepo]) await ingestBranch(deps, etags, repo.ref, "main");
  // The 1,000-page repository is indexed at ingest into the Worker's local D1 (#251).
  const bigDeps = { ...deps, search: d1SearchIndex(env.REPO_SEARCH) };
  await ingestBranch(bigDeps, etags, searchRepo.ref, "main");
  const access = await server.getWorker<AccessEnv>(repoReadWorker.access).getEnv();
  await access.GRANTS.put("grants", JSON.stringify({ repos: [
    { id: 701, owner: "octo", name: "open-docs", private: false, defaultBranch: "main", readers: [] },
    { id: 702, owner: "octo", name: "closed-docs", private: true, defaultBranch: "main", readers: ["user-reader"] },
    { id: 703, owner: "octo", name: "big-docs", private: false, defaultBranch: "main", readers: [] },
  ] }));
}, 240_000);

afterAll(async () => {
  agent.destroy();
  await server?.close();
  globalThis.fetch = originalFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

const reader = "better-auth.session_token=reader-token.sig";

async function capabilityCookie(): Promise<string> {
  const response = await get("/r/octo/closed-docs", { cookie: reader });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  const cookie = response.headers.getSetCookie().find(value => value.startsWith("rendro-repo.702="));
  expect(cookie).toMatch(/; HttpOnly; SameSite=Lax$/);
  return `${reader}; ${(cookie as string).split(";", 1)[0]}`;
}

describe("repository read path on workerd", () => {
  it("serves a public repository's shell, frame, image and tree", async () => {
    const shell = await get("/r/octo/open-docs");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await shell.text()).toContain(`data-frame-base="/r/octo/open-docs/@${publicCommit}"`);
    const frame = await get(`/r/octo/open-docs/@${publicCommit}/files/docs/index.md`);
    expect(frame.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await frame.text()).toContain('<a href="guide/start.md">guide</a>');
    const image = await get(`/r/octo/open-docs/@${publicCommit}/files/docs/img/logo.png`);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect((await image.arrayBuffer()).byteLength).toBe(12);
    const tree = await get(`/r/octo/open-docs/@${publicCommit}/tree?dir=docs%2F`);
    expect(((await tree.json()) as { children: unknown[] }).children).toContainEqual({ name: "guide", type: "folder", title: "Guide" });
  });

  it("grants a private reader through the control Worker, serves images by ticket, and revokes with a KV epoch", async () => {
    expect((await get("/r/octo/closed-docs")).status).toBe(404);
    expect((await get("/r/octo/closed-docs", { cookie: "better-auth.session_token=outsider-token.sig" })).status).toBe(404);
    const cookie = await capabilityCookie();
    const frame = await get(`/r/octo/closed-docs/@${privateCommit}/files/docs/index.md`, { cookie: cookie.split("; ")[1] + "; " + reader });
    const html = await frame.text();
    expect(html).toContain("Closed home");
    const prefix = /<base data-rendro-viewer href="([^"]+\/files\/)/.exec(html)?.[1] as string;
    const image = await get(`${prefix}docs/img/logo.png`);
    expect(image.status).toBe(200);
    await image.arrayBuffer();
    await env.REPO_EPOCHS.put("epoch:user-reader", String(Date.now()));
    expect((await get(`${prefix}docs/img/logo.png`)).status).toBe(404);
    // Still a reader per the source: the cookie is re-minted at the new epoch.
    const renewed = await get("/r/octo/closed-docs", { cookie });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.getSetCookie().some(value => value.startsWith("rendro-repo.702=v1."))).toBe(true);
  });

  it("measures server time for a cached view, an R2 miss and a capability-cookie miss", async () => {
    const cookie = await capabilityCookie();
    const privateFrame = `/r/octo/closed-docs/@${privateCommit}/files/docs/index.md`;
    const publicFrame = `/r/octo/open-docs/@${publicCommit}/files/docs/index.md`;
    // Warm the isolate: pointer, manifests, renders, the imported HMAC key and the socket.
    for (let index = 0; index < 20; index += 1) {
      await timed(privateFrame, { cookie });
      await timed(publicFrame, {});
      await timed("/r/octo/closed-docs", { cookie });
    }
    const results = {
      "/health (Hono stack, no storage)": await sample(samples, () => "/health"),
      "cached private frame (cookie hit)": await sample(samples, () => privateFrame, { cookie }),
      "cached public frame": await sample(samples, () => publicFrame),
      "cached private shell, branch URL": await sample(samples, () => "/r/octo/closed-docs", { cookie }),
      // Each page is new to the isolate and to the colo cache: one R2 read of its rendered object.
      "R2 miss (render object)": await sample(pages, index => `/r/octo/open-docs/@${publicCommit}/files/docs/pages/page-${index}.md`),
      // No capability cookie: session lookup (answered in-process here), KV epoch, control Worker, a new cookie.
      "capability-cookie miss (private frame)": await sample(samples, () => privateFrame, { cookie: reader }),
    };
    console.log(["workerd, loopback HTTP, sequential requests (p50 / p90 ms):",
      ...Object.entries(results).map(([name, { p50, p90 }]) => `  ${name}: ${p50.toFixed(2)} / ${p90.toFixed(2)}`)].join("\n"));
    expect(results["cached private frame (cookie hit)"].p50).toBeGreaterThan(0);
  }, 120_000);

  it("searches the 1,000-page repository through the pinned commit, bounded, and measures the server time", async () => {
    // Results come from this repository's served snapshot only: path and slug resolve onto it.
    const response = await get("/r/octo/big-docs/search?q=zebra&limit=20");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const payload = await response.json() as { status: string; more: boolean; results: Array<{ path: string; slug: string; snippet: string }> };
    expect(payload.status).toBe("ok");
    expect(payload.results).toHaveLength(20);
    expect(payload.results[0].path).toMatch(/^docs\/pages\/page-\d+\.md$/);
    expect(payload.results[0].slug).toMatch(/^user-content-page-\d+$/);
    expect(payload.results[0].snippet).toContain("\u0002zebra");
    // The query is scoped by repository id: another repository (open-docs, ingested without an
    // index pass here) and a blob outside this manifest contribute nothing.
    const other = await get("/r/octo/open-docs/search?q=zebra");
    expect(((await other.json()) as { results: unknown[] }).results).toEqual([]);

    // Server time over sequential requests, cycling the query terms.
    const terms = ["zebra", "installation", "prose", "follows"];
    const results = {
      "search query (1,000-page repo, limit 20)": await sample(samples, index => `/r/octo/big-docs/search?q=${terms[index % terms.length]}&limit=20`),
    };
    console.log(["repository search, workerd loopback HTTP (p50 / p90 ms):",
      ...Object.entries(results).map(([name, { p50, p90 }]) => `  ${name}: ${p50.toFixed(2)} / ${p90.toFixed(2)}`)].join("\n"));
    expect(results["search query (1,000-page repo, limit 20)"].p50).toBeGreaterThan(0);
  }, 120_000);
});
