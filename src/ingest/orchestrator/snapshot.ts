import { matchesBlobId, toHex } from "../github/git-objects";
import type { GitHubSource, GitTreeEntry, RepoRef } from "../github/source";
import { readTar, TarError } from "../github/tar";
import { workPool } from "./concurrency";
import { blobKey, manifestKey, renderObjectKey, sidebarKey } from "./keys";
import { PageRenderError, type ContentPipeline, type PipelineDocSet, type PipelineTreeEntry } from "./pipeline";
import type { RepoContent } from "./store";
import { listCommitTree, type TreeListingOptions } from "./tree-listing";

export interface ManifestFile {
  sha: string;
  size: number;
  /**
   * Pages: the render key (below the repo prefix). The object there is a
   * RenderedObject: the output, or the cached reason it could not be rendered.
   */
  render?: string;
  title?: string | null;
  /** Why a page or asset has no stored output. */
  error?: string;
}

/**
 * Stored at a page's render key. Render failures are deterministic for a
 * given blob, directory and renderer version, so they are cached as well and
 * a hostile page is not re-rendered on every push.
 */
export type RenderedObject =
  | { html: string; title: string | null; headings: unknown[] }
  | { error: string };

export interface SnapshotDocs {
  root: string;
  /** The docs root's tree ID: unchanged means every file under it is unchanged. */
  rootTree: string | null;
  generator: string;
  signal: string;
  kind: string;
  entry: string;
  truncated: boolean;
  /** SHA-256 of the page list, to tell whether detection changed while the root tree did not. */
  pagesDigest: string;
}

export interface SnapshotManifest {
  schema: 1;
  repoId: number;
  commit: string;
  tree: string;
  rendererVersion: number;
  createdAt: string;
  docs: SnapshotDocs | null;
  /** Every detected doc set (monorepos have several); only the primary one is ingested. */
  docSets: Array<{ root: string; generator: string; kind: string; entry: string }>;
  files: Record<string, ManifestFile>;
  /** Full storage key of the sidebar; an unchanged docs tree reuses the previous commit's. */
  sidebar: string | null;
  assetsTruncated: boolean;
}

export interface TarballPolicy {
  /** Only a first import with at least this many missing blobs considers the archive. */
  minMissingBlobs: number;
  /** Archives of repositories larger than this are never downloaded. */
  maxRepoBytes: number;
  /** Below this size the archive is always cheaper than per-blob requests. */
  smallRepoBytes: number;
  /** Otherwise the missing docs must make up at least this share of the repository bytes. */
  minDocsShare: number;
}

export interface SnapshotOptions {
  tarball?: Partial<TarballPolicy>;
  maxAssetBytes?: number;
  maxAssets?: number;
  concurrency?: number;
  tree?: TreeListingOptions;
}

export type FetchMode = "unchanged" | "none" | "tarball" | "blobs";

export interface SnapshotStats {
  mode: FetchMode;
  walked: boolean;
  pages: number;
  assets: number;
  rendered: number;
  reusedRenders: number;
  /** Blobs read from GitHub one at a time (including tarball fallbacks). */
  blobRequests: number;
  /** Blobs taken from the archive. */
  tarballBlobs: number;
  tarballFallback: boolean;
  tarballError?: string;
}

export interface SnapshotContext {
  source: GitHubSource;
  content: RepoContent;
  repo: RepoRef;
  pipeline: ContentPipeline;
  now: () => number;
  options?: SnapshotOptions;
}

const DEFAULT_TARBALL: TarballPolicy = {
  minMissingBlobs: 32,
  maxRepoBytes: 512 * 1024 * 1024,
  smallRepoBytes: 16 * 1024 * 1024,
  minDocsShare: 0.25,
};
const SYMLINK_MODE = "120000";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type SizedEntry = GitTreeEntry & { size: number };

interface PendingPage {
  path: string;
  sha: string;
  size: number;
  key: string;
}

/**
 * Build the complete snapshot of `commitSha`: every rendered page, asset and
 * the sidebar are written first, the manifest last. Objects are immutable and
 * content-addressed, so a retry after a crash reuses whatever was written.
 * The caller flips the ref pointer only after this resolves.
 */
