import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET,
  MINIO_REGION,
  MINIO_FORCE_PATH_STYLE,
} from "@/config";

const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: MINIO_REGION,
  maxAttempts: 3, // Included in the bounded commit subrequest budget.
  credentials: {
    accessKeyId: MINIO_ACCESS_KEY,
    secretAccessKey: MINIO_SECRET_KEY,
  },
  forcePathStyle: MINIO_FORCE_PATH_STYLE,
});

export interface DocEntry {
  key: string;
  name: string;
  size: number;
  lastModified: Date;
}

/**
 * List objects under a prefix. Returns only .html files by default.
 */
export async function listObjects(prefix: string): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];
  let continuationToken: string | undefined;

  do {
    const cmd = new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: prefix,
      Delimiter: "/",
      ContinuationToken: continuationToken,
    });
    const res = await s3.send(cmd);

    for (const obj of res.Contents ?? []) {
      if (!obj.Key || !obj.Key.endsWith(".html")) continue;
      entries.push({
        key: obj.Key,
        name: obj.Key.slice(prefix.length).replace(/^\//, ""),
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      });
    }

    // Recurse into subdirectories
    for (const cp of res.CommonPrefixes ?? []) {
      if (!cp.Prefix) continue;
      const sub = await listObjects(cp.Prefix);
      entries.push(...sub);
    }

    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return entries;
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

  const cmd = new ListObjectsV2Command({
    Bucket: MINIO_BUCKET,
    Prefix: prefix,
    Delimiter: "/",
    MaxKeys: opts?.maxKeys ?? 1000,
    StartAfter: opts?.startAfter,
  });
  const res = await s3.send(cmd);

  for (const obj of res.Contents ?? []) {
    if (!obj.Key || obj.Key === prefix || !obj.Key.endsWith(".html")) continue;
    entries.push({
      key: obj.Key,
      name: obj.Key.slice(prefix.length),
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ?? new Date(0),
    });
  }

  for (const cp of res.CommonPrefixes ?? []) {
    if (!cp.Prefix) continue;
    entries.push({
      key: cp.Prefix,
      name: cp.Prefix.slice(prefix.length).replace(/\/$/, ""),
      size: 0,
      lastModified: new Date(0),
    });
  }

  return {
    entries,
    isTruncated: res.IsTruncated ?? false,
    nextStartAfter: res.IsTruncated ? entries[entries.length - 1]?.key : undefined,
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

/** How long a read may wait on storage before it counts as a failure (a retryable 503 for readers). */
export const STORAGE_READ_TIMEOUT_MS = 10_000;

/** Runs a storage read under a deadline that aborts the request; the timer never outlives it. */
async function withReadDeadline<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_READ_TIMEOUT_MS);
  try {
    return await read(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Inclusive byte positions of an object whose total length is `size`. */
export type ObjectRange = { start: number; end: number; size: number };

/**
 * Stream an object, or only `range` of it. A partial read is issued to storage
 * as a ranged GET; a store that ignores the range, or answers with a different
 * slice or total length, fails closed instead of sending mislabelled bytes.
 */
export async function getObjectStream(key: string, range?: ObjectRange): Promise<ReadableStream<Uint8Array> | null> {
  try {
    const cmd = new GetObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    });
    // The deadline covers the response headers; the body then streams without one.
    const res = await withReadDeadline(abortSignal => s3.send(cmd, { abortSignal }));
    if (!res.Body) return null;
    const stream = res.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    if (range && res.ContentRange !== `bytes ${range.start}-${range.end}/${range.size}`) {
      void stream.cancel().catch(() => {});
      throw new Error("Storage returned an unexpected byte range");
    }
    return stream;
  } catch (err: unknown) {
    if ((err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

export async function putObject(
  key: string,
  body: string | Uint8Array,
  contentType = "text/html",
  metadata?: Record<string, string>,
  abortSignal?: AbortSignal,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: metadata,
    }),
    { abortSignal },
  );
}

export async function listAllKeys(prefix: string, limits?: { maxKeys: number; maxPages: number }): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    token = res.NextContinuationToken;
    pages++;
    if (limits && (keys.length > limits.maxKeys || (token && pages >= limits.maxPages))) {
      throw new Error("Storage listing exceeds deployment verification budget");
    }
  } while (token);
  return keys;
}

export async function getObjectText(key: string): Promise<string | null> {
  try {
    return await withReadDeadline(async abortSignal => {
      const response = await s3.send(new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: key }), { abortSignal });
      return response.Body ? await response.Body.transformToString() : null;
    });
  } catch (error: unknown) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

export async function copyObject(sourceKey: string, destinationKey: string, abortSignal?: AbortSignal): Promise<void> {
  const encodedSource = encodeURIComponent(sourceKey).replaceAll("%2F", "/");
  await s3.send(new CopyObjectCommand({
    Bucket: MINIO_BUCKET,
    CopySource: `${MINIO_BUCKET}/${encodedSource}`,
    Key: destinationKey,
  }), { abortSignal });
}


export async function headObject(
  key: string,
): Promise<{ etag?: string; size?: number; contentType?: string; metadata?: Record<string, string> } | null> {
  try {
    const response = await s3.send(new HeadObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
    return {
      contentType: response.ContentType,
      etag: response.ETag?.replace(/"/g, ""),
      size: response.ContentLength,
      metadata: response.Metadata,
    };
  } catch (error: unknown) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}
export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
}
