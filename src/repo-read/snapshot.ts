/**
 * Reading ingested snapshots (#229's key schema) on the hot path (#234).
 *
 * Read order for every immutable object (manifest, sidebar, rendered page,
 * asset blob): this isolate's memory, then the colo's `caches.default`, then
 * R2. Every key names immutable bytes (commit, render key or blob SHA), so
 * nothing is ever invalidated. The ref pointer is the one mutable object: it
 * is served from memory for five seconds, then stale-while-revalidate for a
 * minute, and read from R2 otherwise.
 *
 * Every read takes a `RepoGrant`: authorization has already happened. Edge
 * cache keys sit under a reserved path of the Worker's own origin that no
 * route serves, so the only way to reach an entry is this module, after a
 * grant. Bytes are cached as stored and opened (P9 decrypts) per read.
 */
import { isGitObjectId } from "@/ingest/github/git-objects";
import { RENDERER_VERSION } from "@/ingest/limits";
import type { RefPointer } from "@/ingest/orchestrator/ingest";
import { blobKey, manifestKey, refKey, renderObjectKey, repoPrefix } from "@/ingest/orchestrator/keys";
import type { ManifestFile, RenderedObject, SnapshotManifest } from "@/ingest/orchestrator/snapshot";
import type { ContentSealer, ObjectStore } from "@/ingest/orchestrator/store";
import type { SidebarIndex } from "@/ingest/sidebar";
import { ImmutableMetadataCache } from "@/immutable-cache";
import { ViewerBackendError } from "@/viewer-backend";
import type { RepoGrant } from "./grant";

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
  waitUntil(promise: Promise<unknown>): void;
  now(): number;
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
  constructor(private readonly deps: SnapshotDependencies) {}

  private async open(grant: RepoGrant, key: string, stored: Uint8Array): Promise<Uint8Array> {
    return grant.repo.private ? this.deps.sealer.open({ repoId: grant.repo.id, key }, stored) : stored;
  }

  /** Stored bytes from the edge cache, else R2 (filling the edge cache in the background). */
  private async stored(key: string): Promise<Uint8Array | null> {
    const { edge } = this.deps;
    const cacheKey = `${this.deps.origin}${EDGE_PREFIX}${key}`;
    const hit = edge ? await edge.match(cacheKey) : undefined;
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const object = await this.deps.store.get(key);
    if (!object) return null;
    if (edge) {
      const response = new Response(object.bytes as Uint8Array<ArrayBuffer>, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } });
      // A failed fill only costs the next reader an R2 read.
      this.deps.waitUntil(edge.put(cacheKey, response).catch(() => {}));
    }
    return object.bytes;
  }

  private immutable<T>(grant: RepoGrant, key: string, parse: (bytes: Uint8Array) => T): Promise<T | null> {
    return snapshotMemory.get<T | null>(key, async () => {
      const stored = await this.stored(key);
      if (!stored) return { value: null, weight: null };
      const bytes = await this.open(grant, key, stored);
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
    const load = async () => {
      const object = await this.deps.store.get(key);
      const value = object ? validPointer(parseJson(object.bytes), grant.repo.id) : null;
      pointers.delete(key);
      pointers.set(key, { value, at: this.deps.now(), refresh: null });
      if (pointers.size > MAX_POINTERS) pointers.delete(pointers.keys().next().value as string);
      return value;
    };
    if (!fresh && entry && now - entry.at < POINTER_STALE_MS) {
      // Stale while revalidate: one refresh per pointer; a failed one leaves the stale value in place.
      entry.refresh ??= load().then(() => {}, () => { entry.refresh = null; });
      this.deps.waitUntil(entry.refresh);
      return entry.value;
    }
    return load();
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
      const stored = await this.stored(key);
      if (!stored) return { value: null, weight: null };
      const bytes = await this.open(grant, key, stored);
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
