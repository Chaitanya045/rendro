import { describe, expect, it, vi } from "vitest";
import { blobKey, manifestKey, renderObjectKey } from "../src/ingest/orchestrator/keys";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";
import { PageRenderError, type ContentPipeline, type PipelineDocSet } from "../src/ingest/orchestrator/pipeline";

const real = contentPipeline(TEST_RENDER_OPTIONS);
const RV = RENDERER_VERSION;
import { buildSnapshot, type SnapshotManifest, type SnapshotOptions } from "../src/ingest/orchestrator/snapshot";
import { RepoContent, type ContentSealer } from "../src/ingest/orchestrator/store";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";

type Fixture = ReturnType<typeof ingestFixture>;

function setup(options: { pipeline?: ContentPipeline; private?: boolean; sealer?: ContentSealer } = {}) {
  const fixture = ingestFixture({ pipeline: options.pipeline, sealer: options.sealer });
  const repo = fixture.github.repo("octo", "docs", { id: 11, private: options.private ?? false });
  const content = new RepoContent(fixture.store, repo.ref, options.sealer);
  const build = (commit: string, previous: SnapshotManifest | null = null, snapshotOptions?: SnapshotOptions, pipeline = options.pipeline ?? real) =>
    buildSnapshot({ source: fixture.source, content, repo: repo.ref, pipeline, now: fixture.clock.now, options: snapshotOptions }, commit, previous);
  return { ...fixture, repo, content, build };
}

function withDocSet(change: (docSet: PipelineDocSet) => PipelineDocSet, base: ContentPipeline = real): ContentPipeline {
  return { ...base, detect: (entries, configs) => {
    const detection = base.detect(entries, configs);
    const primary = detection.primary ? change(detection.primary) : null;
    return { primary, docSets: primary ? [primary] : [] };
  } };
}

function putOrder(fixture: Fixture): string[] {
  const keys: string[] = [];
  fixture.bucket.beforePut = (key) => { keys.push(key); };
  return keys;
}

