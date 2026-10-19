import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { repoReadWorker, workerConfigWithRepoRead } from "../e2e/repo-read-config";
import { refKey } from "../src/ingest/orchestrator/keys";
import { FakeGitHub } from "./helpers/fake-github";

/**
 * First-view ingest on real workerd (#242): the serving Worker with a
 * cross-script Durable Object binding to the ingest Worker's per-repo
 * coordinator, both sharing the test R2 bucket; the preparing page while a
 * GitHub gate holds the build past the 5 s window, then the docs once the
 * pointer lands.
 */

interface R2Like { get(key: string): Promise<{ text(): Promise<string> } | null> }
interface ProductEnv { REPO_CONTENT: R2Like }
interface AccessEnv { GRANTS: { put(key: string, value: string): Promise<void> } }

const root = fileURLToPath(new URL("..", import.meta.url));
const convexSite = "http://convex.test:3211";
const sessions: Record<string, string> = { "reader-token.sig": "user-reader" };
const originalFetch = globalThis.fetch;
let server: ReturnType<typeof createTestHarness>;
let origin: string;
let directory: string;
let env: ProductEnv;
const github = new FakeGitHub();
const freshDocs = {
  "README.md": "# Project\n",
  "docs/index.md": "# Fresh home\n\nSee [start](guide/start.md).\n",
  "docs/guide/start.md": "# Start here\n",
};

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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rendro-first-view-"));
  // Wrangler's harness hands every outbound Worker fetch to globalThis.fetch:
  // the session lookup, the ingest Worker's GitHub calls and nothing else.
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === github.origin || url.origin === github.archiveOrigin) return github.fetch(input, init);
    if (request.url.startsWith(`${convexSite}/api/auth/get-session`)) return Promise.resolve(sessionResponse(request));
    return Promise.reject(new Error(`Blocked outbound fetch to ${url.origin}`));
  };
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  // The ingest Worker is mounted beside the serving Worker so the test holds
  // both; its entry is relocated like the product one and its content cache
  // points at the shared test bucket.
  const ingestConfigPath = join(directory, "wrangler.ingest.toml");
  await writeFile(ingestConfigPath, (await readFile(join(root, "wrangler.ingest.toml"), "utf8"))
    .replace('main = "src/ingest/orchestrator/entry.ts"', `main = ${JSON.stringify(join(root, "src/ingest/orchestrator/entry.ts"))}`)
    .replace('bucket_name = "rendro-ingest-dev"', 'bucket_name = "rendro-repo-content-test"'));
  const productConfigPath = join(directory, "wrangler.product.toml");
  await writeFile(productConfigPath, `${await workerConfigWithRepoRead(root, repoReadWorker.access)}
[[durable_objects.bindings]]
name = "REPO_INGEST"
class_name = "RepoIngestCoordinator"
script_name = "rendro-ingest-dev"
`);
  const vars = {
    NODE_ENV: "production", LOG_LEVEL: "error", CONVEX_URL: "http://convex.test:3210", CONVEX_SITE_URL: convexSite,
    CONVEX_INTERNAL_SECRET: "workerd-convex-internal-secret-0123456789", AUTH_SECRET: "workerd-auth-secret-0123456789",
    REPO_CAPABILITY_SECRET: "workerd-repo-capability-secret-0123456789", IMAGE_PROXY_SECRET: "workerd-image-proxy-secret-0123456789",
    REPO_CONTENT_KEY: process.env.REPO_CONTENT_KEY as string,
  };
  server = createTestHarness({
    root,
    workers: [
      { configPath: productConfigPath, vars, secrets: vars },
      { configPath: repoReadWorker.accessConfig },
      {
        configPath: ingestConfigPath,
        vars: { GITHUB_API_ORIGIN: github.origin, GITHUB_ARCHIVE_ORIGINS: github.archiveOrigin },
        secrets: { GITHUB_DEV_TOKEN: github.token, IMAGE_PROXY_SECRET: process.env.IMAGE_PROXY_SECRET as string, REPO_CONTENT_KEY: process.env.REPO_CONTENT_KEY as string },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  env = await server.getWorker<ProductEnv>().getEnv();
  const access = await server.getWorker<AccessEnv>(repoReadWorker.access).getEnv();
  await access.GRANTS.put("grants", JSON.stringify({ repos: [
    { id: 703, owner: "octo", name: "new-docs", private: false, defaultBranch: "main", readers: [] },
  ] }));
}, 180_000);

afterAll(async () => {
  await server?.close();
  globalThis.fetch = originalFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("first-view ingest on workerd", () => {
  it("renders the preparing page while the coordinator builds, then serves the docs", async () => {
    const fresh = github.repo("octo", "new-docs", { id: 703 });
    const commit = fresh.commit(freshDocs);
    // Hold the import at GitHub so the reader's window expires.
    github.gate = new Promise<void>(() => {});
    github.gateFilter = endpoint => endpoint === "tarball" || endpoint === "ref";
    github.resetLog();
    const first = await get("/r/octo/new-docs");;
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Rendro-Readiness")).toBe("preparing");
    expect(first.headers.get("Retry-After")).toBe("5");
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await first.text();
    expect(html).toContain('data-readiness="preparing"');
    expect(html).toContain("Preparing the docs for this repository");
    expect((await get("/r/octo/docs-that-never-were")).status).toBe(404);
    // The gate lifts: the build finishes and the pointer lands in the shared bucket.
    github.gate = null;
    const deadline = Date.now() + 90_000;
    while ((await env.REPO_CONTENT.get(refKey(703, "main"))) === null) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for the first-view pointer");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const second = await get("/r/octo/new-docs");;
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Rendro-Readiness")).toBeNull();
    expect(await second.text()).toContain('window.RENDRO_INITIAL_DOC="new-docs/docs/index.md"');
    const frame = await get(`/r/octo/new-docs/@${commit}/files/docs/index.md`);
    expect(await frame.text()).toContain("<h1 id=\"user-content-fresh-home\">Fresh home</h1>");
  }, 120_000);
});
