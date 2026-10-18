import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const objects = new Map<string, string>();
  const reads: Array<{ key: string; bytes: number }> = [];
  return {
    objects,
    reads,
    getObjectText: vi.fn((key: string) => {
      const value = objects.get(key) ?? null;
      reads.push({ key, bytes: value === null ? 0 : new TextEncoder().encode(value).byteLength });
      return Promise.resolve(value);
    }),
  };
});
vi.mock("../src/storage", () => ({ getObjectText: storage.getObjectText }));

import { ViewerBackendError } from "../src/viewer-backend";
import {
  INDEX_SHARD_TARGET_FILES,
  TREE_PAGE_SIZE,
  deploymentDocuments,
  deploymentIndexKey,
  deploymentIndexObjects,
  indexShardCount,
  openDeploymentIndex,
  validTreeDirectory,
} from "../src/deployment-index";
import { deploymentMetadataCache } from "../src/immutable-cache";
import type { DeploymentManifest, ManifestFile } from "../src/stored-manifest";

const SHA = "a".repeat(64);
const SALT = "0123456789abcdef0123456789abcdef";
const MANIFEST_KEY = "tenants/org/projects/project/deployments/deployment/manifest.json";
const INDEX = "tenants/org/projects/project/deployments/deployment/index/v1/";

function file(path: string, contentType = "text/html"): ManifestFile {
  return { path, sha256: SHA, size: 1, contentType };
}

function manifestOf(files: ManifestFile[]): DeploymentManifest {
  return { version: 1, files: [...files].sort((left, right) => left.path < right.path ? -1 : 1) };
}

/** Write a deployment exactly as deployment start does. */
async function store(manifest: DeploymentManifest, salt = SALT): Promise<void> {
  storage.objects.set(MANIFEST_KEY, JSON.stringify(manifest));
  const index = await deploymentIndexObjects(MANIFEST_KEY, manifest, SHA, salt);
  for (const shard of index!.shards) storage.objects.set(shard.key, shard.body);
  storage.objects.set(index!.root.key, index!.root.body);
}

function resetReads(): void {
  storage.reads.length = 0;
}

function readBytes(): number {
  return storage.reads.reduce((total, read) => total + read.bytes, 0);
}

/** Every path under `docs/section-N/` with 1,000 pages per section, plus one
 * stylesheet per section, so documents, folders and assets all scale. */
function synthetic(count: number): DeploymentManifest {
  const files: ManifestFile[] = [];
  for (let index = 0; index < count; index++) {
    const section = `docs/section-${String(Math.floor(index / 1_000)).padStart(3, "0")}`;
    files.push(index % 10 === 9 ? file(`${section}/style-${index}.css`, "text/css") : file(`${section}/page-${String(index).padStart(6, "0")}.html`));
  }
  return manifestOf(files);
}

beforeEach(() => {
  storage.objects.clear();
  resetReads();
  storage.getObjectText.mockClear();
});

