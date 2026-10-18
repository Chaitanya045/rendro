import { transientStorageFault } from "@/storage-fault";
import { storage } from "@/storage-binding";

export { bindStorage, STORAGE_BINDING, type BucketObject, type BucketObjectBody, type StorageBucket } from "@/storage-binding";

const MAX_ATTEMPTS = 3; // Included in the bounded commit subrequest budget.
const RETRY_DELAY_MS = 100;

/** Rejects with the signal's reason once it fires. The binding has no cancellation, so a started operation may still complete. */
function abortable<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return run();
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    // The caller's own abort reason, unchanged (for a lease deadline, its TimeoutError).
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    run().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Runs an idempotent storage operation, replaying it after a transient fault (never after the caller's own abort). */
async function retried<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await abortable(run, signal);
    } catch (error: unknown) {
      if (attempt >= MAX_ATTEMPTS || signal?.aborted || !transientStorageFault(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

/** How long a read may wait on storage before it counts as a failure (a retryable 503 for readers). */
export const STORAGE_READ_TIMEOUT_MS = 10_000;

/**
 * Runs a storage read, replays included, under one deadline. Expiry surfaces as a `TimeoutError`, which
 * `transientStorageFault` classifies as retryable; the timer never outlives the read. The binding cannot cancel
 * an operation already started, so a late answer is simply dropped.
 */
async function withReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_READ_TIMEOUT_MS);
  try {
    return await read(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new DOMException("Storage read timed out", "TimeoutError");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface DocEntry {
  key: string;
  name: string;
  size: number;
  lastModified: Date;
}

/**
 * List only immediate children (one level deep). Returns files and folder
 * markers without recursing into subdirectories. Used for tree UI.
 */
export async function listImmediate(
  prefix: string,
  opts?: { maxKeys?: number; startAfter?: string },
): Promise<{ entries: DocEntry[]; isTruncated: boolean; nextStartAfter?: string }> {
  const entries: DocEntry[] = [];

  const res = await retried(() => storage().list({
    prefix,
    delimiter: "/",
    limit: opts?.maxKeys ?? 1000,
    startAfter: opts?.startAfter,
  }));

  for (const obj of res.objects) {
    if (obj.key === prefix || !obj.key.endsWith(".html")) continue;
    entries.push({ key: obj.key, name: obj.key.slice(prefix.length), size: obj.size, lastModified: obj.uploaded });
  }

  for (const folder of res.delimitedPrefixes) {
    entries.push({
      key: folder,
      name: folder.slice(prefix.length).replace(/\/$/, ""),
      size: 0,
      lastModified: new Date(0),
    });
  }

  return {
    entries,
    isTruncated: res.truncated,
    nextStartAfter: res.truncated ? entries[entries.length - 1]?.key : undefined,
  };
}

/**
 * Build a tree structure from listed objects.
 */
export interface DocTree {
  name: string;
  path: string;
  type: "file" | "folder";
  children: DocTree[];
  size?: number;
  lastModified?: Date;
}

export function buildTree(entries: DocEntry[], prefix: string): DocTree[] {
  const root: DocTree[] = [];

  for (const entry of entries) {
    const relative = entry.key.slice(prefix.length).replace(/^\//, "");
    const parts = relative.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        current.push({
          name: part,
          path: entry.key,
          type: "file",
          children: [],
          size: entry.size,
          lastModified: entry.lastModified,
        });
      } else {
        let folder = current.find((n) => n.name === part && n.type === "folder");
        if (!folder) {
          folder = {
            name: part,
            path: [prefix, ...parts.slice(0, i + 1)].join("/").replace(/\/\//g, "/"),
            type: "folder",
            children: [],
          };
          current.push(folder);
        }
        current = folder.children;
      }
    }
  }

  return root;
}

/** Inclusive byte positions of an object whose total length is `size`. */
export type ObjectRange = { start: number; end: number; size: number };

/**
 * Stream an object, or only `range` of it. A partial read is issued to storage
 * as a ranged GET; a store that answers with a different slice or total length
 * fails closed instead of sending mislabelled bytes. A missing object is null.
 */
export async function getObjectStream(key: string, range?: ObjectRange): Promise<ReadableStream<Uint8Array> | null> {
  // The deadline covers the response headers; the body then streams without one.
  const object = await withReadDeadline(signal => retried(() => storage().get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined), signal));
  if (!object) return null;
  if (range && (object.size !== range.size || object.range?.offset !== range.start || object.range.length !== range.end - range.start + 1)) {
    void object.body.cancel().catch(() => {});
    throw new Error("Storage returned an unexpected byte range");
  }
  return object.body;
}

/** Writes bytes. The signal bounds how long the caller waits; the binding cannot cancel a write already started. */
export async function putObject(
  key: string,
  body: string | Uint8Array,
  contentType = "text/html",
  metadata?: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<void> {
  await retried(() => storage().put(key, body, { httpMetadata: { contentType }, customMetadata: metadata }), abortSignal);
}

export async function listAllKeys(prefix: string, limits?: { maxKeys: number; maxPages: number }): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await retried(() => storage().list({ prefix, cursor }));
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
    pages++;
    if (limits && (keys.length > limits.maxKeys || (cursor && pages >= limits.maxPages))) {
      throw new Error("Storage listing exceeds deployment verification budget");
    }
  } while (cursor);
  return keys;
}

/** One page of at most `limit` keys under a prefix, for callers that delete as they list. */
export async function listKeyPage(prefix: string, limit: number): Promise<{ keys: string[]; truncated: boolean }> {
  const page = await retried(() => storage().list({ prefix, limit }));
  return { keys: page.objects.map(object => object.key), truncated: page.truncated };
}

export async function getObjectText(key: string): Promise<string | null> {
  return withReadDeadline(async signal => {
    const object = await retried(() => storage().get(key), signal);
    return object ? await new Response(object.body).text() : null;
  });
}

/**
 * Copies an object to a new key, keeping its content type and metadata. R2 has no server-side copy,
 * so the bytes stream from one key into the other inside the Worker.
 */
export async function copyObject(sourceKey: string, destinationKey: string, abortSignal?: AbortSignal): Promise<void> {
  await retried(async () => {
    const source = await storage().get(sourceKey);
    if (!source) throw new Error("Storage copy source does not exist");
    try {
      await storage().put(destinationKey, source.body, { httpMetadata: source.httpMetadata, customMetadata: source.customMetadata });
    } catch (error: unknown) {
      void source.body.cancel().catch(() => {});
      throw error;
    }
  }, abortSignal);
}

export async function headObject(
  key: string,
): Promise<{ etag?: string; size?: number; contentType?: string; metadata?: Record<string, string> } | null> {
  const object = await retried(() => storage().head(key));
  if (!object) return null;
  return { contentType: object.httpMetadata?.contentType, etag: object.etag, size: object.size, metadata: object.customMetadata };
}

export async function deleteObject(key: string): Promise<void> {
  await retried(() => storage().delete(key));
}

/** Deletes up to 1000 keys in one operation. Missing keys are not an error. */
export async function deleteObjects(keys: string[]): Promise<void> {
  await retried(() => storage().delete(keys));
}
