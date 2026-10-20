/**
 * Reading ingested snapshots (#229's key schema) on the hot path (#234).
 *
 * Read order for every immutable object (manifest, sidebar, rendered page,
 * asset blob): this isolate's memory, then — for public repositories — the
 * cacheable signed subrequest (#242, which feeds the colo cache and every tier
 * above it) — then the colo's `caches.default`, then R2. Every key names
 * immutable bytes (commit, render key or blob SHA), so nothing is ever
 * invalidated. The ref pointer is the one mutable object: it is served from
 * memory for five seconds, then stale-while-revalidate for a minute, and read
 * from R2 otherwise.
 *
 * Every read takes a `RepoGrant`: authorization has already happened. Edge
 * cache keys sit under a reserved path of the Worker's own origin that no
 * route serves, so the only way to reach an entry is this module, after a
 * grant. Bytes are cached as stored and opened per read, after authorization
 * (#263): a private repository's edge entries are sealed, and only bytes that
 * opened under the current key are cached (under that key's ID), so an entry
 * never outlives the key that opens it. Content that does not open is a
 * retryable 503, never served.
 */
import { isGitObjectId } from "@/ingest/github/git-objects";
import { RENDERER_VERSION } from "@/ingest/limits";
import type { RefPointer } from "@/ingest/orchestrator/ingest";
import { blobKey, manifestKey, refKey, renderObjectKey, repoPrefix } from "@/ingest/orchestrator/keys";
import type { ManifestFile, RenderedObject, SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import { envelopeKeyId, isSealed, SealedContentError } from "@/ingest/orchestrator/sealing";
import type { ContentSealer, ObjectStore } from "@/ingest/orchestrator/store";
import type { SidebarIndex } from "@/ingest/sidebar";
import { ImmutableMetadataCache } from "@/immutable-cache";
import { logger } from "@/logger";
import { ViewerBackendError } from "@/viewer-backend";
import type { RepoGrant } from "./grant";
import type { SharedCacheReader } from "./shared-cache";
import { ReadTiming, type StorageTier } from "./timing";

/** The Workers Cache API surface used here. */
export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

export interface SnapshotDependencies {
  store: ObjectStore;
  sealer: ContentSealer;
  /** `caches.default`; null where there is none (Node). */
  edge: EdgeCache | null;
  /** The Worker's own origin: edge cache keys live under it. */
  origin: string;
  /**
   * Cacheable subrequests for public repository objects, or null where there is
   * none (Node, tests without one). Never consulted for private repositories.
   * Takes the repository id, so the reader can sign the URL with the
   * repository's current visibility epoch (#242).
   */
  shared: SharedCacheReader | null;
  waitUntil(promise: Promise<unknown>): void;
  now(): number;
  /** The request's `Server-Timing` record (#282): which tier answered, and how long each tier took. */
  timing?: ReadTiming;
}

/** Immutable snapshot objects, parsed, per isolate. Entries larger than 1 MiB are not kept. */
export const snapshotMemory = new ImmutableMetadataCache(16 * 1024 * 1024, 1024 * 1024);
const pointers = new Map<string, PointerEntry>();
const POINTER_FRESH_MS = 5_000;
const POINTER_STALE_MS = 60_000;
const MAX_POINTERS = 1_024;
const EDGE_PREFIX = "/__repo-cache/v1/";
const decoder = new TextDecoder();

type PointerEntry = { value: RefPointer | null; at: number; refresh: Promise<void> | null };

export function clearSnapshotMemory(): void {
  snapshotMemory.clear();
  pointers.clear();
}

/** A page is anything the renderer handles; everything else in a manifest is an asset. */
export function isPagePath(path: string): boolean {
  return /\.(?:md|markdown|mdx|html?)$/i.test(path);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    // A complete snapshot never holds malformed JSON: treat it as "could not read", not as absent.
    throw new ViewerBackendError();
  }
}

function validPointer(value: unknown, repoId: number): RefPointer {
  const pointer = value as Partial<RefPointer> | null;
  if (!pointer || pointer.repoId !== repoId || !isGitObjectId(pointer.commit)
    || !Number.isSafeInteger(pointer.rendererVersion) || (pointer.rendererVersion as number) < 0) throw new ViewerBackendError();
  return pointer as RefPointer;
}

function validManifest(value: unknown, repoId: number, commit: string): SnapshotManifest {
  const manifest = value as Partial<SnapshotManifest> | null;
  if (!manifest || manifest.schema !== 1 || manifest.repoId !== repoId || manifest.commit !== commit
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !(manifest.sidebar === null || typeof manifest.sidebar === "string")
    || !(manifest.docs === null || (typeof manifest.docs === "object" && typeof manifest.docs?.entry === "string"))) {
    throw new ViewerBackendError();
  }
  return manifest as SnapshotManifest;
}