describe("index layout", () => {
  it("chooses power-of-two shard counts from the file count", () => {
    expect([0, 1, INDEX_SHARD_TARGET_FILES, INDEX_SHARD_TARGET_FILES + 1, 1_000, 100_000, 1e12].map(indexShardCount))
      .toEqual([1, 1, 1, 2, 4, 512, 65_536]);
  });

  it("derives index keys only from deployment manifest keys", () => {
    expect(deploymentIndexKey(MANIFEST_KEY, "root.json")).toBe(`${INDEX}root.json`);
    for (const key of ["manifest", "manifest.json", "a//manifest.json", "../x/manifest.json", "a/manifest.json.bak"]) {
      expect(deploymentIndexKey(key, "root.json")).toBeNull();
    }
  });

  it("validates tree directories as canonical paths ending in a separator", () => {
    expect(["", "a/", "a/b c/", "%2e%2e/"].every(validTreeDirectory)).toBe(true);
    expect(["/", "a", "a//", "../", "a/../", "./", "a\\b/", "a\u0000/", `${"x".repeat(1_025)}/`].some(validTreeDirectory)).toBe(false);
  });

  it("refuses to build an index for a non-deployment key", async () => {
    expect(await deploymentIndexObjects("manifest", manifestOf([file("index.html")]), SHA)).toBeNull();
  });

  it("inlines small deployments in the root and shards larger ones", async () => {
    const small = await deploymentIndexObjects(MANIFEST_KEY, manifestOf([file("index.html")]), SHA, SALT);
    expect(small!.shards).toEqual([]);
    expect(JSON.parse(small!.root.body)).toEqual({
      version: 1, manifestSha256: SHA, fileCount: 1, salt: SALT, shards: 1, firstDocument: "index.html",
      files: [["index.html", SHA, 1, "text/html"]], tree: [["", 0, [["index.html", 0]], 0]],
    });
    const large = await deploymentIndexObjects(MANIFEST_KEY, synthetic(1_000), SHA, SALT);
    expect(large!.shards.map(shard => shard.key.slice(INDEX.length))).toEqual([
      "files/0.json", "files/1.json", "files/2.json", "files/3.json",
      "tree/0.json", "tree/1.json", "tree/2.json", "tree/3.json",
    ]);
    expect(JSON.parse(large!.root.body)).toEqual({ version: 1, manifestSha256: SHA, fileCount: 1_000, salt: SALT, shards: 4, firstDocument: "docs/section-000/page-000000.html" });
    const entries = large!.shards.slice(0, 4).map(shard => (JSON.parse(shard.body) as { files: unknown[] }).files.length);
    expect(entries.reduce((total, count) => total + count, 0)).toBe(1_000);
    // A random salt spreads entries evenly; no shard approaches the whole manifest.
    expect(Math.max(...entries)).toBeLessThan(2 * INDEX_SHARD_TARGET_FILES);
    const salted = await deploymentIndexObjects(MANIFEST_KEY, synthetic(1_000), SHA);
    expect(JSON.parse(salted!.root.body).salt).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.parse(salted!.root.body).salt).not.toBe(SALT);
  });
});

