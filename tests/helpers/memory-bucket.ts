import { createHash } from "node:crypto";
import type { BucketObject, BucketObjectBody, StorageBucket } from "../../src/storage";

type Stored = { bytes: Uint8Array; contentType?: string; metadata?: Record<string, string>; uploaded: Date };

/** `<operation>: <text> (<code>)`, the shape of every error the R2 binding throws. */
export const r2Error = (code: number, operation = "get", text = "storage detail") => new Error(`${operation}: ${text} (${code})`);

/**
 * In-memory stand-in for an R2 bucket binding. tests/storage-r2.test.ts runs the same behavioural
 * cases against this fake and against Miniflare's real R2 simulation, so the two cannot drift.
 */
export function memoryBucket(): StorageBucket & { objects: Map<string, Stored> } {
  const objects = new Map<string, Stored>();
  const describe = (key: string, value: Stored): BucketObject => ({
    key, size: value.bytes.length, etag: createHash("md5").update(value.bytes).digest("hex"), uploaded: value.uploaded,
    httpMetadata: value.contentType === undefined ? undefined : { contentType: value.contentType }, customMetadata: value.metadata ?? {},
  });
  return {
    objects,
    get(key, options) {
      const value = objects.get(key);
      if (!value) return Promise.resolve(null);
      let bytes = value.bytes;
      let range: { offset: number; length: number } | undefined;
      if (options?.range) {
        if (options.range.offset >= bytes.length) return Promise.reject(r2Error(10039, "get", "The requested range is not satisfiable"));
        const length = Math.min(options.range.length, bytes.length - options.range.offset);
        range = { offset: options.range.offset, length };
        bytes = bytes.slice(range.offset, range.offset + length);
      }
      const body = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>;
      return Promise.resolve<BucketObjectBody>({ ...describe(key, value), range, body });
    },
    head(key) {
      const value = objects.get(key);
      return Promise.resolve(value ? describe(key, value) : null);
    },
    async put(key, value, options) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value)
        : value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
      const stored = { bytes, contentType: options?.httpMetadata?.contentType, metadata: options?.customMetadata, uploaded: new Date() };
      objects.set(key, stored);
      return describe(key, stored);
    },
    list(options = {}) {
      const { prefix = "", delimiter, limit = 1000, startAfter, cursor } = options;
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix) && (startAfter === undefined || key > startAfter)).sort();
      const items: Array<{ object?: BucketObject; prefix?: string }> = [];
      for (const key of keys) {
        const at = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
        if (at < 0) { items.push({ object: describe(key, objects.get(key)!) }); continue; }
        const folder = key.slice(0, prefix.length + at + delimiter!.length);
        if (items.at(-1)?.prefix !== folder) items.push({ prefix: folder });
      }
      const from = cursor === undefined ? 0 : Number(atob(cursor));
      const page = items.slice(from, from + limit);
      const truncated = from + limit < items.length;
      return Promise.resolve({
        objects: page.flatMap(item => item.object ? [item.object] : []),
        delimitedPrefixes: page.flatMap(item => item.prefix === undefined ? [] : [item.prefix]),
        truncated,
        cursor: truncated ? btoa(String(from + limit)) : undefined,
      });
    },
    delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      return Promise.resolve();
    },
  };
}