export async function buildSnapshot(context: SnapshotContext, commitSha: string, previous: SnapshotManifest | null): Promise<{ manifest: SnapshotManifest; stats: SnapshotStats }> {
  const { source, content, repo, pipeline } = context;
  const options = context.options ?? {};
  const listing = await listCommitTree(source, content, repo, commitSha, options.tree);
  const stats: SnapshotStats = {
    mode: "none", walked: listing.walked, pages: 0, assets: 0, rendered: 0, reusedRenders: 0, blobRequests: 0, tarballBlobs: 0, tarballFallback: false,
  };
  // Symlinks and submodules are never content. Every blob gets a size (GitHub always sends one).
  const usable: SizedEntry[] = listing.entries
    .filter((entry) => entry.type !== "commit" && entry.mode !== SYMLINK_MODE)
    .map((entry) => ({ ...entry, size: entry.size ?? 0 }));
  const byPath = new Map(usable.map((entry) => [entry.path, entry]));
  const pipelineEntries: PipelineTreeEntry[] = usable.map(({ path, type, sha, size }) => (type === "blob" ? { path, type, sha, size } : { path, type, sha }));

  const configs = new Map<string, string>();
  for (const path of pipeline.configFilesToRead(pipelineEntries)) {
    const entry = byPath.get(path);
    if (entry?.type !== "blob" || entry.size > pipeline.maxConfigBytes) continue;
    const bytes = await loadBlob(context, entry, pipeline.maxConfigBytes, stats);
    configs.set(path, decoder.decode(bytes));
  }
  const detection = pipeline.detect(pipelineEntries, configs);
  const manifest: SnapshotManifest = {
    schema: 1, repoId: repo.id, commit: commitSha, tree: listing.treeSha, rendererVersion: pipeline.rendererVersion,
    createdAt: new Date(context.now()).toISOString(), docs: null,
    docSets: detection.docSets.map(({ root, generator, kind, entry }) => ({ root, generator, kind, entry })),
    files: {}, sidebar: null, assetsTruncated: false,
  };
  const docSet = detection.primary;
  if (!docSet) {
    await content.putJson(manifestKey(repo.id, commitSha, pipeline.rendererVersion), manifest);
    return { manifest, stats };
  }

  const rootTree = docSet.root === "" ? listing.treeSha : byPath.get(docSet.root)?.sha ?? null;
  manifest.docs = {
    root: docSet.root, rootTree, generator: docSet.generator, signal: docSet.signal, kind: docSet.kind, entry: docSet.entry,
    truncated: docSet.truncated, pagesDigest: await digest(docSet.pages.join("\n")),
  };
  stats.pages = docSet.pages.length;

  if (previous && unchangedDocs(previous, manifest.docs, pipeline.rendererVersion)) {
    // Same docs tree, same detection, same renderer: nothing under the root changed.
    manifest.files = previous.files;
    manifest.sidebar = previous.sidebar;
    manifest.assetsTruncated = previous.assetsTruncated;
    stats.mode = "unchanged";
    stats.assets = Object.keys(previous.files).length - stats.pages;
    stats.reusedRenders = stats.pages;
    await content.putJson(manifestKey(repo.id, commitSha, pipeline.rendererVersion), manifest);
    return { manifest, stats };
  }

  const builder = new FileBuilder(context, previous, stats);
  await builder.plan(docSet, usable, byPath, options);
  manifest.assetsTruncated = builder.assetsTruncated;
  await builder.fetchMissing(commitSha, listing.walked, usable, options);
  manifest.files = builder.files;

  const titles = new Map(docSet.pages.map((path) => [path, builder.files[path]?.title ?? null]));
  const sidebar = sidebarKey(repo.id, commitSha, pipeline.rendererVersion);
  await content.putJson(sidebar, pipeline.sidebar(docSet, titles));
  manifest.sidebar = sidebar;
  // The completion marker: written only after everything above exists.
  await content.putJson(manifestKey(repo.id, commitSha, pipeline.rendererVersion), manifest);
  return { manifest, stats };
}

function unchangedDocs(previous: SnapshotManifest, docs: SnapshotDocs, rendererVersion: number): boolean {
  const before = previous.docs;
  return previous.rendererVersion === rendererVersion && before !== null && docs.rootTree !== null
    && before.rootTree === docs.rootTree && before.root === docs.root && before.entry === docs.entry
    && before.kind === docs.kind && before.truncated === docs.truncated && before.pagesDigest === docs.pagesDigest;
}

