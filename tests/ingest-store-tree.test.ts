import { describe, expect, it } from "vitest";
import { IngestError, toIngestError } from "../src/ingest/orchestrator/errors";
import { GitHubError } from "../src/ingest/github/source";
import { treeKey } from "../src/ingest/orchestrator/keys";
import { plaintextSealer, r2Store, readJson, RepoContent, writeJson, type ContentSealer } from "../src/ingest/orchestrator/store";
import { defaultSkipDirectory, listCommitTree } from "../src/ingest/orchestrator/tree-listing";
import { BoundedTasks, workPool, SingleFlight } from "../src/ingest/orchestrator/concurrency";
import { FakeR2Bucket } from "./helpers/fake-storage";
import { ingestFixture } from "./helpers/ingest-fixture";

const encoder = new TextEncoder();
const repo = { id: 5, owner: "octo", name: "docs", private: false, installationId: null };

describe("object store over R2", () => {
  it("reads, writes, checks and lists", async () => {
    const bucket = new FakeR2Bucket();
    const store = r2Store(bucket);
    expect(await store.get("a")).toBeNull();
    expect(await store.has("a")).toBe(false);
    expect(await store.put("a", encoder.encode("one"))).toBe(true);
    expect(bucket.objects.get("a")?.contentType).toBe("application/octet-stream");
    const stored = await store.get("a");
    expect(new TextDecoder().decode(stored?.bytes)).toBe("one");
    expect(await store.has("a")).toBe(true);
    // Conditional put: the compare-and-swap the ref pointer uses.
    expect(await store.put("a", encoder.encode("two"), { ifMatch: "stale" })).toBe(false);
    expect(await store.put("a", encoder.encode("two"), { ifMatch: stored?.etag as string, contentType: "text/plain" })).toBe(true);
    expect(bucket.objects.get("a")?.contentType).toBe("text/plain");
    bucket.listLimit = 2;
    for (const key of ["p/1", "p/2", "p/3", "q/1"]) await store.put(key, new Uint8Array());
    const first = await store.list("p/");
    expect(first).toEqual({ keys: ["p/1", "p/2"], cursor: "2" });
    expect(await store.list("p/", first.cursor)).toEqual({ keys: ["p/3"], cursor: null });
  });

  it("reads and writes JSON with an optional precondition", async () => {
    const store = r2Store(new FakeR2Bucket());
    expect(await readJson(store, "k")).toBeNull();
    expect(await writeJson(store, "k", { a: 1 })).toBe(true);
    const value = await readJson<{ a: number }>(store, "k");
    expect(value?.value).toEqual({ a: 1 });
    expect(await writeJson(store, "k", { a: 2 }, "nope")).toBe(false);
    expect(await writeJson(store, "k", { a: 2 }, value?.etag)).toBe(true);
  });
});

describe("repository content and the encryption hook", () => {
  const marking: ContentSealer = {
    seal: (scope, bytes) => Promise.resolve(new Uint8Array([...encoder.encode(`sealed:${scope.repoId}:${scope.key}:`), ...bytes])),
    open: (scope, bytes) => Promise.resolve(bytes.slice(encoder.encode(`sealed:${scope.repoId}:${scope.key}:`).length)),
    currentKeyId: () => Promise.resolve("marking"),
  };

  it("seals private-repository content both ways", async () => {
    const bucket = new FakeR2Bucket();
    const content = new RepoContent(r2Store(bucket), { ...repo, private: true }, marking);
    await content.putJson("k", { secret: true });
    expect(new TextDecoder().decode(bucket.objects.get("k")?.bytes)).toBe('sealed:5:k:{"secret":true}');
    expect(bucket.objects.get("k")?.contentType).toBe("application/json");
    expect(await content.getJson("k")).toEqual({ secret: true });
    expect(await content.has("k")).toBe(true);
    expect(await content.getBytes("missing")).toBeNull();
    expect(await content.getJson("missing")).toBeNull();
  });

  it("stores public-repository content as is, and the default sealer is a no-op", async () => {
    const bucket = new FakeR2Bucket();
    const content = new RepoContent(r2Store(bucket), repo, marking);
    await content.putBytes("k", encoder.encode("plain"));
    expect(new TextDecoder().decode(bucket.objects.get("k")?.bytes)).toBe("plain");
    const fallback = new RepoContent(r2Store(bucket), { ...repo, private: true });
    await fallback.putBytes("p", encoder.encode("p"));
    expect(new TextDecoder().decode(await fallback.getBytes("p") as Uint8Array)).toBe("p");
    expect(await plaintextSealer.open({ repoId: 1, key: "x" }, encoder.encode("x"))).toEqual(encoder.encode("x"));
    expect(await plaintextSealer.currentKeyId()).toBeNull();
    // Deleting nothing makes no R2 call.
    await r2Store(bucket).delete([]);
    expect(bucket.ops.delete).toBe(0);
  });
});

