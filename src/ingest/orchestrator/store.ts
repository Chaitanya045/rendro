import type { RepoRef } from "../github/source";

export interface StoredObject {
  bytes: Uint8Array;
  etag: string;
}

/** The object storage ingest needs: R2 in the Worker, an in-memory map in tests. */
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  has(key: string): Promise<boolean>;
  /** Returns false only when `ifMatch` is set and the stored ETag differs. */
  put(key: string, bytes: Uint8Array, options?: { contentType?: string; ifMatch?: string }): Promise<boolean>;
  list(prefix: string, cursor?: string | null): Promise<{ keys: string[]; cursor: string | null }>;
  /** Up to 1,000 keys at once (R2's limit); a missing key is not an error. */
  delete(keys: string[]): Promise<void>;
}

/** The subset of the Workers R2Bucket binding used here. */
export interface R2BucketLike {
  get(key: string): Promise<{ etag: string; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  head(key: string): Promise<{ etag: string } | null>;
  put(key: string, value: Uint8Array, options?: {
    httpMetadata?: { contentType?: string };
    onlyIf?: { etagMatches?: string };
  }): Promise<{ etag: string } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
  delete(keys: string[]): Promise<void>;
}

export function r2Store(bucket: R2BucketLike): ObjectStore {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object ? { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.etag } : null;
    },
    async has(key) {
      return await bucket.head(key) !== null;
    },
    async put(key, bytes, options = {}) {
      const result = await bucket.put(key, bytes, {
        httpMetadata: { contentType: options.contentType ?? "application/octet-stream" },
        ...(options.ifMatch ? { onlyIf: { etagMatches: options.ifMatch } } : {}),
      });
      return result !== null;
    },
    async list(prefix, cursor) {
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      return { keys: page.objects.map((object) => object.key), cursor: page.truncated && page.cursor ? page.cursor : null };
    },
    async delete(keys) {
      if (keys.length) await bucket.delete(keys);
    },
  };
}

export interface SealScope {
  repoId: number;
  key: string;
}

/**
 * Encryption hook for private-repository content: `envelopeSealer` (sealing.ts,
 * per-repository AES-256-GCM, #263) in the Workers; `plaintextSealer` stores
 * bytes as they are, for tests that look at the stored bytes.
 */
export interface ContentSealer {
  seal(scope: SealScope, plaintext: Uint8Array): Promise<Uint8Array>;
  /** Throws `SealedContentError` for anything that does not open: such bytes are never served. */
  open(scope: SealScope, stored: Uint8Array): Promise<Uint8Array>;
  /** The key ID new content is sealed with; null where content is stored as is. */
  currentKeyId(): Promise<string | null>;
}

export const plaintextSealer: ContentSealer = {
  seal: (_scope, plaintext) => Promise.resolve(plaintext),
  open: (_scope, stored) => Promise.resolve(stored),
  currentKeyId: () => Promise.resolve(null),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One repository's content objects. Private-repo bytes pass through the sealer both ways. */
export class RepoContent {
  constructor(
    readonly store: ObjectStore,
    private readonly repo: RepoRef,
    private readonly sealer: ContentSealer = plaintextSealer,
  ) {}

  has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    const object = await this.store.get(key);
    if (!object) return null;
    return this.repo.private ? this.sealer.open({ repoId: this.repo.id, key }, object.bytes) : object.bytes;
  }

  async putBytes(key: string, bytes: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const stored = this.repo.private ? await this.sealer.seal({ repoId: this.repo.id, key }, bytes) : bytes;
    await this.store.put(key, stored, { contentType });
  }

  async getJson<T>(key: string): Promise<T | null> {
    const bytes = await this.getBytes(key);
    return bytes ? JSON.parse(decoder.decode(bytes)) as T : null;
  }

  putJson(key: string, value: unknown): Promise<void> {
    return this.putBytes(key, encoder.encode(JSON.stringify(value)), "application/json");
  }
}

export async function readJson<T>(store: ObjectStore, key: string): Promise<{ value: T; etag: string } | null> {
  const object = await store.get(key);
  return object ? { value: JSON.parse(decoder.decode(object.bytes)) as T, etag: object.etag } : null;
}

export function writeJson(store: ObjectStore, key: string, value: unknown, ifMatch?: string): Promise<boolean> {
  return store.put(key, encoder.encode(JSON.stringify(value)), { contentType: "application/json", ...(ifMatch ? { ifMatch } : {}) });
}
