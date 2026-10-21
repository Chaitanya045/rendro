import { describe, expect, it } from "vitest";
import type { CachedRef } from "../src/ingest/github/source";
import { CommitIngestError, ingestBranch, readPointer, type RefEtagCache, type RefPointer } from "../src/ingest/orchestrator/ingest";
import { manifestKey, refKey } from "../src/ingest/orchestrator/keys";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";

function memoryEtags(): RefEtagCache & { values: Map<string, CachedRef> } {
  const values = new Map<string, CachedRef>();
  return { values, get: (branch) => Promise.resolve(values.get(branch) ?? null), set: (branch, value) => { values.set(branch, value); return Promise.resolve(); } };
}

function setup() {
  const fixture = ingestFixture();
  const repo = fixture.github.repo("octo", "docs", { id: 21 });
  const etags = memoryEtags();
  const run = (branch = "main", onHead?: (sha: string) => void) => ingestBranch(fixture.deps, etags, repo.ref, branch, onHead);
  return { ...fixture, repo, etags, run };
}

describe("ingestBranch (render-then-flip)", () => {
  it("reports a branch with no commits without touching storage", async () => {
    const { run, bucket, repo } = setup();
    expect(await run()).toEqual({ status: "no-ref" });
    repo.commit({ "docs/index.md": "# Home\n" });
    expect(await run("gone")).toEqual({ status: "no-ref" });
    expect(bucket.keys("gh/v1/repo/21/ref/")).toEqual([]);
  });

  it("builds the snapshot, then flips the pointer forward", async () => {
    const { run, repo, bucket, etags, github, clock, store } = setup();
    const first = repo.commit(docsRepoFiles({ pages: 3 }));
    const heads: string[] = [];
    const result = await run("main", (sha) => heads.push(sha));
    expect(result).toMatchObject({ status: "flipped", commit: first, previous: null, snapshot: "built", headMoved: false });
    expect(heads).toEqual([first]);
    expect(bucket.json<RefPointer>(refKey(21, "main"))).toEqual({
      schema: 1, repoId: 21, branch: "main", commit: first, rendererVersion: RENDERER_VERSION, sequence: 1, flippedAt: new Date(clock.time).toISOString(),
    });
    expect(etags.values.get("main")?.sha).toBe(first);
    // The re-check after the flip was a free 304.
    expect(github.requests.filter((request) => request.endpoint === "ref").map((request) => request.status)).toEqual([200, 304]);

    github.resetLog();
    expect(await run()).toEqual({ status: "current", commit: first });
    expect(github.requests.map((request) => request.status)).toEqual([304]);

    const second = repo.change({ "docs/page-1.md": "# One\n" });
    const next = await run();
    expect(next).toMatchObject({ status: "flipped", commit: second, previous: first, snapshot: "built" });
    expect(next.status === "flipped" && next.stats?.blobRequests).toBe(1);
    expect((await readPointer(store, 21, "main"))?.value).toMatchObject({ commit: second, sequence: 2 });
  });

  it("flips to an existing snapshot without rebuilding it", async () => {
    const { run, repo, bucket } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    repo.branches.set("copy", head);
    await run("main");
    const result = await run("copy");
    expect(result).toMatchObject({ status: "flipped", commit: head, snapshot: "existing", stats: null });
    expect(bucket.json<RefPointer>(refKey(21, "copy"))?.commit).toBe(head);
  });

  it("rebuilds the same commit after a renderer change", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n" });
    await fixture.run();
    const bumped = { ...fixture.deps, pipeline: { ...fixture.deps.pipeline, rendererVersion: RENDERER_VERSION + 1 } };
    const result = await ingestBranch(bumped, fixture.etags, fixture.repo.ref, "main");
    expect(result).toMatchObject({ status: "flipped", commit: head, previous: head, snapshot: "built" });
    expect(fixture.bucket.json<RefPointer>(refKey(21, "main"))).toMatchObject({ rendererVersion: RENDERER_VERSION + 1, sequence: 2 });
    expect(fixture.bucket.objects.has(manifestKey(21, head, RENDERER_VERSION + 1))).toBe(true);
  });

  it("refuses to flip when another writer moved the pointer (compare-and-swap)", async () => {
    const { run, repo, bucket } = setup();
    repo.commit({ "docs/index.md": "# Home\n" });
    await run();
    const next = repo.change({ "docs/index.md": "# Home 2\n" });
    bucket.beforePut = (key) => {
      if (key !== refKey(21, "main")) return;
      bucket.beforePut = null;
      bucket.objects.set(key, { bytes: new TextEncoder().encode("{}"), etag: "someone-else", contentType: "application/json" });
    };
    const error = await run().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CommitIngestError);
    expect(error).toMatchObject({ reason: "pointer-conflict", permanent: false, commit: next });
  });

  it("notices a head that moved during the build", async () => {
    const { run, repo, bucket, etags } = setup();
    const first = repo.commit({ "docs/index.md": "# Home\n" });
    let newer = "";
    bucket.beforePut = (key) => {
      if (key === manifestKey(21, first, RENDERER_VERSION)) newer = repo.change({ "docs/index.md": "# Newer\n" });
    };
    expect(await run()).toMatchObject({ status: "flipped", commit: first, headMoved: true });
    expect(etags.values.get("main")?.sha).toBe(newer);
  });

  it("never fails a flipped job over the follow-up check", async () => {
    const { run, repo, github } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    let refs = 0;
    github.fault(({ endpoint }) => endpoint === "ref" && ++refs > 1, () => new Response("down", { status: 500 }), 3);
    expect(await run()).toMatchObject({ status: "flipped", commit: head, headMoved: false });
  });

  it("wraps build failures with the commit being built", async () => {
    const { run, repo, github, bucket } = setup();
    const head = repo.commit({ "docs/index.md": "# Home\n" });
    github.fault(/git\/blobs/, () => new Response("gone", { status: 404 }));
    const error = await run().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "CommitIngestError", reason: "github-not-found", permanent: true, commit: head });
    // The original failure stays reachable: a bare message says nothing about where it came from.
    expect((error as Error).cause).toMatchObject({ name: "GitHubError", kind: "not-found" });
    expect(bucket.keys("gh/v1/repo/21/ref/")).toEqual([]);
  });
});
