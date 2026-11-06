import { describe, expect, it } from "vitest";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { blobKey, manifestKey, renderObjectKey } from "../src/ingest/orchestrator/keys";
import { PageRenderError, type ContentPipeline } from "../src/ingest/orchestrator/pipeline";
import { buildSnapshot, type SnapshotManifest, type SnapshotOptions } from "../src/ingest/orchestrator/snapshot";
import { RepoContent } from "../src/ingest/orchestrator/store";
import type { PageSection } from "../src/ingest/sections";
import type { SearchIndex } from "../src/search/index";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";

const real = contentPipeline(TEST_RENDER_OPTIONS);
const RV = RENDERER_VERSION;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wraps a pipeline so each render takes `latency` ms and the overlap of renders is recorded. */
function tracked(latency: number, failOn?: (call: number, path: string) => boolean) {
  const state = { active: 0, peak: 0, peakBytes: 0, bytes: 0, calls: 0, soloBig: true, peakSmall: 0 };
  const pipeline: ContentPipeline = {
    ...real,
    render: async (source, path) => {
      state.calls += 1;
      const call = state.calls;
      state.active += 1;
      state.bytes += source.length;
      state.peak = Math.max(state.peak, state.active);
      state.peakBytes = Math.max(state.peakBytes, state.bytes);
      if (path.endsWith("big.md")) state.soloBig = state.active === 1;
      else state.peakSmall = Math.max(state.peakSmall, state.bytes);
      try {
        await sleep(latency);
        if (failOn?.(call, path)) throw new Error("renderer bug");
        return await real.render(source, path);
      } finally {
        state.active -= 1;
        state.bytes -= source.length;
      }
    },
  };
  return { state, pipeline };
}

function setup(pipeline: ContentPipeline, search?: SearchIndex) {
  const fixture = ingestFixture({ pipeline });
  const repo = fixture.github.repo("octo", "docs", { id: 11 });
  const content = new RepoContent(fixture.store, repo.ref);
  const build = (commit: string, options?: SnapshotOptions, previous: SnapshotManifest | null = null, using = pipeline) =>
    buildSnapshot({ source: fixture.source, content, repo: repo.ref, pipeline: using, now: fixture.clock.now, options, search }, commit, previous);
  return { ...fixture, repo, content, build };
}

function putOrder(fixture: { bucket: { beforePut: ((key: string) => void) | null } }): string[] {
  const keys: string[] = [];
  fixture.bucket.beforePut = (key) => { keys.push(key); };
  return keys;
}