export class RepoSnapshots {
  private readonly timing: ReadTiming;

  constructor(private readonly deps: SnapshotDependencies) {
    this.timing = deps.timing ?? new ReadTiming();
  }

  /** One read from `tier` on the request's own path, timed and noted as reached. */
  private reach<T>(tier: StorageTier, work: () => Promise<T>): Promise<T> {
    this.timing.served(tier);
    return this.timing.time(tier, work);
  }

  /**
   * Stored bytes, opened. A private repository's bytes must open; a public
   * one's are opened only when sealed (a repository made public keeps the
   * sealed content it had). Anything that does not open is never served.
   */
  private async open(grant: RepoGrant, key: string, stored: Uint8Array): Promise<Uint8Array> {
    if (!grant.repo.private && !isSealed(stored)) return stored;
    try {
      return await this.deps.sealer.open({ repoId: grant.repo.id, key }, stored);
    } catch (error) {
      if (!(error instanceof SealedContentError)) throw error;
      logger.error({ category: "SealedContent", repoId: grant.repo.id, reason: error.reason }, "Repository content did not open");
      throw new ViewerBackendError();
    }
  }

  /**
   * Where a grant's bytes sit in the edge cache: a public repository's under
   * the storage key, a private one's under the current key's ID, so an entry
   * sealed under a retired key is never looked up again.
   */
  private async edgeKey(grant: RepoGrant, key: string): Promise<{ cacheKey: string; keyId: string | null }> {
    if (!grant.repo.private) return { cacheKey: `${this.deps.origin}${EDGE_PREFIX}${key}`, keyId: null };
    let keyId: string | null;
    try {
      keyId = await this.deps.sealer.currentKeyId();
    } catch {
      throw new ViewerBackendError();
    }
    return { cacheKey: `${this.deps.origin}${EDGE_PREFIX}sealed/${keyId}/${key}`, keyId };
  }

