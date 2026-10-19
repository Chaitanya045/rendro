import { describe, expect, it } from "vitest";

import type { SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { searchManifest, MAX_SEARCH_LIMIT, MAX_SEARCH_QUERY_LENGTH } from "@/repo-read/search";
import type { SearchHit, SearchIndex } from "@/search/index";

const commit = "c".repeat(40);
const blob = (letter: string) => letter.repeat(40);

function manifest(files: Record<string, { sha: string; render?: string; error?: string }>): SnapshotManifest {
  return {
    schema: 1, repoId: 9, commit, tree: "t".repeat(40), rendererVersion: 2, createdAt: new Date(0).toISOString(),
    docs: null, docSets: [], sidebar: null, assetsTruncated: false,
    files: Object.fromEntries(Object.entries(files).map(([path, file]) => [path, { size: 10, ...file }])),
  };
}

function fakeIndex(hits: SearchHit[], errors = false): SearchIndex & { calls: Array<{ repoId: number; match: string; limit: number }> } {
  const calls: Array<{ repoId: number; match: string; limit: number }> = [];
  return {
    calls,
    migrate: () => Promise.resolve(),
    hasBlob: () => Promise.resolve(true),
    putBlob: () => Promise.resolve(),
    query: (repoId, match, limit) => {
      calls.push({ repoId, match, limit });
      if (errors) return Promise.reject(new Error("index down"));
      return Promise.resolve(hits.slice(0, limit));
    },
  };
}

const hit = (blobSha: string, slug: string, title = "Title"): SearchHit => ({ blobSha, slug, title, snippet: `text \u0002match\u0003` });

describe("searchManifest", () => {
  it("maps hits onto the served snapshot's pages by blob SHA and dedupes", async () => {
    const index = fakeIndex([hit(blob("a"), "intro"), hit(blob("a"), "intro"), hit(blob("b"), "usage")]);
    const outcome = await searchManifest(index, manifest({
      "docs/index.md": { sha: blob("a"), render: "render/v2/markdown/" + blob("a") + "/x" },
      "docs/usage.md": { sha: blob("b"), render: "render/v2/markdown/" + blob("b") + "/x" },
    }), "match");
    expect(outcome).toEqual({
      status: "ok",
      results: [
        { path: "docs/index.md", slug: "intro", title: "Title", snippet: "text \u0002match\u0003" },
        { path: "docs/usage.md", slug: "usage", title: "Title", snippet: "text \u0002match\u0003" },
      ],
      more: false,
    });
    expect(index.calls[0]).toEqual({ repoId: 9, match: '"match"', limit: 80 });
  });

  it("never leaks content from another commit: blobs absent from this manifest are dropped", async () => {
    const index = fakeIndex([hit(blob("old"), "intro"), hit(blob("new"), "intro"), hit(blob("asset"), "readme")]);
    const outcome = await searchManifest(index, manifest({
      "docs/index.md": { sha: blob("new"), render: "render/v2/markdown/" + blob("new") + "/x" },
      "img/logo.png": { sha: blob("asset") },
    }), "match");
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.results.map(result => result.path)).toEqual(["docs/index.md"]);
  });

  it("bounds the query length, the page size and the candidate fetch", async () => {
    const blobs = Array.from({ length: 10 }, (_, index) => blob(String(index)));
    const index = fakeIndex(blobs.map(blobSha => hit(blobSha, "slug")));
    const files = Object.fromEntries(blobs.map((blobSha, index) => [`docs/p${index}.md`, { sha: blobSha, render: "r" }]));
    const snapshot = manifest(files);
    expect(await searchManifest(index, snapshot, "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1))).toEqual({ status: "invalid" });
    expect(await searchManifest(index, snapshot, "x".repeat(MAX_SEARCH_QUERY_LENGTH)).then(outcome => outcome.status)).toBe("ok");

    for (const [raw, expected] of [[undefined, 20], ["", 1], ["abc", 20], ["0", 1], ["-5", 1], ["51", MAX_SEARCH_LIMIT], ["nan", 20], ["12.9", 12]] as const) {
      const outcome = await searchManifest(index, snapshot, "match", raw === undefined ? undefined : Number(raw));
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") expect(outcome.results).toHaveLength(Math.min(expected, 10));
    }
    expect(index.calls.at(-1)).toMatchObject({ match: '"match"' });
  });

  it("answers an empty query with no results and no index call", async () => {
    const index = fakeIndex([hit(blob("a"), "intro")]);
    const outcome = await searchManifest(index, manifest({ "docs/index.md": { sha: blob("a") } }), "  . * ");
    expect(outcome).toEqual({ status: "ok", results: [], more: false });
    expect(index.calls).toEqual([]);
  });

  it("reports more candidates when the fetch was truncated at the candidate bound", async () => {
    const files: Record<string, { sha: string; render: string }> = {};
    const hits: SearchHit[] = [];
    for (let index = 0; index < 80; index += 1) {
      const sha = blob(`${index % 10}`) + `${index}`.padStart(33, "x");
      files[`docs/p${index}.md`] = { sha, render: "r" };
      hits.push(hit(sha, "slug"));
    }
    const index = fakeIndex(hits);
    const outcome = await searchManifest(index, manifest(files), "match", 20);
    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") {
      expect(outcome.results).toHaveLength(20);
      expect(outcome.more).toBe(true);
    }
  });

  it("propagates index failures as 503-able errors, never empty results", async () => {
    const index = fakeIndex([], true);
    await expect(searchManifest(index, manifest({}), "match")).rejects.toThrow("index down");
  });
});
