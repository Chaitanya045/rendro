import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
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

export async function getObjectStream(key: string): Promise<ReadableStream | null> {
  try {
    const cmd = new GetObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
    });
    const res = await s3.send(cmd);
    if (!res.Body) return null;
    return res.Body.transformToWebStream();
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
  contentType = "text/html"
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: MINIO_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

export async function listAllKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}


export async function headObject(key: string): Promise<{ etag?: string; size?: number } | null> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
    return { etag: res.ETag?.replace(/"/g, ""), size: res.ContentLength };
  } catch (err: unknown) {
    if ((err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}
export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: MINIO_BUCKET, Key: key }));
}