describe("first imports render pages concurrently", () => {
  it("overlaps pages from the archive, bounded by the pool, and still writes the manifest last", async () => {
    const { state, pipeline } = tracked(4);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 60, images: 3 }));
    const order = putOrder(fixture);
    const { manifest, stats } = await fixture.build(head, { renderConcurrency: 5 });
    expect(stats).toMatchObject({ mode: "tarball", rendered: 61, tarballFallback: false });
    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(5);
    expect(Object.values(manifest.files).filter((file) => file.render).length).toBe(61);
    // Everything else is written before the sidebar, and the sidebar before the manifest.
    expect(order[order.length - 1]).toBe(manifestKey(11, head, RV));
    expect(order[order.length - 2]).toBe(manifest.sidebar);
    expect(order.indexOf(manifest.sidebar as string)).toBe(order.length - 2);
  });

  it("stores a page's source before its render object, and the render objects before the sidebar", async () => {
    const { pipeline } = tracked(2);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 40, images: 2 }));
    const order = putOrder(fixture);
    const { manifest } = await fixture.build(head);
    for (const file of Object.values(manifest.files)) {
      if (!file.render) continue;
      const source = order.indexOf(blobKey(11, file.sha));
      const render = order.indexOf(renderObjectKey(11, file.render));
      expect(source).toBeGreaterThanOrEqual(0);
      expect(render).toBeGreaterThan(source);
      expect(render).toBeLessThan(order.indexOf(manifest.sidebar as string));
    }
  });

  it("holds the bytes of pages in flight under the cap, and runs one oversized page alone", async () => {
    const { state, pipeline } = tracked(4);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit({ ...docsRepoFiles({ pages: 50, images: 0, pageBytes: 600 }), "docs/big.md": `# Big\n\n${"word ".repeat(600)}\n` });
    const { stats } = await fixture.build(head, { renderConcurrency: 8, renderBytes: 1500 });
    expect(stats).toMatchObject({ mode: "tarball", rendered: 52 });
    // 600-byte pages: two fit in 1500, three do not; the count limit (8) never decides.
    expect(state.peakSmall).toBeLessThanOrEqual(1500);
    expect(state.peakSmall).toBeGreaterThan(1000);
    expect(state.soloBig).toBe(true);
  });

  it("renders pages whose blobs are already stored concurrently too", async () => {
    const first = tracked(0);
    const fixture = setup(first.pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 24, images: 1 }));
    await fixture.build(head);
    // A renderer bump: sources stay in R2, renders are gone.
    for (const key of fixture.bucket.keys()) if (key.includes("/render/")) fixture.bucket.objects.delete(key);
    const { state, pipeline } = tracked(4);
    fixture.github.resetLog();
    const { stats } = await fixture.build(head, { renderConcurrency: 4 }, null, pipeline);
    expect(stats).toMatchObject({ mode: "none", blobRequests: 0, rendered: 25 });
    expect(fixture.github.count("blob")).toBe(0);
    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(4);
  });

  it("is much faster than one page at a time when storage and rendering have latency", async () => {
    const files = docsRepoFiles({ pages: 48, images: 0 });
    const timed = async (renderConcurrency: number) => {
      const { pipeline } = tracked(6);
      const fixture = setup(pipeline);
      const head = fixture.repo.commit(files);
      const put = fixture.bucket.put.bind(fixture.bucket);
      fixture.bucket.put = (async (...args: Parameters<typeof put>) => { await sleep(3); return put(...args); }) as typeof put;
      const started = performance.now();
      await fixture.build(head, { renderConcurrency });
      return performance.now() - started;
    };
    const serial = await timed(1);
    const pooled = await timed(6);
    // Measured on a loaded host: about 5x. The bound is loose so it holds on slow runners.
    expect(pooled).toBeLessThan(serial * 0.7);
  });
});

describe("failure semantics are unchanged", () => {
  it("fails the job on an unexpected render error from the archive path, without a per-blob fallback or a manifest", async () => {
    const { state, pipeline } = tracked(3, (call) => call === 1);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 60, images: 0 }));
    await expect(fixture.build(head, { renderConcurrency: 3 })).rejects.toThrow("renderer bug");
    expect(fixture.github.count("blob")).toBe(0);
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(false);
    // Nothing is left running after the rejection, and no new page started once one had failed.
    const calls = state.calls;
    await sleep(20);
    expect(state.calls).toBe(calls);
    expect(state.active).toBe(0);
    expect(calls).toBeLessThan(61);
  });

  it("fails the job on a storage error from the archive path and a retry finishes from what was stored", async () => {
    const { pipeline } = tracked(1);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 60, images: 0 }));
    let puts = 0;
    fixture.bucket.failPut = () => ++puts > 30;
    await expect(fixture.build(head)).rejects.toThrow("R2 put failed");
    expect(fixture.github.count("blob")).toBe(0);
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(false);
    fixture.bucket.failPut = null;
    fixture.github.resetLog();
    const { manifest } = await fixture.build(head);
    expect(Object.values(manifest.files).filter((file) => file.render).length).toBe(61);
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(true);
  });

  it("fails the job on an error while rendering pages whose blobs are stored, and stops starting pages", async () => {
    const seed = setup(real);
    const head = seed.repo.commit(docsRepoFiles({ pages: 30, images: 0 }));
    await seed.build(head);
    for (const key of seed.bucket.keys()) if (key.includes("/render/") || key.includes("/snapshot/")) seed.bucket.objects.delete(key);
    const { state, pipeline } = tracked(3, (call) => call === 1);
    seed.github.resetLog();
    await expect(seed.build(head, { renderConcurrency: 2 }, null, pipeline)).rejects.toThrow("renderer bug");
    expect(seed.github.count("blob")).toBe(0);
    expect(await seed.content.has(manifestKey(11, head, RV))).toBe(false);
    const calls = state.calls;
    await sleep(15);
    expect(state.calls).toBe(calls);
    expect(calls).toBeLessThan(31);
  });

  it("caches an expected render failure beside concurrent successes", async () => {
    const pipeline: ContentPipeline = { ...real, render: async (source, path) => {
      await sleep(2);
      if (path.endsWith("page-7.md")) throw new PageRenderError("too deep", "too-deep");
      return real.render(source, path);
    } };
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 40, images: 0 }));
    const { manifest, stats } = await fixture.build(head);
    const failed = Object.entries(manifest.files).find(([path]) => path.endsWith("page-7.md"))?.[1];
    expect(failed).toMatchObject({ error: "too-deep" });
    expect(stats.rendered).toBe(40);
    expect(await fixture.content.getJson(renderObjectKey(11, failed?.render as string))).toEqual({ error: "too-deep" });
  });

  it("still falls back to per-blob requests when the archive is cut off while pages are rendering", async () => {
    const { pipeline } = tracked(3);
    const fixture = setup(pipeline);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 60, images: 0 }));
    fixture.repo.archiveCut = 0.5;
    const { manifest, stats } = await fixture.build(head);
    expect(stats.tarballFallback).toBe(true);
    expect(stats.tarballBlobs).toBeGreaterThan(0);
    expect(stats.tarballBlobs + stats.blobRequests).toBe(61);
    expect(Object.values(manifest.files).every((file) => !file.error)).toBe(true);
  });
});