describe("buildSnapshot: first import", () => {
  it("fetches each blob once, renders pages, writes the sidebar, and the manifest last", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ ...docsRepoFiles({ pages: 4, images: 2 }), "docs/copy.md": "# Page 0 copy\n", "docs/same.md": "# Home\n\nWelcome.\n" });
    const order = putOrder(fixture);
    const { manifest, stats } = await fixture.build(head);
    expect(stats).toMatchObject({ mode: "blobs", pages: 7, assets: 2, rendered: 7, reusedRenders: 0, tarballBlobs: 0, walked: false });
    // docs/same.md and docs/index.md share a blob: fetched once, rendered for both paths.
    expect(stats.blobRequests).toBe(8);
    expect(fixture.github.count("blob")).toBe(8);
    expect(fixture.github.count("tarball")).toBe(0);
    expect(order[order.length - 1]).toBe(manifestKey(11, head, RV));
    expect(order[order.length - 2]).toBe(manifest.sidebar);
    expect(manifest).toMatchObject({
      schema: 1, repoId: 11, commit: head, rendererVersion: RV, assetsTruncated: false,
      docs: { root: "docs", generator: "folder", entry: "docs/index.md", kind: "markdown", truncated: false },
      docSets: [{ root: "docs", generator: "folder", kind: "markdown", entry: "docs/index.md" }],
    });
    expect(manifest.docs?.rootTree).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.files["docs/index.md"]).toMatchObject({ title: "Home", render: expect.stringMatching(new RegExp(`^render/v${RV}/markdown/`)) as unknown });
    expect(manifest.files["docs/img/figure-0.png"]).toEqual({ sha: expect.any(String) as unknown, size: 2048 });
    const rendered = await fixture.content.getJson<{ html: string }>(renderObjectKey(11, manifest.files["docs/index.md"].render as string));
    expect(rendered?.html).toContain("Welcome.");
    expect(await fixture.content.getJson(manifest.sidebar as string)).toMatchObject({ entry: "docs/index.md" });
    expect(await fixture.content.has(blobKey(11, manifest.files["docs/img/figure-1.png"].sha))).toBe(true);
  });

  it("takes a first import of many docs from one archive request", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ ...docsRepoFiles({ pages: 60, images: 5 }), "docs/huge.md": "x".repeat(1024 * 1024 + 1) });
    const { manifest, stats } = await fixture.build(head);
    expect(stats).toMatchObject({ mode: "tarball", tarballBlobs: 66, blobRequests: 0, rendered: 61, tarballFallback: false });
    expect(fixture.github.count("tarball")).toBe(1);
    expect(fixture.github.count("blob")).toBe(0);
    expect(Object.keys(manifest.files)).toHaveLength(67);
    expect(manifest.files["docs/huge.md"]).toMatchObject({ error: "too-large" });
  });

  it("chooses per-blob requests when the docs are a small share of a large repository", async () => {
    const fixture = setup();
    const files = { ...docsRepoFiles({ pages: 40, images: 0 }), "assets/big.bin": new Uint8Array(200_000) };
    const head = fixture.repo.commit(files);
    const share = { tarball: { smallRepoBytes: 1000, minDocsShare: 0.5 } };
    expect((await fixture.build(head, null, share)).stats.mode).toBe("blobs");
    const big = setup();
    const bigHead = big.repo.commit(files);
    expect((await big.build(bigHead, null, { tarball: { maxRepoBytes: 1000 } })).stats.mode).toBe("blobs");
    const docsHeavy = setup();
    const heavyHead = docsHeavy.repo.commit(docsRepoFiles({ pages: 40, images: 0 }));
    expect((await docsHeavy.build(heavyHead, null, { tarball: { smallRepoBytes: 1000, minDocsShare: 0.5 } })).stats.mode).toBe("tarball");
  });

  it("never uses the archive for a walked (truncated) tree", async () => {
    const fixture = setup();
    const head = fixture.repo.commit(docsRepoFiles({ pages: 40 }));
    fixture.repo.truncateAt = 5;
    const { stats } = await fixture.build(head);
    expect(stats).toMatchObject({ mode: "blobs", walked: true });
  });

  it("writes an empty manifest when the repository has no docs", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ "src/a.ts": "x" });
    const { manifest, stats } = await fixture.build(head);
    expect(manifest).toMatchObject({ docs: null, docSets: [], files: {}, sidebar: null });
    expect(stats.mode).toBe("none");
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(true);
  });

  it("excludes symlinks and submodules, records oversized files and caps assets", async () => {
    const pipeline = { ...real, maxSourceBytes: 100 };
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({
      "docs/index.md": "# Home\n",
      "docs/huge.md": `# Huge\n${"x".repeat(200)}`,
      "docs/link.md": { symlink: "index.md" },
      "docs/sub": { submodule: "a".repeat(40) },
      "docs/a.png": "a", "docs/b.png": "b", "docs/c.png": new Uint8Array(64),
    });
    const { manifest, stats } = await fixture.build(head, null, { maxAssets: 2, maxAssetBytes: 10 });
    expect(Object.keys(manifest.files).sort()).toEqual(["docs/a.png", "docs/b.png", "docs/huge.md", "docs/index.md"]);
    expect(manifest.files["docs/huge.md"]).toMatchObject({ error: "too-large" });
    expect(manifest.assetsTruncated).toBe(true);
    expect(stats.assets).toBe(2);
    const sized = setup({ pipeline });
    const sizedHead = sized.repo.commit({ "docs/index.md": "# Home\n", "docs/c.png": new Uint8Array(64) });
    expect((await sized.build(sizedHead, null, { maxAssetBytes: 10 })).manifest.files["docs/c.png"]).toMatchObject({ error: "too-large" });
    // Nothing oversized was downloaded.
    expect(sized.github.count("blob")).toBe(1);
  });

  it("reads the config files detection asks for, once per blob", async () => {
    const seen: Array<Map<string, string>> = [];
    const pipeline: ContentPipeline = {
      ...real, maxConfigBytes: 50,
      configFilesToRead: () => ["mkdocs.yml", "missing.yml", "huge.yml", "docs"],
      detect: (entries, configs) => {
        seen.push(new Map(configs));
        return real.detect(entries, configs);
      },
    };
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({ "mkdocs.yml": "docs_dir: docs\n", "huge.yml": "x".repeat(100), "docs/index.md": "# Home\n" });
    await fixture.build(head);
    expect(seen[0]).toEqual(new Map([["mkdocs.yml", "docs_dir: docs\n"]]));
    const next = fixture.repo.change({ "docs/index.md": "# Home 2\n" });
    fixture.github.resetLog();
    await fixture.build(next);
    // The config blob is unchanged, so it comes from storage.
    expect(fixture.github.count("blob")).toBe(1);
  });

  it("records pages that detection lists but the tree lacks, and roots outside the tree", async () => {
    const pipeline = withDocSet((docSet) => ({ ...docSet, root: "nowhere", pages: [...docSet.pages, "docs/ghost.md", "docs"] }));
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n" });
    const { manifest } = await fixture.build(head);
    expect(manifest.docs?.rootTree).toBeNull();
    expect(manifest.files["docs/ghost.md"]).toEqual({ sha: "", size: 0, error: "missing" });
    expect(manifest.files.docs).toMatchObject({ error: "missing" });
  });

  it("treats a blob listed without a size as empty, and fetches a blob shared by a page and an asset once", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n", "docs/empty.md": "", "docs/empty.svg": "" });
    const listing = await fixture.source.getTree(fixture.repo.ref, head, true);
    fixture.github.fault(/git\/trees/, () => Response.json({ sha: listing.sha, truncated: false, tree: listing.entries.map(({ size: _size, ...entry }) => entry) }));
    fixture.github.resetLog();
    const { manifest } = await fixture.build(head);
    expect(manifest.files["docs/index.md"]).toMatchObject({ size: 0, title: "Home" });
    expect(manifest.files["docs/empty.svg"]).toMatchObject({ size: 0 });
    expect(fixture.github.count("blob")).toBe(2);
  });

  it("uses the commit's root tree for a docs root at the repository root", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ "README.md": "# Readme\n" });
    const { manifest } = await fixture.build(head);
    expect(manifest.docs).toMatchObject({ root: "", rootTree: manifest.tree, entry: "README.md" });
  });

  it("seals private-repository content through the encryption hook", async () => {
    const sealer: ContentSealer = {
      seal: (_scope, bytes) => Promise.resolve(new Uint8Array([0xff, ...bytes])),
      open: (_scope, bytes) => Promise.resolve(bytes.slice(1)),
    };
    const fixture = setup({ private: true, sealer });
    const head = fixture.repo.commit({ "docs/index.md": "# Secret\n" });
    const { manifest } = await fixture.build(head);
    const stored = fixture.bucket.objects.get(manifestKey(11, head, RV))?.bytes as Uint8Array;
    expect(stored[0]).toBe(0xff);
    expect(fixture.bucket.objects.get(blobKey(11, manifest.files["docs/index.md"].sha))?.bytes[0]).toBe(0xff);
    expect((await fixture.content.getJson<SnapshotManifest>(manifestKey(11, head, RV)))?.commit).toBe(head);
  });
});