async function digest(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

async function loadBlob(context: SnapshotContext, entry: SizedEntry, maxBytes: number, stats: SnapshotStats): Promise<Uint8Array> {
  const key = blobKey(context.repo.id, entry.sha);
  const stored = await context.content.getBytes(key);
  if (stored) return stored;
  stats.blobRequests += 1;
  const bytes = await context.source.getBlob(context.repo, entry.sha, maxBytes);
  await context.content.putBytes(key, bytes);
  return bytes;
}

function underRoot(path: string, root: string): boolean {
  return root === "" || path.startsWith(`${root}/`);
}

/** Decides per file what can be reused, fetches the rest once per blob, and renders pages as their bytes arrive. */
class FileBuilder {
  readonly files: Record<string, ManifestFile> = {};
  assetsTruncated = false;
  /** Blob ID → pages waiting for its bytes. */
  private readonly waiting = new Map<string, PendingPage[]>();
  /** Blob ID → size and byte limit of blobs not yet in storage. */
  private readonly missing = new Map<string, { size: number; maxBytes: number }>();
  /** Blobs already in storage whose pages still need rendering. */
  private readonly storedPending = new Map<string, number>();
  private readonly maxAssetBytes: number;

  constructor(private readonly context: SnapshotContext, private readonly previous: SnapshotManifest | null, private readonly stats: SnapshotStats) {
    this.maxAssetBytes = context.options?.maxAssetBytes ?? 10 * 1024 * 1024;
  }

  async plan(docSet: PipelineDocSet, usable: readonly SizedEntry[], byPath: ReadonlyMap<string, SizedEntry>, options: SnapshotOptions): Promise<void> {
    const { pipeline, content, repo } = this.context;
    const before = this.previous?.files ?? {};
    const sameRenderer = this.previous?.rendererVersion === pipeline.rendererVersion;
    const knownAssets = new Set(Object.values(before).filter((file) => file.render === undefined && !file.error).map((file) => file.sha));
    const pages = new Set(docSet.pages);

    await workPool(docSet.pages, options.concurrency ?? 4, async (path) => {
      const entry = byPath.get(path);
      if (entry?.type !== "blob") {
        this.files[path] = { sha: entry?.sha ?? "", size: 0, error: "missing" };
        return;
      }
      const { size } = entry;
      if (size > pipeline.maxSourceBytes) {
        this.files[path] = { sha: entry.sha, size, error: "too-large" };
        return;
      }
      const key = await pipeline.renderKey(entry.sha, path);
      const prior = before[path];
      if (sameRenderer && prior?.render === key) {
        this.files[path] = prior.error === undefined ? { sha: entry.sha, size, render: key, title: prior.title } : { sha: entry.sha, size, render: key, error: prior.error };
        this.stats.reusedRenders += 1;
        return;
      }
      const rendered = await content.getJson<RenderedObject>(renderObjectKey(repo.id, key));
      if (rendered) {
        this.files[path] = "error" in rendered ? { sha: entry.sha, size, render: key, error: rendered.error } : { sha: entry.sha, size, render: key, title: rendered.title };
        this.stats.reusedRenders += 1;
        return;
      }
      const waiting = this.waiting.get(entry.sha) ?? [];
      waiting.push({ path, sha: entry.sha, size, key });
      this.waiting.set(entry.sha, waiting);
    });

    const maxAssets = options.maxAssets ?? 5000;
    const assets = usable.filter((entry) => entry.type === "blob" && underRoot(entry.path, docSet.root) && !pages.has(entry.path) && pipeline.isAsset(entry.path));
    if (assets.length > maxAssets) this.assetsTruncated = true;
    const kept = assets.slice(0, maxAssets);
    this.stats.assets = kept.length;
    await workPool(kept, options.concurrency ?? 4, async (entry) => {
      const { size } = entry;
      if (size > this.maxAssetBytes) {
        this.files[entry.path] = { sha: entry.sha, size, error: "too-large" };
        return;
      }
      this.files[entry.path] = { sha: entry.sha, size };
      if (knownAssets.has(entry.sha) || this.missing.has(entry.sha)) return;
      if (await content.has(blobKey(repo.id, entry.sha))) return;
      this.missing.set(entry.sha, { size, maxBytes: this.maxAssetBytes });
    });

    // Pages to render: their blob may already be stored (an interrupted attempt, a renderer bump),
    // which an R2 HEAD answers more cheaply than a GitHub request.
    await workPool([...this.waiting.keys()], options.concurrency ?? 4, async (sha) => {
      if (this.missing.has(sha)) return;
      const size = (this.waiting.get(sha) as PendingPage[])[0].size;
      if (await content.has(blobKey(repo.id, sha))) this.storedPending.set(sha, size);
      else this.missing.set(sha, { size, maxBytes: pipeline.maxSourceBytes });
    });
  }

  async fetchMissing(commitSha: string, walked: boolean, usable: readonly SizedEntry[], options: SnapshotOptions): Promise<void> {
    const { content, repo, source } = this.context;
    for (const sha of this.storedPending.keys()) {
      await this.arrived(sha, await content.getBytes(blobKey(repo.id, sha)) as Uint8Array, false);
    }
    if (this.missing.size === 0) return;
    if (this.useTarball(walked, usable, options)) {
      this.stats.mode = "tarball";
      try {
        await this.readTarball(commitSha);
      } catch (error) {
        // An expired link, a truncated stream, bad gzip or a rate limit: fetch what is still missing
        // one blob at a time. Deterministic failures (storage, rendering) recur there and fail the job.
        this.stats.tarballFallback = true;
        this.stats.tarballError = error instanceof Error ? error.name : "unknown";
      }
    } else {
      this.stats.mode = "blobs";
    }
    await workPool([...this.missing.entries()], options.concurrency ?? 4, async ([sha, { maxBytes }]) => {
      this.stats.blobRequests += 1;
      await this.arrived(sha, await source.getBlob(repo, sha, maxBytes), true);
    });
  }

  private useTarball(walked: boolean, usable: readonly SizedEntry[], options: SnapshotOptions): boolean {
    const policy = { ...DEFAULT_TARBALL, ...options.tarball };
    if (this.previous || walked || this.missing.size < policy.minMissingBlobs) return false;
    const repoBytes = usable.reduce((total, entry) => total + (entry.type === "blob" ? entry.size : 0), 0);
    if (repoBytes > policy.maxRepoBytes) return false;
    if (repoBytes <= policy.smallRepoBytes) return true;
    const missingBytes = [...this.missing.values()].reduce((total, blob) => total + blob.size, 0);
    return missingBytes / repoBytes >= policy.minDocsShare;
  }

  private async readTarball(commitSha: string): Promise<void> {
    const { source, repo } = this.context;
    const byPath = new Map<string, string>();
    for (const [sha] of this.missing) {
      for (const page of this.waiting.get(sha) ?? []) byPath.set(page.path, sha);
    }
    for (const [path, file] of Object.entries(this.files)) {
      if (this.missing.has(file.sha)) byPath.set(path, file.sha);
    }
    const largest = Math.max(...[...this.missing.values()].map((blob) => blob.maxBytes));
    let commentOk = true;
    const archive = await source.getTarball(repo, commitSha);
    for await (const entry of readTar(archive, {
      maxEntryBytes: largest,
      // GitHub prefixes every path with "<owner>-<repo>-<short sha>/".
      want: (path, size) => {
        const sha = byPath.get(path.slice(path.indexOf("/") + 1));
        return sha !== undefined && this.missing.get(sha)?.size === size;
      },
      onGlobalHeader: (attributes) => { commentOk = attributes.get("comment") === commitSha; },
    })) {
      if (!commentOk) throw new TarError("Archive is for a different commit");
      if (!entry.content) continue;
      const sha = byPath.get(entry.path.slice(entry.path.indexOf("/") + 1)) as string;
      // `want` only accepts blobs still missing. export-subst, LFS smudging or a line-ending
      // policy change the bytes: such files fall back to the blob API.
      if (!await matchesBlobId(entry.content, sha)) continue;
      this.stats.tarballBlobs += 1;
      await this.arrived(sha, entry.content, true);
    }
  }

  private async arrived(sha: string, bytes: Uint8Array, store: boolean): Promise<void> {
    const { content, repo, pipeline } = this.context;
    this.missing.delete(sha);
    if (store) await content.putBytes(blobKey(repo.id, sha), bytes);
    const pages = this.waiting.get(sha) ?? [];
    this.waiting.delete(sha);
    if (pages.length === 0) return;
    const source = decoder.decode(bytes);
    for (const page of pages) {
      let stored: RenderedObject;
      try {
        const rendered = pipeline.render(source, page.path);
        stored = { html: rendered.html, title: rendered.title, headings: rendered.headings ?? [] };
        this.files[page.path] = { sha, size: page.size, render: page.key, title: rendered.title };
        this.stats.rendered += 1;
      } catch (error) {
        if (!(error instanceof PageRenderError)) throw error;
        stored = { error: error.reason };
        this.files[page.path] = { sha, size: page.size, render: page.key, error: error.reason };
      }
      await content.putJson(renderObjectKey(repo.id, page.key), stored);
    }
  }
}