/** Index double: records writes with their options, can fail one blob, and can claim no blob has rows. */
class FakeIndex implements SearchIndex {
  readonly puts: Array<{ blobSha: string; replace: boolean | undefined }> = [];
  failOn: ((puts: number) => boolean) | null = null;
  migrate = () => Promise.resolve();
  hasBlob = () => Promise.resolve(false);
  async putBlob(_repoId: number, blobSha: string, _sections: readonly PageSection[], options?: { replace?: boolean }) {
    this.puts.push({ blobSha, replace: options?.replace });
    const number = this.puts.length;
    await sleep(1);
    if (this.failOn?.(number)) throw new Error("D1 down");
  }
  query = () => Promise.resolve([]);
  deleteRepo = () => Promise.resolve(0);
}

describe("indexing during concurrent renders", () => {
  it("stores no render object for a page whose rows failed, so a retry renders and indexes it again", async () => {
    const index = new FakeIndex();
    const fixture = setup(real, index);
    const head = fixture.repo.commit(docsRepoFiles({ pages: 10, images: 0 }));
    index.failOn = (puts) => puts === 4;
    await expect(fixture.build(head)).rejects.toThrow("D1 down");
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(false);
    const rendersBefore = fixture.bucket.keys().filter((key) => key.includes("/render/")).length;
    expect(rendersBefore).toBeLessThan(11);
    index.failOn = null;
    index.puts.length = 0;
    const { manifest } = await fixture.build(head);
    expect(Object.values(manifest.files).filter((file) => file.render).length).toBe(11);
    // Pages that stored before the failure had their rows (hasBlob answers false here, so they are re-filled without a DELETE).
    expect(index.puts.length).toBeGreaterThan(0);
  });

  it("writes a blob shared by several paths once, and without a DELETE when a reused render refills its rows", async () => {
    const index = new FakeIndex();
    const fixture = setup(real, index);
    const page = "# Shared\n\nSame words everywhere.\n";
    const first = fixture.repo.commit({ "docs/index.md": "# Home\n", "docs/a/one.md": page, "docs/b/two.md": page });
    const { manifest } = await fixture.build(first);
    const sha = manifest.files["docs/a/one.md"].sha;
    // Fresh renders replace: the blob might have rows from an interrupted attempt. Two paths, one write.
    expect(index.puts.filter((put) => put.blobSha === sha)).toEqual([{ blobSha: sha, replace: true }]);

    index.puts.length = 0;
    const second = fixture.repo.commit({ "docs/index.md": "# Home\n", "docs/a/one.md": page, "docs/a/two.md": page });
    const next = await fixture.build(second, undefined, manifest);
    expect(next.stats.reusedRenders).toBeGreaterThan(0);
    // Both paths reuse one stored render and both see no rows: one write, no DELETE.
    expect(index.puts.filter((put) => put.blobSha === sha)).toEqual([{ blobSha: sha, replace: false }]);
  });
});
