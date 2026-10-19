import { createHash } from "node:crypto";
import type { DurableStorageLike } from "../../src/ingest/orchestrator/coordinator";
import type { R2BucketLike } from "../../src/ingest/orchestrator/store";

interface StoredR2 {
  bytes: Uint8Array;
  etag: string;
  contentType: string | undefined;
}

/** In-memory R2 bucket with the binding's semantics for the calls ingest makes. */
export class FakeR2Bucket implements R2BucketLike {
  readonly objects = new Map<string, StoredR2>();
  readonly ops = { get: 0, head: 0, put: 0, list: 0, delete: 0 };
  /** Throw on put when this returns true (a crash or an R2 outage mid-ingest). */
  failPut: ((key: string) => boolean) | null = null;
  /** Called before a put lands (to race a concurrent writer). */
  beforePut: ((key: string) => void) | null = null;
  listLimit = 1000;

  get(key: string) {
    this.ops.get += 1;
    const object = this.objects.get(key);
    return Promise.resolve(object ? { etag: object.etag, arrayBuffer: () => Promise.resolve(object.bytes.slice().buffer) } : null);
  }

  head(key: string) {
    this.ops.head += 1;
    const object = this.objects.get(key);
    return Promise.resolve(object ? { etag: object.etag } : null);
  }

  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }; onlyIf?: { etagMatches?: string } }) {
    this.ops.put += 1;
    if (this.failPut?.(key)) return Promise.reject(new Error("R2 put failed"));
    this.beforePut?.(key);
    const existing = this.objects.get(key);
    if (options?.onlyIf?.etagMatches !== undefined && existing?.etag !== options.onlyIf.etagMatches) return Promise.resolve(null);
    const etag = createHash("md5").update(value).digest("hex");
    this.objects.set(key, { bytes: value.slice(), etag, contentType: options?.httpMetadata?.contentType });
    return Promise.resolve({ etag });
  }

  list(options: { prefix: string; cursor?: string; limit?: number }) {
    this.ops.list += 1;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const start = options.cursor ? Number(options.cursor) : 0;
    const limit = Math.min(options.limit ?? 1000, this.listLimit);
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return Promise.resolve({ objects: page.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(start + limit) } : {}) });
  }

  /** Throw on delete when this returns true (an R2 outage mid-purge). */
  failDelete: ((keys: string[]) => boolean) | null = null;

  delete(keys: string[]) {
    this.ops.delete += 1;
    if (keys.length > 1000) return Promise.reject(new Error("R2 deletes at most 1000 keys at once"));
    if (this.failDelete?.(keys)) return Promise.reject(new Error("R2 delete failed"));
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  json<T>(key: string): T | null {
    const object = this.objects.get(key);
    return object ? JSON.parse(new TextDecoder().decode(object.bytes)) as T : null;
  }

  keys(prefix = ""): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

/** In-memory Durable Object storage (key-value API and alarm). Values are structured-cloned like the real one. */
export class FakeDurableStorage implements DurableStorageLike {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  readonly alarms: number[] = [];

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
    this.alarms.push(scheduledTime);
    return Promise.resolve();
  }

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.has(key) ? structuredClone(this.data.get(key)) as T : undefined);
  }

  put(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
    return Promise.resolve();
  }

  delete(keys: string[]): Promise<number> {
    // The real API refuses more than 128 keys per call.
    if (keys.length > 128) return Promise.reject(new Error("At most 128 keys per delete"));
    let deleted = 0;
    for (const key of keys) if (this.data.delete(key)) deleted += 1;
    return Promise.resolve(deleted);
  }

  list<T>(options: { prefix: string; end?: string; limit?: number }): Promise<Map<string, T>> {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix) && (options.end === undefined || key < options.end)).sort();
    return Promise.resolve(new Map(keys.slice(0, options.limit ?? keys.length).map((key) => [key, structuredClone(this.data.get(key)) as T])));
  }
}