describe("index lookups", () => {
  it("serves exact paths, directory pages and the first document from an inline root", async () => {
    await store(manifestOf([file("guide/intro.html"), file("guide/a.css", "text/css"), file("index.html"), file("raw.txt", "text/plain"), file("page.htm", "text/html; charset=utf-8")]));
    const index = await openDeploymentIndex(MANIFEST_KEY);
    expect(index!.firstDocument).toBe("guide/intro.html");
    expect(await index!.file("guide/a.css")).toEqual(file("guide/a.css", "text/css"));
    for (const path of ["guide", "guide/", "Guide/intro.html", "guide/intro.html/", "./index.html", "index"]) expect(await index!.file(path)).toBeNull();
    expect(await index!.treePage("", 0)).toEqual({
      children: [{ name: "guide", type: "folder" }, { name: "index.html", type: "file" }, { name: "page.htm", type: "file" }], more: false,
    });
    expect(await index!.treePage("guide/", 0)).toEqual({ children: [{ name: "intro.html", type: "file" }], more: false });
    expect(await index!.treePage("guide/", 1)).toBeNull();
    expect(await index!.treePage("missing/", 0)).toBeNull();
    expect(storage.reads.map(read => read.key)).toEqual([`${INDEX}root.json`]);
  });

  it("orders folders first, then by collation with a stable code-point tie-break", async () => {
    // NFC and NFD spellings are distinct keys that collate equally.
    await store(manifestOf(["b.html", "B.html", "a/x.html", "é.html", "é.html", "Z/x.html", "z.html"].map(path => file(path))));
    const page = await (await openDeploymentIndex(MANIFEST_KEY))!.treePage("", 0);
    const names = page!.children.map(child => child.name);
    expect(names.slice(0, 2)).toEqual(["a", "Z"]);
    expect(names.indexOf("é.html")).toBe(names.indexOf("é.html") - 1);
    const reversed = await deploymentIndexObjects(MANIFEST_KEY, manifestOf(["é.html", "é.html"].map(path => file(path))), SHA, SALT);
    expect(JSON.parse(reversed!.root.body).tree[0][2].map(([name]: [string]) => name)).toEqual(["é.html", "é.html"]);
    // Historical unsorted manifests produce the same order.
    deploymentMetadataCache.clear();
    storage.objects.clear();
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: ["é.html", "é.html"].map(path => ({ path, contentType: "text/html" })) }));
    expect((await (await openDeploymentIndex(MANIFEST_KEY))!.treePage("", 0))!.children.map(child => child.name)).toEqual(["é.html", "é.html"]);
  });

  it("keeps a file and a folder with the same name as distinct, paged children", async () => {
    await store(manifestOf([file("a"), file("a/b.html")]));
    expect((await (await openDeploymentIndex(MANIFEST_KEY))!.treePage("", 0))!.children).toEqual([
      { name: "a", type: "folder" }, { name: "a", type: "file" },
    ]);
  });

  it("pages huge directories without reading unrelated pages", async () => {
    const count = 2 * TREE_PAGE_SIZE + 1;
    await store(manifestOf(Array.from({ length: count }, (_, index) => file(`page-${String(index).padStart(4, "0")}.html`))));
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    const first = await index.treePage("", 0);
    expect(first!.children).toHaveLength(TREE_PAGE_SIZE);
    expect(first!.more).toBe(true);
    expect((await index.treePage("", 2))!).toEqual({ children: [{ name: "page-0400.html", type: "file" }], more: false });
    expect(await index.treePage("", 3)).toBeNull();
  });

  it("reads one root and one shard for a sharded lookup, then serves hits from the isolate cache", async () => {
    await store(synthetic(1_000));
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    expect(await index.file("docs/section-000/style-9.css")).toEqual(file("docs/section-000/style-9.css", "text/css"));
    expect(storage.reads.map(read => read.key)).toEqual([`${INDEX}root.json`, expect.stringMatching(/files\/[0-3]\.json$/)]);
    expect(await index.file("docs/section-000/missing.html")).toBeNull();
    expect(await (await openDeploymentIndex(MANIFEST_KEY))!.file("docs/section-000/style-9.css")).not.toBeNull();
    const pages = await index.treePage("docs/section-000/", 4);
    expect(pages!.children).toHaveLength(100);
    expect(pages!.more).toBe(false);
    expect(storage.reads.every(read => !read.key.endsWith("manifest.json"))).toBe(true);
    expect(storage.reads.length).toBeLessThanOrEqual(1 + 2 * 4);
  });

  it("coalesces concurrent cold lookups of one shard", async () => {
    await store(synthetic(1_000));
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    resetReads();
    await Promise.all(Array.from({ length: 16 }, () => index.file("docs/section-000/page-000000.html")));
    expect(storage.reads).toHaveLength(1);
  });
});

