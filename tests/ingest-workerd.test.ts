import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { coordinatorName } from "../src/ingest/orchestrator/coordinator-client";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { manifestKey, refKey } from "../src/ingest/orchestrator/keys";
import type { IngestMessage } from "../src/ingest/orchestrator/messages";
import { FakeGitHub } from "./helpers/fake-github";
import { docsRepoFiles } from "./helpers/ingest-fixture";

/**
 * The ingest Worker on real workerd (wrangler's test harness): Queue consumer,
 * per-repo Durable Object, local R2 and the cron, with the Worker's outbound
 * fetches routed to an in-process fake GitHub.
 */

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix: string }): Promise<{ objects: Array<{ key: string }> }>;
}
interface Env {
  INGEST_BUCKET: R2Like;
  INGEST_QUEUE: { send(body: IngestMessage): Promise<void> };
  INGEST_COORDINATOR: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string, init?: RequestInit): Promise<Response> } };
}

const root = fileURLToPath(new URL("..", import.meta.url));
const github = new FakeGitHub();
let server: ReturnType<typeof createTestHarness>;
let env: Env;
const originalFetch = globalThis.fetch;

async function pointer(repoId: number, branch = "main"): Promise<{ commit: string } | null> {
  const object = await env.INGEST_BUCKET.get(refKey(repoId, branch));
  return object ? JSON.parse(await object.text()) as { commit: string } : null;
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting for the ingest Worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function ensure(repo: ReturnType<typeof github.repo>): Promise<{ status: string; commit?: string }> {
  const stub = env.INGEST_COORDINATOR.get(env.INGEST_COORDINATOR.idFromName(coordinatorName(repo.id)));
  return stub.fetch("https://coordinator/ensure", { method: "POST", body: JSON.stringify({ repo: repo.ref, branch: "main" }) })
    .then((response) => response.json() as Promise<{ status: string; commit?: string }>);
}

beforeAll(async () => {
  // Wrangler's harness hands every outbound Worker fetch to globalThis.fetch.
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === github.origin || url.origin === github.archiveOrigin) return github.fetch(input, init);
    return Promise.reject(new Error(`Blocked outbound fetch to ${url.origin}`));
  };
  process.env.WRANGLER_SEND_METRICS = "false";
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  server = createTestHarness({
    root,
    workers: [{
      configPath: "wrangler.ingest.toml",
      vars: { GITHUB_API_ORIGIN: github.origin, GITHUB_ARCHIVE_ORIGINS: github.archiveOrigin },
      secrets: { GITHUB_DEV_TOKEN: github.token },
    }],
  });
  await server.listen();
  env = await server.getWorker<Env>().getEnv();
}, 120_000);

afterAll(async () => {
  await server?.close();
  globalThis.fetch = originalFetch;
});