describe("buildSnapshot: page failures", () => {
  it("records expected render failures and carries on", async () => {
    const pipeline: ContentPipeline = { ...real, render: (source, path) => {
      if (path.endsWith("bad.md")) return Promise.reject(new PageRenderError("too deep", "too-deep"));
      return real.render(source, path);
    } };
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n", "docs/bad.md": "# Bad\n" });
    const { manifest, stats } = await fixture.build(head);
    expect(manifest.files["docs/bad.md"]).toMatchObject({ error: "too-deep", render: expect.any(String) as unknown });
    expect(stats.rendered).toBe(1);
    // The failure is cached at the render key, so the page is not rendered again:
    // not from the previous manifest, and not when the same blob reappears elsewhere in the directory.
    const attempts = vi.fn((_source: string, _path: string) => {});
    const counting: ContentPipeline = { ...pipeline, render: (source, path) => { attempts(source, path); return pipeline.render(source, path); } };
    const next = fixture.repo.change({ "docs/index.md": "# Home 2\n", "docs/copy-of-bad.md": "# Bad\n" });
    const second = await fixture.build(next, manifest, undefined, counting);
    expect(second.manifest.files["docs/bad.md"]).toMatchObject({ error: "too-deep" });
    expect(second.manifest.files["docs/copy-of-bad.md"]).toMatchObject({ error: "too-deep" });
    expect(attempts.mock.calls.map(([, path]) => path)).toEqual(["docs/index.md"]);
  });

  it("stores an empty outline for pipelines without headings", async () => {
    const pipeline: ContentPipeline = { ...real, render: (source) => Promise.resolve({ html: `<p>${source.length}</p>`, title: "T" }) };
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n" });
    const { manifest } = await fixture.build(head);
    expect(await fixture.content.getJson(renderObjectKey(11, manifest.files["docs/index.md"].render as string))).toEqual({ html: "<p>7</p>", title: "T", headings: [] });
  });

  it("fails the build on an unexpected render error, writing no manifest", async () => {
    const pipeline: ContentPipeline = { ...real, render: () => Promise.reject(new Error("renderer bug")) };
    const fixture = setup({ pipeline });
    const head = fixture.repo.commit({ "docs/index.md": "# Home\n" });
    await expect(fixture.build(head)).rejects.toThrow("renderer bug");
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(false);
  });
});