describe("fallback to the authoritative manifest", () => {
  it("reads unindexed deployments from one cached manifest", async () => {
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: [{ path: "a.html", contentType: "text/html" }, { path: "a.html", contentType: "text/css" }, { path: "b.css", contentType: "text/css" }] }));
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    // Historical manifests keep first-match semantics for duplicate paths.
    expect(await index.file("a.html")).toEqual({ path: "a.html", contentType: "text/html" });
    expect(index.firstDocument).toBe("a.html");
    expect(await index.treePage("", 0)).toEqual({ children: [{ name: "a.html", type: "file" }], more: false });
    expect(await deploymentDocuments(MANIFEST_KEY)).toEqual(["a.html"]);
    expect(await index.file("missing.html")).toBeNull();
    expect(await index.treePage("missing/", 0)).toBeNull();
    await openDeploymentIndex(MANIFEST_KEY);
    expect(storage.reads.map(read => read.key)).toEqual([`${INDEX}root.json`, MANIFEST_KEY]);
  });

  it("uses the strict manifest parser for staging lookups", async () => {
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: [{ path: "a.html", contentType: "text/html" }] }));
    expect(await openDeploymentIndex(MANIFEST_KEY, "staging")).toBeNull();
    storage.objects.set(MANIFEST_KEY, JSON.stringify(manifestOf([file("a.html")])));
    expect(await (await openDeploymentIndex(MANIFEST_KEY, "staging"))!.file("a.html")).toEqual(file("a.html"));
  });

  it("does not retain a missing manifest, and reports unavailable (not absent) for readers without one", async () => {
    await expect(openDeploymentIndex(MANIFEST_KEY)).rejects.toBeInstanceOf(ViewerBackendError);
    await expect(deploymentDocuments(MANIFEST_KEY)).rejects.toBeInstanceOf(ViewerBackendError);
    await expect(openDeploymentIndex("manifest")).rejects.toBeInstanceOf(ViewerBackendError);
    // Staging keeps the absent answer: it decides whether a deployment can be started.
    expect(await openDeploymentIndex(MANIFEST_KEY, "staging")).toBeNull();
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: [] }));
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    expect(index.firstDocument).toBeNull();
    expect(await index.treePage("", 0)).toEqual({ children: [], more: false });
  });

  it("ignores invalid roots", async () => {
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: [{ path: "fallback.html", contentType: "text/html" }] }));
    const valid = { version: 1, manifestSha256: SHA, fileCount: 1, salt: SALT, shards: 1, firstDocument: "x.html", files: [], tree: [] };
    const roots: unknown[] = [
      "not json", [], null, 5, { ...valid, version: 2 }, { ...valid, manifestSha256: "x" }, { ...valid, salt: 1 }, { ...valid, salt: "short" },
      { ...valid, shards: "1" }, { ...valid, shards: 1.5 }, { ...valid, shards: 0 }, { ...valid, shards: 3 }, { ...valid, shards: 1 << 17 },
      { ...valid, firstDocument: "../x.html" }, { ...valid, firstDocument: 1 }, { ...valid, files: undefined }, { ...valid, tree: {} },
    ];
    for (const root of roots) {
      deploymentMetadataCache.clear();
      storage.objects.set(`${INDEX}root.json`, typeof root === "string" ? root : JSON.stringify(root));
      expect((await openDeploymentIndex(MANIFEST_KEY))!.firstDocument).toBe("fallback.html");
    }
    deploymentMetadataCache.clear();
    storage.objects.set(`${INDEX}root.json`, JSON.stringify(valid));
    expect((await openDeploymentIndex(MANIFEST_KEY))!.firstDocument).toBe("x.html");
  });

  it("rejects publisher-shaped hostile index rows and falls back", async () => {
    storage.objects.set(MANIFEST_KEY, JSON.stringify({ files: [{ path: "fallback.html", contentType: "text/html" }] }));
    const root = { version: 1, manifestSha256: SHA, fileCount: 1, salt: SALT, shards: 1, firstDocument: null };
    const good = ["a.html", SHA, 1, "text/html"];
    const page = ["", 0, [["a.html", 0]], 0];
    const files: unknown[] = [
      "rows", [["a.html"]], ["a.html"], [["../a.html", SHA, 1, "text/html"]], [["a/%2F/../b", SHA, 1, "text/html"]], [["a//b", SHA, 1, "text/html"]],
      [[1, SHA, 1, "text/html"]], [["a.html", "x", 1, "text/html"]], [["a.html", 1, 1, "text/html"]], [["a.html", SHA, "1", "text/html"]],
      [["a.html", SHA, -1, "text/html"]], [["a.html", SHA, 1, 1]], [["a.html", SHA, 1, "x".repeat(129)]], [[`${"a".repeat(1_025)}.html`, SHA, 1, "text/html"]], [["a\u0000.html", SHA, 1, "text/html"]], [good, good],
    ];
    const tree: unknown[] = [
      "rows", [["", 0, []]], ["page"], [["a", 0, [], 0]], [["../", 0, [], 0]], [[1, 0, [], 0]], [["", -1, [], 0]], [["", 0.5, [], 0]],
      [["", 0, {}, 0]], [["", 0, [], 2]], [["", 0, [["a/b", 0]], 0]], [["", 0, [["..", 1]], 0]], [["", 0, [["", 0]], 0]],
      [["", 0, [[1, 0]], 0]], [["", 0, [["a", 2]], 0]], [["", 0, [["a"]], 0]], [["", 0, ["a"], 0]], [page, page],
    ];
    for (const rows of files) {
      deploymentMetadataCache.clear();
      storage.objects.set(`${INDEX}root.json`, JSON.stringify({ ...root, files: rows, tree: [page] }));
      expect(await (await openDeploymentIndex(MANIFEST_KEY))!.file("fallback.html")).not.toBeNull();
    }
    for (const rows of tree) {
      deploymentMetadataCache.clear();
      storage.objects.set(`${INDEX}root.json`, JSON.stringify({ ...root, files: [good], tree: rows }));
      expect(await (await openDeploymentIndex(MANIFEST_KEY))!.file("fallback.html")).not.toBeNull();
    }
  });

  it("falls back per lookup when a shard is missing or damaged, without retaining the damage", async () => {
    await store(synthetic(1_000));
    const key = (await deploymentIndexObjects(MANIFEST_KEY, synthetic(1_000), SHA, SALT))!.shards;
    for (const damage of [null, "not json", JSON.stringify({ version: 2, files: [] }), JSON.stringify({ version: 1, files: "x" }), JSON.stringify({ version: 1, tree: [["", 0, [["a/b", 0]], 0]] })]) {
      deploymentMetadataCache.clear();
      await store(synthetic(1_000));
      for (const shard of key) {
        if (damage === null) storage.objects.delete(shard.key);
        else storage.objects.set(shard.key, damage);
      }
      const index = (await openDeploymentIndex(MANIFEST_KEY))!;
      expect(await index.file("docs/section-000/page-000000.html")).toEqual(file("docs/section-000/page-000000.html"));
      expect((await index.treePage("", 0))!.children).toEqual([{ name: "docs", type: "folder" }]);
      resetReads();
      await index.file("docs/section-000/page-000000.html");
      expect(storage.reads.map(read => read.key)).toEqual([expect.stringMatching(/files\/[0-3]\.json$/)]);
    }
    // A damaged shard of a deployment whose manifest is also gone cannot be checked: retryable, never "absent".
    deploymentMetadataCache.clear();
    storage.objects.delete(MANIFEST_KEY);
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    await expect(index.file("docs/section-000/page-000000.html")).rejects.toBeInstanceOf(ViewerBackendError);
    await expect(index.treePage("", 0)).rejects.toBeInstanceOf(ViewerBackendError);
    // Staging answers null there, as before.
    deploymentMetadataCache.clear();
    const staging = (await openDeploymentIndex(MANIFEST_KEY, "staging"))!;
    expect(await staging.file("docs/section-000/page-000000.html")).toBeNull();
    expect(await staging.treePage("", 0)).toBeNull();
  });
});

