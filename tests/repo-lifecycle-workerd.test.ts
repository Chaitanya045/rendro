import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { repoReadWorker, workerConfigWithRepoRead } from "../e2e/repo-read-config";
import { coordinatorName } from "../src/ingest/orchestrator/coordinator-client";
import { refKey } from "../src/ingest/orchestrator/keys";
import { isSealed } from "../src/ingest/orchestrator/sealing";
import { FakeGitHub } from "./helpers/fake-github";

/**
 * Private-repository content over its lifetime on real workerd (#263): the
 * serving Worker, the ingest Worker (idle window shortened to seconds) and the
 * fixture control Worker, sharing one R2 bucket. A first view ingests the
 * repository sealed; nobody views it, so its content expires; the next view
 * ingests it again; a confirmed removal purges it. It also measures sealing
 * and opening per object inside workerd.
 */

interface R2Object { arrayBuffer(): Promise<ArrayBuffer> }
interface R2Like {
  get(key: string): Promise<R2Object | null>;
  list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
}
interface ProductEnv { REPO_CONTENT: R2Like }
interface AccessEnv { GRANTS: { put(key: string, value: string): Promise<void> } }
interface IngestEnv { INGEST_COORDINATOR: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } } }

const root = fileURLToPath(new URL("..", import.meta.url));
const convexSite = "http://convex.test:3211";
const reader = "better-auth.session_token=reader-token.sig";
const originalFetch = globalThis.fetch;
const IDLE_SECONDS = 8;
let server: ReturnType<typeof createTestHarness>;
let origin: string;
let benchOrigin: string;
let directory: string;
let env: ProductEnv;
const github = new FakeGitHub();
const repo = github.repo("octo", "secret-docs", { id: 705, private: true });
const docs = {
  "README.md": "# Project\n",
  "docs/index.md": "# Classified home\n\nSee [plans](plans.md).\n",
  "docs/plans.md": "# Classified plans\n\nNobody outside may read this.\n",
};

function sessionResponse(request: Request): Response {
  const token = /session_token=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1] ?? "";
  if (token !== "reader-token.sig") return Response.json(null);
  const now = new Date().toISOString();
  return Response.json({
    user: { id: "user-reader", email: "reader@example.test", name: "reader", emailVerified: true, image: null, createdAt: now, updatedAt: now },
    session: { expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return server.fetch(new URL(path, origin), { headers, redirect: "manual" }) as unknown as Promise<Response>;
}

async function waitFor<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

/** The repository's objects. A wipe may run meanwhile: an object deleted between the listing and its read is skipped. */
async function stored(): Promise<Array<{ key: string; bytes: Uint8Array }>> {
  const { objects } = await env.REPO_CONTENT.list({ prefix: "gh/v1/repo/705/" });
  const read = await Promise.all(objects.map(async ({ key }) => {
    const object = await env.REPO_CONTENT.get(key);
    return object ? [{ key, bytes: new Uint8Array(await object.arrayBuffer()) }] : [];
  }));
  return read.flat();
}

/** The docs as the reader sees them once they are ready (the first view may answer the preparing page first). */
async function viewDocs(): Promise<string> {
  return waitFor(async () => {
    const response = await get("/r/octo/secret-docs", { cookie: reader });
    const html = await response.text();
    return response.status === 200 && response.headers.get("X-Rendro-Readiness") === null ? html : null;
  }, "the docs");
}

const agent = new Agent({ keepAlive: true, maxSockets: 1 });

function timed(path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = httpRequest(new URL(path, benchOrigin), { agent }, response => {
      response.on("data", () => {});
      response.on("end", () => resolve(performance.now() - started));
    });
    request.on("error", reject);
    request.end();
  });
}