describe("ingest Worker on workerd", () => {
  it("serves no routes", async () => {
    expect((await server.fetch("/")).status).toBe(404);
  });

  it("ingests a pushed commit through the queue, then an incremental push", async () => {
    const repo = github.repo("octo", "queue-docs", { id: 101, private: true });
    const first = repo.commit(docsRepoFiles({ pages: 60, images: 6, sources: 40 }));
    github.resetLog();
    let started = performance.now();
    await env.INGEST_QUEUE.send({ v: 1, repo: repo.ref, branch: "main", sha: first, deliveryId: "workerd-1", reason: "push" });
    await waitFor(async () => ((await pointer(101))?.commit === first ? true : null));
    const firstMs = performance.now() - started;
    const firstRequests = github.billable();
    expect(github.count("tarball")).toBe(1);
    expect(github.count("blob")).toBe(0);
    const manifest = JSON.parse(await (await env.INGEST_BUCKET.get(manifestKey(101, first, RENDERER_VERSION)))?.text() as string) as { files: Record<string, { render?: string }> };
    // comrak (bundled WASM) rendered the page, and the sanitizer added GitHub-style heading ids.
    const page = JSON.parse(await (await env.INGEST_BUCKET.get(`gh/v1/repo/101/${manifest.files["docs/page-0.md"].render as string}`))?.text() as string) as { html: string; title: string };
    expect(page.title).toBe("Page 0");
    expect(page.html).toContain('<h1 id="user-content-page-0">Page 0</h1>');

    github.resetLog();
    const second = repo.change({ "docs/page-1.md": "# Changed\n", "docs/new-page.md": "# New\n" });
    started = performance.now();
    await env.INGEST_QUEUE.send({ v: 1, repo: repo.ref, branch: "main", sha: second, deliveryId: "workerd-2", reason: "push" });
    await waitFor(async () => ((await pointer(101))?.commit === second ? true : null));
    const incrementalMs = performance.now() - started;
    expect(github.count("tarball")).toBe(0);
    expect(github.count("blob")).toBe(2);
    console.log(`workerd ingest: first import ${firstMs.toFixed(0)} ms / ${firstRequests} billable GitHub requests; `
      + `incremental push ${incrementalMs.toFixed(0)} ms / ${github.billable()} billable (includes queue batching, max_batch_timeout 1 s)`);
  });

  it("coalesces concurrent first views of an unseen repository into one ingest", async () => {
    const repo = github.repo("octo", "first-view", { id: 102 });
    const head = repo.commit(docsRepoFiles({ pages: 10 }));
    github.resetLog();
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => ensure(repo)));
    expect(new Set(outcomes.map((outcome) => outcome.commit))).toEqual(new Set([head]));
    expect(github.count("tree")).toBe(1);
    expect(github.count("ref", { status: 200 })).toBe(1);
    expect((await pointer(102))?.commit).toBe(head);
  });

  it("never flips to a partial snapshot when the isolate dies mid-ingest", async () => {
    const repo = github.repo("octo", "crash", { id: 103 });
    // Few enough blobs for per-blob fetching (no archive).
    const head = repo.commit(docsRepoFiles({ pages: 12, images: 2 }));
    let release: () => void = () => {};
    let blobs = 0;
    github.resetLog();
    github.gateFilter = (endpoint) => endpoint === "blob" && ++blobs > 6;
    github.gate = new Promise((resolve) => { release = resolve; });
    const doomed = ensure(repo).then(() => "completed", () => "aborted");
    try {
      await waitFor(() => Promise.resolve(github.held > 0 ? true : null));
      // Reload the Workers while the ingest waits on GitHub: the isolate and the object die
      // with part of the snapshot written; storage survives.
      await server.update((options) => options);
      env = await server.getWorker<Env>().getEnv();
    } finally {
      github.gate = null;
      github.gateFilter = null;
      release();
    }
    expect(await doomed).toBe("aborted");
    const written = (await env.INGEST_BUCKET.list({ prefix: "gh/v1/repo/103/" })).objects.map((object) => object.key);
    expect(written.some((key) => key.includes("/blob/"))).toBe(true);
    expect(written.some((key) => key.endsWith("manifest.json"))).toBe(false);
    expect(await pointer(103)).toBeNull();

    github.resetLog();
    const retried = await ensure(repo);
    expect(retried).toMatchObject({ status: "flipped", commit: head });
    expect((await pointer(103))?.commit).toBe(head);
    // Blobs written before the crash are not fetched again.
    expect(github.count("blob")).toBeLessThan(15);
  });

  it("reconciliation finds a push no webhook announced", async () => {
    const repo = github.repo("octo", "missed", { id: 104 });
    const first = repo.commit(docsRepoFiles({ pages: 3 }));
    expect(await ensure(repo)).toMatchObject({ commit: first });
    const missed = repo.change({ "docs/index.md": "# Home v2\n" });
    await server.getWorker().scheduled({ cron: "*/10 * * * *", scheduledTime: new Date() });
    await waitFor(async () => ((await pointer(104))?.commit === missed ? true : null));
  });
});