describe("shard-boundary collisions", () => {
  async function saltPlacing(paths: string[], same: boolean): Promise<string> {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const salt = attempt.toString(16).padStart(32, "0");
      const index = await deploymentIndexObjects(MANIFEST_KEY, manifestOf([...paths.map(path => file(path)), ...Array.from({ length: 300 }, (_, i) => file(`filler-${i}.css`, "text/css"))]), SHA, salt);
      const holders = paths.map(path => index!.shards.findIndex(shard => shard.key.includes("/files/") && JSON.parse(shard.body).files.some(([entry]: [string]) => entry === path)));
      if (holders.every(holder => holder === holders[0]) === same) return salt;
    }
    throw new Error("no salt found");
  }

  it("resolves exact paths whether near-identical paths share a shard or sit on either side of a boundary", async () => {
    const paths = ["a.html", "a.htm", "A.html", "a.html.css", "a%2Fb.html", "a/b.html"];
    for (const same of [true, false]) {
      deploymentMetadataCache.clear();
      storage.objects.clear();
      const salt = await saltPlacing(["a.html", "a.htm"], same);
      await store(manifestOf([...paths.map(path => file(path)), ...Array.from({ length: 300 }, (_, i) => file(`filler-${i}.css`, "text/css"))]), salt);
      const index = (await openDeploymentIndex(MANIFEST_KEY))!;
      for (const path of paths) expect((await index.file(path))!.path).toBe(path);
      for (const path of ["a.html/", "a", "a%252Fb.html", "a/b", "a/b.html/x"]) expect(await index.file(path)).toBeNull();
      expect((await index.treePage("a/", 0))!.children).toEqual([{ name: "b.html", type: "file" }]);
    }
  });
});

