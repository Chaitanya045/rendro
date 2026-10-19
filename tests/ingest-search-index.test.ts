import { describe, expect, it } from "vitest";

import { manifestKey, renderObjectKey } from "../src/ingest/orchestrator/keys";
import { RENDERER_VERSION } from "../src/ingest/limits";
import { contentPipeline } from "../src/ingest/orchestrator/content-pipeline";
import { buildSnapshot, type SnapshotManifest } from "../src/ingest/orchestrator/snapshot";
import { RepoContent } from "../src/ingest/orchestrator/store";
import type { PageSection } from "../src/ingest/sections";
import type { SearchIndex } from "../src/search/index";
import { TEST_RENDER_OPTIONS } from "./helpers/ingest-render";
import { docsRepoFiles, ingestFixture } from "./helpers/ingest-fixture";

const real = contentPipeline(TEST_RENDER_OPTIONS);

/** Records index writes; `hasBlob` answers from a set that survives `puts` resets. */
class RecordingSearchIndex implements SearchIndex {
  readonly puts: Array<{ repoId: number; blobSha: string; sections: readonly PageSection[] }> = [];
  readonly indexed = new Set<string>();
  hasBlobCalls = 0;

  migrate(): Promise<void> {
    return Promise.resolve();
  }
  hasBlob(repoId: number, blobSha: string): Promise<boolean> {
    this.hasBlobCalls += 1;
    return Promise.resolve(this.indexed.has(`${repoId}/${blobSha}`));
  }
  putBlob(repoId: number, blobSha: string, sections: readonly PageSection[]): Promise<void> {
    this.indexed.add(`${repoId}/${blobSha}`);
    this.puts.push({ repoId, blobSha, sections });
    return Promise.resolve();
  }
  query(): Promise<never[]> {
    return Promise.resolve([]);
  }
  deleteRepo(): Promise<number> {
    return Promise.resolve(0);
  }
}

function setup() {
  const fixture = ingestFixture();
  const repo = fixture.github.repo("octo", "docs", { id: 11 });
  const content = new RepoContent(fixture.store, repo.ref);
  const search = new RecordingSearchIndex();
  const build = (commit: string, previous: SnapshotManifest | null = null) =>
    buildSnapshot({ source: fixture.source, content, repo: repo.ref, pipeline: real, now: fixture.clock.now, search }, commit, previous);
  return { ...fixture, repo, content, search, build };
}