describe("errors", () => {
  it("classifies failures as permanent or transient", () => {
    const own = new IngestError("x", "m", true);
    expect(toIngestError(own)).toBe(own);
    expect(toIngestError(new GitHubError("not-found", "gone", 404))).toMatchObject({ reason: "github-not-found", permanent: true });
    expect(toIngestError(new GitHubError("forbidden", "no", 403))).toMatchObject({ permanent: true });
    expect(toIngestError(new GitHubError("too-large", "big"))).toMatchObject({ permanent: true });
    expect(toIngestError(new GitHubError("rate-limited", "wait", 429, 1234))).toMatchObject({ reason: "github-rate-limited", permanent: false, retryAt: 1234 });
    expect(toIngestError(new Error("R2 down"))).toMatchObject({ reason: "internal", message: "R2 down", permanent: false, retryAt: null });
    expect(toIngestError("weird")).toMatchObject({ reason: "internal", message: "Ingest failed" });
    const original = new Error("false == true");
    expect(toIngestError(original).cause).toBe(original);
    const gone = new GitHubError("not-found", "gone", 404);
    expect(toIngestError(gone).cause).toBe(gone);
    expect(new GitHubError("server", "x").transient).toBe(true);
  });
});

describe("concurrency helpers", () => {
  it("runs a growing work list with bounded parallelism", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await workPool([1], 3, async (item, push) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (item < 4) {
        push(item * 10);
        push(item * 10 + 1);
      }
      done.push(item);
      active -= 1;
    });
    expect(done.sort((a, b) => a - b)).toEqual([1, 10, 11]);
    expect(peak).toBeLessThanOrEqual(3);
    await workPool([], 0, () => Promise.resolve());
  });

  it("stops at the first failure and rethrows it", async () => {
    const seen: number[] = [];
    await expect(workPool([1, 2, 3, 4, 5], 2, async (item) => {
      seen.push(item);
      await Promise.resolve();
      if (item === 2) throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(seen.length).toBeLessThan(5);
  });

  it("starts bounded tasks by count and by declared bytes, and lets one oversized task run alone", async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
    const run = async (limit: number, maxBytes: number, sizes: number[]) => {
      const tasks = new BoundedTasks(limit, maxBytes);
      let active = 0;
      let bytes = 0;
      const peak = { active: 0, bytes: 0 };
      for (const size of sizes) {
        expect(await tasks.submit(size, async () => {
          active += 1;
          bytes += size;
          peak.active = Math.max(peak.active, active);
          peak.bytes = Math.max(peak.bytes, bytes);
          await tick();
          active -= 1;
          bytes -= size;
        })).toBe(true);
      }
      await tasks.settle();
      expect(tasks.failure).toBeNull();
      return peak;
    };
    expect(await run(3, 1000, [1, 1, 1, 1, 1, 1, 1])).toEqual({ active: 3, bytes: 3 });
    expect(await run(10, 100, [40, 40, 40, 40, 40])).toEqual({ active: 2, bytes: 80 });
    // A task over the byte budget still runs, with nothing next to it; a limit of 0 is treated as 1.
    expect(await run(5, 100, [10, 500, 10, 10])).toEqual({ active: 2, bytes: 500 });
    expect(await run(0, 100, [1, 1, 1])).toEqual({ active: 1, bytes: 1 });
    await new BoundedTasks(1, 1).settle();
  });

  it("stops starting bounded tasks at the first failure, waits for running ones, and keeps the error", async () => {
    const tasks = new BoundedTasks(3, 1000);
    const finished: string[] = [];
    expect(await tasks.submit(1, async () => { await new Promise((resolve) => setTimeout(resolve, 10)); finished.push("slow"); })).toBe(true);
    expect(await tasks.submit(1, () => Promise.reject(new Error("boom")))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await tasks.submit(1, () => { finished.push("never"); return Promise.resolve(); })).toBe(false);
    await tasks.settle();
    expect(finished).toEqual(["slow"]);
    expect((tasks.failure?.error as Error).message).toBe("boom");
    // A submit already waiting for capacity when the failure lands also gives up.
    const waiting = new BoundedTasks(1, 1000);
    await waiting.submit(1, async () => { await new Promise((resolve) => setTimeout(resolve, 2)); throw new Error("late"); });
    expect(await waiting.submit(1, () => Promise.resolve())).toBe(false);
    await waiting.settle();
  });

  it("coalesces concurrent calls per key", async () => {
    const flights = new SingleFlight<number>();
    let calls = 0;
    const task = () => new Promise<number>((resolve) => { calls += 1; setTimeout(() => resolve(calls), 1); });
    const results = await Promise.all([flights.run("a", task), flights.run("a", task), flights.run("b", task)]);
    expect(results[0]).toBe(results[1]);
    expect(calls).toBe(2);
    expect(flights.size).toBe(0);
    await flights.run("a", task);
    expect(calls).toBe(3);
  });
});