describe("request and byte budgets (#90)", () => {
  // Synthetic manifests only; no files are written to disk.
  it.each([10, 1_000, 100_000])("keeps per-asset and tree-page metadata work independent of file count at %i files", async count => {
    const manifest = synthetic(count);
    await store(manifest);
    const manifestBytes = new TextEncoder().encode(storage.objects.get(MANIFEST_KEY)!).byteLength;
    const path = manifest.files[manifest.files.length - 1].path;

    // Cold isolate: one asset lookup.
    deploymentMetadataCache.clear(); resetReads();
    expect(await (await openDeploymentIndex(MANIFEST_KEY))!.file(path)).not.toBeNull();
    const assetReads = storage.reads.length;
    const assetBytes = readBytes();
    expect(assetReads).toBe(count <= INDEX_SHARD_TARGET_FILES ? 1 : 2);
    expect(storage.reads.some(read => read.key === MANIFEST_KEY)).toBe(false);

    // Warm isolate: another path in a cached shard costs nothing.
    resetReads();
    await (await openDeploymentIndex(MANIFEST_KEY))!.file(path);
    expect(storage.reads).toHaveLength(0);

    // Cold isolate: the tree's root page.
    deploymentMetadataCache.clear(); resetReads();
    const root = await (await openDeploymentIndex(MANIFEST_KEY))!.treePage("", 0);
    expect(root!.children).toEqual([{ name: "docs", type: "folder" }]);
    const treeReads = storage.reads.length;
    const treeBytes = readBytes();

    // Deep link: root page, then each ancestor's first page only.
    deploymentMetadataCache.clear(); resetReads();
    const index = (await openDeploymentIndex(MANIFEST_KEY))!;
    for (const directory of ["", "docs/", "docs/section-000/"]) await index.treePage(directory, 0);
    const deepReads = storage.reads.length;
    expect(storage.reads.some(read => read.key === MANIFEST_KEY)).toBe(false);

    // Bounded independently of count: about one shard of entries per request.
    const perShardBound = 64 * 1024;
    expect(assetBytes).toBeLessThan(perShardBound);
    expect(treeBytes).toBeLessThan(perShardBound);
    expect(treeReads).toBeLessThanOrEqual(2);
    expect(deepReads).toBeLessThanOrEqual(4);
    if (count >= 1_000) expect(assetBytes * 3).toBeLessThan(manifestBytes);
  }, 120_000);

  it("makes a cold 1,000-file push read metadata linearly, not quadratically", async () => {
    const manifest = synthetic(1_000);
    await store(manifest);
    const manifestBytes = new TextEncoder().encode(storage.objects.get(MANIFEST_KEY)!).byteLength;
    resetReads();
    // Worst case: every upload lands on a cold isolate.
    for (const entry of manifest.files) {
      deploymentMetadataCache.clear();
      await (await openDeploymentIndex(MANIFEST_KEY, "staging"))!.file(entry.path);
    }
    const coldBytes = readBytes();
    expect(storage.reads.some(read => read.key === MANIFEST_KEY)).toBe(false);
    // The previous whole-manifest read per upload cost 1,000 manifests.
    expect(coldBytes * 3).toBeLessThan(1_000 * manifestBytes);
    // One warm isolate reads each object at most once for the whole push.
    deploymentMetadataCache.clear(); resetReads();
    for (const entry of manifest.files) await (await openDeploymentIndex(MANIFEST_KEY, "staging"))!.file(entry.path);
    expect(storage.reads).toHaveLength(1 + 4);
    expect(readBytes()).toBeLessThan(2 * manifestBytes);
  }, 120_000);
});