describe("snapshot indexing (repository search, #251)", () => {
  it("indexes every rendered page's sections on the first import and reuses rows on an unchanged push", async () => {
    const fixture = setup();
    const first = fixture.repo.commit(docsRepoFiles({ pages: 6 }));
    const { manifest } = await fixture.build(first);
    // Every renderable page indexed once; images and the README outside docs are not.
    const pages = Object.entries(manifest.files).filter(([, file]) => file.render !== undefined);
    expect(pages.length).toBeGreaterThan(3);
    expect(fixture.search.puts).toHaveLength(pages.length);
    expect(fixture.search.puts.every(put => put.repoId === 11 && put.sections.length > 0)).toBe(true);
    const home = fixture.search.puts.find(put => put.sections[0]?.title === "Home");
    expect(home?.sections.map(section => section.slug)).toContain("user-content-home");

    // A push that touches nothing: no render reused with a new key, no writes at all.
    fixture.search.puts.length = 0;
    const second = fixture.repo.commit(docsRepoFiles({ pages: 6 }));
    await fixture.build(second, manifest);
    expect(fixture.search.puts).toEqual([]);

    // One changed page: only its blob is re-indexed.
    const third = fixture.repo.commit({ ...docsRepoFiles({ pages: 6 }), "docs/page-1.md": "# Changed page\n\nNew searchable content.\n" });
    await fixture.build(third, manifest);
    expect(fixture.search.puts).toHaveLength(1);
    expect(fixture.search.puts[0].sections[0]).toMatchObject({ slug: "user-content-changed-page", title: "Changed page" });
  });

  it("reuses a moved page's rows while they exist, and re-indexes from the stored render when they do not", async () => {
    const fixture = setup();
    const source = docsRepoFiles({ pages: 3 })["docs/page-0.md"] as string;
    const first = fixture.repo.commit(docsRepoFiles({ pages: 3 }));
    const { manifest } = await fixture.build(first);
    const sha = manifest.files["docs/page-0.md"].sha;
    fixture.search.puts.length = 0;

    // The page moves: a new render key (new directory), a fresh render, one putBlob for the same blob
    // (the replacement page renders fresh and is indexed separately).
    const moved = fixture.repo.commit({ ...docsRepoFiles({ pages: 3 }), "docs/page-0.md": "# Gone\n", "docs/guide/moved.md": source });
    const { manifest: movedManifest } = await fixture.build(moved, manifest);
    expect(fixture.search.puts.filter(put => put.blobSha === sha)).toEqual([expect.objectContaining({ blobSha: sha, repoId: 11 })]);
    fixture.search.puts.length = 0;

    // Moving it back: its original render object is reused, and its rows are reused with it
    // (the replacement page renders fresh and is indexed separately).
    const back = fixture.repo.commit({ ...docsRepoFiles({ pages: 3 }), "docs/page-0.md": source, "docs/guide/moved.md": "# Moved gone\n" });
    const { manifest: backManifest } = await fixture.build(back, movedManifest);
    expect(fixture.search.puts.find(put => put.blobSha === sha)).toBeUndefined();
    expect(fixture.search.hasBlobCalls).toBeGreaterThan(0);

    // A purged or never-written index is refilled from the reused render (the HTML the current renderer wrote).
    fixture.search.indexed.clear();
    const forth = fixture.repo.commit({ ...docsRepoFiles({ pages: 3 }), "docs/page-0.md": "# Gone\n", "docs/guide/moved.md": source });
    await fixture.build(forth, backManifest);
    const refill = fixture.search.puts.find(put => put.blobSha === sha);
    expect(refill?.sections[0]).toMatchObject({ title: "Page 0" });
  });
  it("indexes nothing when the pipeline provides no sections", async () => {
    const bare = { ...real, render: async (source: string, path: string) => ({ ...(await real.render(source, path)), sections: undefined }) };
    const fixture = ingestFixture({ pipeline: bare });
    const repo = fixture.github.repo("octo", "docs", { id: 11 });
    const content = new RepoContent(fixture.store, repo.ref);
    const search = new RecordingSearchIndex();
    const head = repo.commit(docsRepoFiles({ pages: 3 }));
    const { manifest } = await buildSnapshot({ source: fixture.source, content, repo: repo.ref, pipeline: bare, now: fixture.clock.now, search }, head, null);
    expect(Object.values(manifest.files).some(file => file.render !== undefined)).toBe(true);
    expect(search.puts).toEqual([]);
  });

  it("indexes nothing when no index is bound", async () => {
    const fixture = ingestFixture();
    const repo = fixture.github.repo("octo", "docs", { id: 11 });
    const content = new RepoContent(fixture.store, repo.ref);
    const head = repo.commit(docsRepoFiles({ pages: 2 }));
    const { manifest } = await buildSnapshot({ source: fixture.source, content, repo: repo.ref, pipeline: real, now: fixture.clock.now }, head, null);
    expect(manifest.files["docs/index.md"].render).toBeDefined();
  });

  it("does not index pages that failed to render", async () => {
    const fixture = setup();
    const head = fixture.repo.commit({ ...docsRepoFiles({ pages: 2 }), "docs/huge.md": "x".repeat(1024 * 1024 + 1) });
    const { manifest } = await fixture.build(head);
    expect(manifest.files["docs/huge.md"]).toMatchObject({ error: "too-large" });
    const huge = fixture.search.puts.find(put => put.blobSha === manifest.files["docs/huge.md"].sha);
    expect(huge).toBeUndefined();
  });

  it("keeps renders and index writes consistent: the render object is stored before its sections", async () => {
    const fixture = setup();
    const head = fixture.repo.commit(docsRepoFiles({ pages: 2 }));
    await fixture.build(head);
    const { manifest } = await fixture.build(head);
    const sha = manifest.files["docs/index.md"].sha;
    const render = manifest.files["docs/index.md"].render as string;
    const stored = await fixture.content.getJson<{ html: string }>(renderObjectKey(11, render));
    expect(stored?.html).toContain("Welcome");
    expect(await fixture.search.hasBlob(11, sha)).toBe(true);
    expect(manifest.commit).toBe(head);
    expect(manifestKey(11, head, RENDERER_VERSION)).toContain(`snapshot/${head}/r${RENDERER_VERSION}`);
  });
});