describe("listCommitTree", () => {
  function monorepo() {
    const files: Record<string, string> = { "README.md": "# r" };
    for (let index = 0; index < 30; index += 1) files[`packages/p${index}/src/index.ts`] = `export const p${index} = ${index};`;
    files["docs/index.md"] = "# docs";
    files["node_modules/dep/index.js"] = "x";
    return files;
  }

  it("uses one recursive request when GitHub does not truncate", async () => {
    const { source, store, github } = ingestFixture();
    const fake = github.repo("octo", "docs", { id: 5 });
    const head = fake.commit(monorepo());
    const listing = await listCommitTree(source, new RepoContent(store, fake.ref), fake.ref, head);
    expect(listing).toMatchObject({ walked: false, walkRequests: 0 });
    expect(github.count("tree")).toBe(1);
    expect(listing.entries.some((entry) => entry.path === "node_modules/dep/index.js")).toBe(true);
  });

  it("walks a truncated tree directory by directory, caching each listing by tree ID", async () => {
    const { source, store, github, bucket } = ingestFixture();
    const fake = github.repo("octo", "docs", { id: 5 });
    const head = fake.commit(monorepo());
    const full = (await source.getTree(fake.ref, head, true)).entries;
    fake.truncateAt = 10;
    github.resetLog();
    const content = new RepoContent(store, fake.ref);
    const listing = await listCommitTree(source, content, fake.ref, head);
    expect(listing.walked).toBe(true);
    // Same entries as the full listing, except below skipped directories (node_modules is listed, not entered).
    expect(listing.entries.map((entry) => entry.path)).toEqual(full.filter((entry) => !entry.path.startsWith("node_modules/")).map((entry) => entry.path));
    const walked = full.filter((entry) => entry.type === "tree" && !entry.path.startsWith("node_modules")).length;
    expect(listing.walkRequests).toBe(walked + 1); // + the root
    expect(bucket.keys("gh/v1/repo/5/tree/")).toHaveLength(listing.walkRequests);

    // One package changes: only the directories on its path are fetched again.
    const next = fake.change({ "packages/p3/src/index.ts": "export const p3 = 'changed';" });
    github.resetLog();
    const second = await listCommitTree(source, content, fake.ref, next);
    expect(second.walkRequests).toBe(4); // root, packages, packages/p3, packages/p3/src
    expect(github.count("tree")).toBe(1 + 4);
    expect(await content.getJson(treeKey(5, second.treeSha))).not.toBeNull();
  });

  it("fails permanently past the directory limit and honours a custom skip rule", async () => {
    const { source, store, github } = ingestFixture();
    const fake = github.repo("octo", "docs", { id: 5 });
    const head = fake.commit(monorepo());
    fake.truncateAt = 1;
    const content = new RepoContent(store, fake.ref);
    await expect(listCommitTree(source, content, fake.ref, head, { maxDirectories: 3 })).rejects.toMatchObject({ reason: "tree-too-large", permanent: true });
    const onlyTop = await listCommitTree(source, content, fake.ref, head, { skipDirectory: () => true, concurrency: 1 });
    expect(onlyTop.entries.map((entry) => entry.path)).toEqual(["README.md", "docs", "node_modules", "packages"]);
    expect(defaultSkipDirectory("a/vendor")).toBe(true);
    expect(defaultSkipDirectory("vendors")).toBe(false);
  });
});