  /**
   * Opened bytes: for a public repository first through the cacheable
   * subrequest (#242), then from the edge cache, else R2. The shared tier is
   * never consulted for a private repository, and sealed bytes (a repository
   * made public keeps its sealed content) are never taken from it: they are
   * read below and opened. The edge cache is filled in the background only
   * after the bytes opened, and only with what it may hold: plaintext for a
   * public repository, bytes sealed under the current key for a private one.
   */
  private async read(grant: RepoGrant, key: string): Promise<Uint8Array | null> {
    const { edge, shared } = this.deps;
    if (!grant.repo.private && shared) {
      const bytes = await this.timing.time("shared", () => shared(grant.repo.id, key));
      if (bytes && !isSealed(bytes)) {
        this.timing.served("shared");
        return bytes;
      }
    }
    const { cacheKey, keyId } = await this.edgeKey(grant, key);
    const hit = edge ? await this.timing.time("colo", async () => {
      const response = await edge.match(cacheKey);
      return response && new Uint8Array(await response.arrayBuffer());
    }) : undefined;
    if (hit) {
      this.timing.served("colo");
      return this.open(grant, key, hit);
    }
    const object = await this.reach("r2", () => this.deps.store.get(key));
    if (!object) return null;
    const opened = await this.open(grant, key, object.bytes);
    if (edge && (grant.repo.private ? envelopeKeyId(object.bytes) === keyId : !isSealed(object.bytes))) {
      const response = new Response(object.bytes as Uint8Array<ArrayBuffer>, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
      // A failed fill only costs the next reader an R2 read.
      this.deps.waitUntil(edge.put(cacheKey, response).catch(() => {}));
    }
    return opened;
  }

  /**
   * The bytes behind an immutable key straight from R2, with no cache layer and
   * no parse, for the shared-cache route (#242). That route is itself a cache
   * fill, so it must not call back into `stored`. The key was signed by this
   * Worker, which only signs public objects.
   */
  async raw(key: string): Promise<Uint8Array | null> {
    const bytes = (await this.deps.store.get(key))?.bytes ?? null;
    // Sealed content (a repository made public keeps it, #263) never enters a shared tier: the reader opens it from R2.
    return bytes && !isSealed(bytes) ? bytes : null;
  }

  private immutable<T>(grant: RepoGrant, key: string, parse: (bytes: Uint8Array) => T): Promise<T | null> {
    return snapshotMemory.get<T | null>(key, async () => {
      const bytes = await this.read(grant, key);
      if (!bytes) return { value: null, weight: null };
      return { value: parse(bytes), weight: bytes.byteLength };
    });
  }

  /**
   * The commit a branch serves, or null when the branch has never been
   * ingested. `fresh` bypasses the memoized answer (including a recent
   * "never ingested" miss): the first-view outcome of "ready" can land inside
   * that window while this reader is the one waiting for the pointer (#242).
   */
  async pointer(grant: RepoGrant, branch: string, fresh = false): Promise<RefPointer | null> {
    const key = refKey(grant.repo.id, branch);
    const now = this.deps.now();
    const entry = pointers.get(key);
    if (!fresh && entry && now - entry.at < POINTER_FRESH_MS) return entry.value;
    // Only the blocking read is the request's own; a background refresh is not on its path.
    const load = async (timed: boolean) => {
      const object = await (timed ? this.reach("r2", () => this.deps.store.get(key)) : this.deps.store.get(key));
      const value = object ? validPointer(parseJson(object.bytes), grant.repo.id) : null;
      pointers.delete(key);
      pointers.set(key, { value, at: this.deps.now(), refresh: null });
      if (pointers.size > MAX_POINTERS) pointers.delete(pointers.keys().next().value as string);
      return value;
    };
    if (!fresh && entry && now - entry.at < POINTER_STALE_MS) {
      // Stale while revalidate: one refresh per pointer; a failed one leaves the stale value in place.
      entry.refresh ??= load(false).then(() => {}, () => { entry.refresh = null; });
      this.deps.waitUntil(entry.refresh);
      return entry.value;
    }
    return load(true);
  }

  /**
   * The complete snapshot of `commit`. `rendererVersion` comes from a branch
   * pointer; a commit-pinned URL takes the current renderer's snapshot, or the
   * previous one while a renderer change is still being rebuilt.
   */
  async manifest(grant: RepoGrant, commit: string, rendererVersion?: number): Promise<SnapshotManifest | null> {
    const versions = rendererVersion === undefined ? [RENDERER_VERSION, RENDERER_VERSION - 1].filter(version => version >= 0) : [rendererVersion];
    for (const version of versions) {
      const manifest = await this.immutable(grant, manifestKey(grant.repo.id, commit, version), bytes => validManifest(parseJson(bytes), grant.repo.id, commit));
      if (manifest) return manifest;
    }
    return null;
  }

  async sidebar(grant: RepoGrant, manifest: SnapshotManifest): Promise<SidebarIndex | null> {
    const key = manifest.sidebar;
    if (key === null) return null;
    if (!key.startsWith(repoPrefix(grant.repo.id))) throw new ViewerBackendError();
    const sidebar = await this.immutable(grant, key, bytes => parseJson(bytes) as SidebarIndex);
    // The manifest names it, so it must exist.
    if (!sidebar || !Array.isArray(sidebar.nodes)) throw new ViewerBackendError();
    return sidebar;
  }

  /**
   * A rendered page, turned into what the frame serves by `derive` once per
   * isolate and kept in memory in that form (`variant` names the derivation).
   * The manifest names the object, so a missing or malformed one is a fault.
   */
  async page<T>(grant: RepoGrant, file: ManifestFile, variant: string, derive: (rendered: RenderedObject) => Promise<T>): Promise<T> {
    const key = renderObjectKey(grant.repo.id, file.render as string);
    const page = await snapshotMemory.get<T | null>(`${key}#${variant}`, async () => {
      const bytes = await this.read(grant, key);
      if (!bytes) return { value: null, weight: null };
      const value = parseJson(bytes) as { html?: unknown; error?: unknown } | null;
      if (!value || (typeof value.html !== "string" && typeof value.error !== "string")) throw new ViewerBackendError();
      return { value: await derive(value as RenderedObject), weight: bytes.byteLength };
    });
    if (page === null) throw new ViewerBackendError();
    return page;
  }

  /** Null when storage lost a blob the manifest lists. */
  asset(grant: RepoGrant, file: ManifestFile): Promise<Uint8Array | null> {
    return this.immutable(grant, blobKey(grant.repo.id, file.sha), bytes => bytes);
  }
}

/** The manifest entry for `path`, never an inherited property. */
export function manifestFile(manifest: SnapshotManifest, path: string): ManifestFile | null {
  return Object.hasOwn(manifest.files, path) ? manifest.files[path] : null;
}

/** Bound every storage read: a stalled store becomes a retryable 503 (`TimeoutError`), as on the other delivery routes. */
export function readDeadline(store: ObjectStore, timeoutMs: number): ObjectStore {
  return {
    ...store,
    async get(key) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DOMException("Storage read timed out", "TimeoutError")), timeoutMs);
      });
      try {
        return await Promise.race([store.get(key), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
