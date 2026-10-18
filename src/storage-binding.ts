/**
 * Blob storage is Cloudflare R2, reached through the Worker's native bucket binding. There is no
 * endpoint and no access key anywhere: only code running in this Worker can touch the bucket.
 * These are the parts of the R2 binding API that Rendro uses.
 */
export const STORAGE_BINDING = "STORAGE";

export interface BucketObject {
  key: string;
  size: number;
  /** Unquoted entity tag (`httpEtag` is the quoted form). */
  etag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface BucketObjectBody extends BucketObject {
  body: ReadableStream<Uint8Array>;
  /** The slice actually returned, with `offset` and `length` always filled in. */
  range?: { offset?: number; length?: number };
}
export interface StorageBucket {
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<BucketObjectBody | null>;
  head(key: string): Promise<BucketObject | null>;
  put(
    key: string,
    value: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<BucketObject>;
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number; startAfter?: string }): Promise<{
    objects: BucketObject[];
    delimitedPrefixes: string[];
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

let bucket: StorageBucket | undefined;

/** True for an object that implements the bucket operations Rendro calls. */
function isBucket(value: unknown): value is StorageBucket {
  return typeof value === "object" && value !== null
    && ["get", "head", "put", "list", "delete"].every(name => typeof (value as Record<string, unknown>)[name] === "function");
}

/**
 * Selects the bucket for this isolate. The Worker calls it with `env.STORAGE` on every
 * request and scheduled run (the binding is isolate-wide, not request-scoped), and the local Node
 * server calls it once with a Miniflare bucket. A missing or malformed binding is cleared, so
 * every storage call fails closed.
 */
export function bindStorage(candidate: unknown): void {
  bucket = isBucket(candidate) ? candidate : undefined;
}

export function storage(): StorageBucket {
  if (!bucket) throw new Error(`Storage binding ${STORAGE_BINDING} is not configured`);
  return bucket;
}