describe("buildSnapshot: incremental", () => {
  async function imported(pipeline?: ContentPipeline) {
    const fixture = setup({ pipeline });
    const first = fixture.repo.commit({ ...docsRepoFiles({ pages: 8, images: 2 }), "docs/old/moved.md": "# Moved\n", "docs/img/moved.png": "png" });
    const previous = (await fixture.build(first)).manifest;
    fixture.github.resetLog();
    return { ...fixture, previous };
  }

  it("fetches and renders only what changed", async () => {
    const fixture = await imported();
    const next = fixture.repo.change({ "docs/page-1.md": "# Edited\n", "docs/img/new.png": "new", "docs/page-2.md": null });
    const { manifest, stats } = await fixture.build(next, fixture.previous);
    expect(stats).toMatchObject({ mode: "blobs", rendered: 1, blobRequests: 2 });
    expect(stats.reusedRenders).toBe(stats.pages - 1);
    expect(fixture.github.count("blob")).toBe(2);
    expect(fixture.github.count("tarball")).toBe(0);
    expect(manifest.files["docs/page-1.md"].title).toBe("Edited");
    expect(manifest.files["docs/page-2.md"]).toBeUndefined();
  });

  it("moves files without fetching anything (a page in another directory re-renders from storage)", async () => {
    const fixture = await imported();
    const next = fixture.repo.change({
      "docs/old/moved.md": null, "docs/new/moved.md": "# Moved\n", "docs/img/moved.png": null, "docs/img2/moved.png": "png",
    });
    const { manifest, stats } = await fixture.build(next, fixture.previous);
    expect(fixture.github.count("blob")).toBe(0);
    // Relative links resolve against the directory, so the moved page renders again; the image is reused as is.
    expect(stats).toMatchObject({ rendered: 1, mode: "none" });
    expect(manifest.files["docs/new/moved.md"]).toMatchObject({ title: "Moved" });
  });

  it("reuses the previous snapshot wholesale when nothing under the docs root changed", async () => {
    const fixture = await imported();
    const next = fixture.repo.change({ "src/module-0.ts": "changed" });
    const order = putOrder(fixture);
    const { manifest, stats } = await fixture.build(next, fixture.previous);
    expect(stats).toMatchObject({ mode: "unchanged", reusedRenders: stats.pages, assets: 3 });
    expect(manifest.files).toEqual(fixture.previous.files);
    expect(manifest.sidebar).toBe(fixture.previous.sidebar);
    expect(fixture.github.count("blob")).toBe(0);
    expect(order).toEqual([manifestKey(11, next, RV)]);
  });

  it("does not take the shortcut when detection or the renderer changed", async () => {
    const variants: Array<[string, (docSet: PipelineDocSet) => PipelineDocSet]> = [
      ["root", (docSet) => ({ ...docSet, root: "docs/img" })],
      ["entry", (docSet) => ({ ...docSet, entry: "docs/page-1.md" })],
      ["kind", (docSet) => ({ ...docSet, kind: "mixed" })],
      ["truncated", (docSet) => ({ ...docSet, truncated: true })],
      ["pages", (docSet) => ({ ...docSet, pages: docSet.pages.slice(1) })],
    ];
    for (const [name, change] of variants) {
      const fixture = await imported();
      const next = fixture.repo.change({ "src/module-0.ts": `changed ${name}` });
      const { stats } = await fixture.build(next, fixture.previous, undefined, withDocSet(change));
      expect(stats.mode, name).not.toBe("unchanged");
    }
    const noDocs = await imported();
    const next = noDocs.repo.change({ "src/module-0.ts": "changed" });
    expect((await noDocs.build(next, { ...noDocs.previous, docs: null })).stats.mode).not.toBe("unchanged");
    expect((await noDocs.build(next, { ...noDocs.previous, docs: { ...noDocs.previous.docs, rootTree: "x" } as SnapshotManifest["docs"] })).stats.mode).not.toBe("unchanged");
    const outside = await imported(withDocSet((docSet) => ({ ...docSet, root: "nowhere" })));
    const outsideNext = outside.repo.change({ "src/module-0.ts": "changed" });
    expect((await outside.build(outsideNext, outside.previous)).stats.mode).not.toBe("unchanged");
  });

  it("re-renders after a renderer change from stored blobs, without GitHub", async () => {
    const fixture = await imported();
    const bumped: ContentPipeline = { ...real, rendererVersion: RV + 1, renderKey: async (sha, path) => (await real.renderKey(sha, path)).replace(/^render\/v\d+/, `render/v${RV + 1}`) };
    const head = fixture.repo.head();
    const { manifest, stats } = await fixture.build(head, fixture.previous, undefined, bumped);
    expect(manifest.rendererVersion).toBe(RV + 1);
    expect(stats).toMatchObject({ rendered: stats.pages, blobRequests: 0, mode: "none" });
    expect(fixture.github.count("blob")).toBe(0);
  });
});