async function median(path: string, runs: number): Promise<number> {
  const times: number[] = [];
  for (let run = 0; run < runs; run += 1) times.push(await timed(path));
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "rendro-lifecycle-"));
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === github.origin || url.origin === github.archiveOrigin) return github.fetch(input, init);
    if (request.url.startsWith(`${convexSite}/api/auth/get-session`)) return Promise.resolve(sessionResponse(request));
    return Promise.reject(new Error(`Blocked outbound fetch to ${url.origin}`));
  };
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
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
  const key = process.env.REPO_CONTENT_KEY as string;
  const vars = {
    NODE_ENV: "production", LOG_LEVEL: "error", CONVEX_URL: "http://convex.test:3210", CONVEX_SITE_URL: convexSite,
    CONVEX_INTERNAL_SECRET: "workerd-convex-internal-secret-0123456789", AUTH_SECRET: "workerd-auth-secret-0123456789",
    REPO_CAPABILITY_SECRET: "workerd-repo-capability-secret-0123456789", IMAGE_PROXY_SECRET: "workerd-image-proxy-secret-0123456789",
    REPO_CONTENT_KEY: key,
  };
  server = createTestHarness({
    root,
    workers: [
      { configPath: productConfigPath, vars, secrets: vars },
      { configPath: repoReadWorker.accessConfig },
      {
        configPath: ingestConfigPath,
        vars: { GITHUB_API_ORIGIN: github.origin, GITHUB_ARCHIVE_ORIGINS: github.archiveOrigin, REPO_IDLE_EXPIRY_SECONDS: String(IDLE_SECONDS) },
        secrets: { GITHUB_DEV_TOKEN: github.token, IMAGE_PROXY_SECRET: process.env.IMAGE_PROXY_SECRET as string, REPO_CONTENT_KEY: key },
      },
    ],
  });
  origin = (await server.listen()).url.origin;
  env = await server.getWorker<ProductEnv>().getEnv();
  const access = await server.getWorker<AccessEnv>(repoReadWorker.access).getEnv();
  await access.GRANTS.put("grants", JSON.stringify({ repos: [
    { id: 705, owner: "octo", name: "secret-docs", private: true, defaultBranch: "main", readers: ["user-reader"] },
  ] }));
  // The benchmark Worker runs alone: nothing else shares its isolate while it is timed.
  const bench = createTestHarness({ root, workers: [{ config: { name: "seal-bench", main: join(root, "tests/helpers/seal-bench-worker.ts"), compatibility_date: "2025-07-06", vars: { REPO_CONTENT_KEY: key } } }] });
  benchOrigin = (await bench.listen()).url.origin;
  benchClose = () => bench.close();
}, 180_000);

let benchClose: () => Promise<void> = () => Promise.resolve();

afterAll(async () => {
  agent.destroy();
  await benchClose();
  await server?.close();
  globalThis.fetch = originalFetch;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("private repository content on workerd", () => {
  it("is ingested sealed on first view, expires when nobody views it, and is ingested again on the next view", async () => {
    const commit = repo.commit(docs);
    expect(await viewDocs()).toContain('window.RENDRO_INITIAL_DOC="secret-docs/docs/index.md"');
    // Sealed in R2: every object but the pointer, and no plaintext anywhere.
    const objects = await stored();
    expect(objects.length).toBeGreaterThan(4);
    for (const { key, bytes } of objects) {
      expect(isSealed(bytes)).toBe(!key.includes("/ref/"));
      expect(new TextDecoder().decode(bytes)).not.toContain("Classified");
    }
    // The serving Worker opens it after authorization; an outsider gets the plain 404.
    const frame = await get(`/r/octo/secret-docs/@${commit}/files/docs/plans.md`, { cookie: reader });
    expect(await frame.text()).toContain("Nobody outside may read this.");
    expect((await get(`/r/octo/secret-docs/@${commit}/files/docs/plans.md`)).status).toBe(404);

    // Nobody views it for the (shortened) idle window: the coordinator's alarm deletes the content.
    await waitFor(async () => ((await stored()).length === 0 ? true : null), "idle expiry");
    // The next view finds no pointer once the serving isolate's memo lapses, and ingests again.
    await waitFor(async () => {
      await (await get("/r/octo/secret-docs", { cookie: reader })).arrayBuffer();
      return await env.REPO_CONTENT.get(refKey(705, "main")) ? true : null;
    }, "the re-ingest");
    expect(await viewDocs()).toContain('window.RENDRO_INITIAL_DOC="secret-docs/docs/index.md"');
    expect((await stored()).every(({ key, bytes }) => isSealed(bytes) === !key.includes("/ref/"))).toBe(true);

    // A removal GitHub confirmed (#258, through the control Worker's ledger) purges it, with an audit record.
    const ingest = await server.getWorker<IngestEnv>("rendro-ingest-dev").getEnv();
    const stub = ingest.INGEST_COORDINATOR.get(ingest.INGEST_COORDINATOR.idFromName(coordinatorName(705)));
    const purge = await stub.fetch("https://coordinator/purge", { method: "POST", body: JSON.stringify({ repoId: 705 }) });
    expect(await purge.json()).toEqual({ status: "done" });
    expect(await stored()).toEqual([]);
    expect((await env.REPO_CONTENT.list({ prefix: "gh/v1/audit/purge/705/" })).objects).toHaveLength(1);
  }, 180_000);

  it("measures sealing and opening one object inside workerd", async () => {
    const rows: string[] = [];
    for (const [label, size, count] of [["1 KiB", 1024, 2_000], ["64 KiB", 64 * 1024, 500], ["1 MiB", 1024 * 1024, 40]] as const) {
      for (const op of ["seal", "open"] as const) {
        // Warm the isolate, the imported keys and the socket.
        await median(`/?op=${op}&size=${size}&n=${count}`, 2);
        const floor = await median(`/?op=${op}&size=${size}&n=0`, 7);
        const total = await median(`/?op=${op}&size=${size}&n=${count}`, 7);
        rows.push(`  ${op} ${label}: ${(((total - floor) / count) * 1000).toFixed(1)} µs per object`);
      }
    }
    console.log(["content sealing in workerd (AES-256-GCM, median of 7):", ...rows].join("\n"));
    expect(rows).toHaveLength(6);
  }, 180_000);
});