describe("buildSnapshot: archive failures fall back to per-blob requests", () => {
  async function firstImport(prepare: (fixture: ReturnType<typeof setup>, head: string) => void) {
    const fixture = setup();
    const head = fixture.repo.commit({ ...docsRepoFiles({ pages: 40, images: 4 }), "docs/dup.md": "# Home\n\nWelcome.\n" });
    prepare(fixture, head);
    const result = await fixture.build(head);
    expect(Object.values(result.manifest.files).every((file) => !file.error)).toBe(true);
    expect(Object.keys(result.manifest.files)).toHaveLength(46);
    return { ...fixture, ...result };
  }

  it("when the archive endpoint fails", async () => {
    const { stats, github } = await firstImport(({ github }) => github.fault(/tarball/, () => new Response("down", { status: 503 }), 3));
    expect(stats).toMatchObject({ mode: "tarball", tarballFallback: true, tarballError: "GitHubError", tarballBlobs: 0, blobRequests: 45 });
    expect(github.count("blob")).toBe(45);
  });

  it("when the download is cut off mid-stream", async () => {
    const { stats } = await firstImport(({ repo }) => { repo.archiveCut = 0.5; });
    expect(stats.tarballFallback).toBe(true);
    expect(stats.tarballBlobs).toBeGreaterThan(0);
    expect(stats.tarballBlobs + stats.blobRequests).toBe(45);
  });

  it("when archive bytes differ from the blobs (export-subst, LFS)", async () => {
    const { stats } = await firstImport(({ repo }) => {
      repo.archiveTransform = (path, content) => {
        // export-subst output of another length, and LFS-style bytes of the same length.
        if (path === "docs/page-4.md") return new TextEncoder().encode("$Format:%H$");
        if (path === "docs/page-8.md") return content.map((byte, index) => (index === 0 ? byte ^ 1 : byte));
        return content;
      };
    });
    expect(stats).toMatchObject({ tarballFallback: false, tarballBlobs: 43, blobRequests: 2 });
  });

  it("when the archive is for another commit", async () => {
    const { stats } = await firstImport(({ repo }) => { repo.archiveComment = "f".repeat(40); });
    expect(stats).toMatchObject({ tarballFallback: true, tarballError: "TarError", tarballBlobs: 0, blobRequests: 45 });
  });

  it("when something other than an Error is thrown", async () => {
    const { stats } = await firstImport(({ github }) => github.fault(/legacy\.tar\.gz/, () => new Response(new ReadableStream({ start(controller) { controller.error("odd"); } }))));
    expect(stats).toMatchObject({ tarballFallback: true, tarballError: "unknown" });
  });
});

describe("buildSnapshot: crash and retry", () => {
  it("leaves no manifest after a crash, and the retry reuses what was written", async () => {
    const fixture = setup();
    const head = fixture.repo.commit(docsRepoFiles({ pages: 12, images: 3 }));
    let puts = 0;
    fixture.bucket.failPut = () => ++puts > 9;
    await expect(fixture.build(head)).rejects.toThrow("R2 put failed");
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(false);
    const fetchedBefore = fixture.github.count("blob");
    fixture.bucket.failPut = null;
    fixture.github.resetLog();
    const { stats } = await fixture.build(head);
    expect(stats.blobRequests).toBeLessThan(fetchedBefore + 1);
    expect(stats.blobRequests + stats.reusedRenders).toBeLessThanOrEqual(16);
    expect(await fixture.content.has(manifestKey(11, head, RV))).toBe(true);
  });
});
