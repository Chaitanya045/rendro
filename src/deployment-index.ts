/**
 * Immutable per-deployment path and directory index (#90).
 *
 * Deployment start writes, next to manifest.json:
 *   index/v1/files/{n}.json  path entries: [path, sha256, size, contentType]
 *   index/v1/tree/{n}.json   directory pages: [directory, page, [[name, folder]], more]
 *   index/v1/root.json       salt, shard count, first document; written last
 * A deployment of at most INDEX_SHARD_TARGET_FILES files has one shard, which
 * the root carries inline, so its lookups read a single small object.
 *
 * A path or page belongs to shard SHA-256(salt, kind, key) mod count. The salt
 * is random per deployment and never served, so publisher-chosen paths cannot
 * concentrate entries in one shard. Lookups compare exact canonical paths and
 * never derive storage keys from index contents.
 *
 * Deployments without a valid index, and lookups whose shard is missing or
 * corrupt, use the authoritative manifest instead. Every parsed object is held
 * in the per-isolate immutable metadata cache; authorization never is.
 *
 * Read-mode callers hold a deployment that the database just authorized, so a
 * manifest that storage lacks or that cannot be parsed means "could not check",
 * never "no such document": it throws ViewerBackendError (a retryable 503), and
 * only a lookup in a manifest that was read answers null for an absent path.
 */
import { getObjectText } from "@/storage";
import { ViewerBackendError } from "@/viewer-backend";
import { isHtmlAsset } from "@/routes/asset-headers";
import { deploymentMetadataCache } from "@/immutable-cache";
import {
  parseDeploymentManifestText,
  parseStoredManifest,
  type DeploymentManifest,
  type ManifestFile,
} from "@/stored-manifest";
import { isCanonicalStorageKey } from "../shared/storage-path";
import { cleanDeploymentPath } from "../shared/v2-paths";
import { deploymentFileLimitError } from "../shared/deployment-limits";

/** Average entries per shard. At the 1,000-file deployment limit this gives
 * four file shards and four tree shards: nine index writes at start. */
export const INDEX_SHARD_TARGET_FILES = 256;
export const TREE_PAGE_SIZE = 200;
const MAX_INDEX_SHARDS = 1 << 16;

/** Manifests written before hashes and sizes were required may omit them. */
export type StoredFile = { path: string; contentType: string; sha256?: string; size?: number };
export type TreeChild = { name: string; type: "file" | "folder" };
export type TreePage = { children: TreeChild[]; more: boolean };

export interface DeploymentIndex<F extends StoredFile> {
  /** First HTML document in manifest order, the default selection. */
  readonly firstDocument: string | null;
  file(path: string): Promise<F | null>;
  /** `directory` is "" for the root or a canonical path ending in "/". */
  treePage(directory: string, page: number): Promise<TreePage | null>;
}

type Mode = "read" | "staging";
type Structure<F extends StoredFile> = {
  files: Map<string, F>;
  pages: Map<string, TreePage>;
  documents: string[];
  firstDocument: string | null;
};
type Root = {
  manifestSha256: string;
  salt: string;
  shards: number;
  firstDocument: string | null;
  files?: Map<string, ManifestFile>;
  tree?: Map<string, TreePage>;
};
type FileRow = [string, string, number, string];
type PageRow = [string, number, Array<[string, 0 | 1]>, 0 | 1];

const HEX64 = /^[a-f0-9]{64}$/;
const SALT = /^[a-f0-9]{32}$/;
const cache = deploymentMetadataCache;

export function indexShardCount(fileCount: number): number {
  let count = 1;
  while (count * INDEX_SHARD_TARGET_FILES < fileCount && count < MAX_INDEX_SHARDS) count *= 2;
  return count;
}

/** Keys come only from a validated deployment manifest key. */
export function deploymentIndexKey(manifestKey: string, name: string): string | null {
  return manifestKey.endsWith("/manifest.json") && isCanonicalStorageKey(manifestKey)
    ? `${manifestKey.slice(0, -"manifest.json".length)}index/v1/${name}`
    : null;
}

export function validTreeDirectory(directory: string): boolean {
  return directory === "" || (directory.endsWith("/") && cleanDeploymentPath(directory.slice(0, -1)) !== null);
}

function pageKey(directory: string, page: number): string {
  // Canonical keys never contain control characters, so this is unambiguous.
  return `${directory}\n${page}`;
}

async function shardOf(salt: string, kind: "f" | "t", key: string, count: number): Promise<number> {
  if (count === 1) return 0;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}\n${kind}\n${key}`));
  return new DataView(digest).getUint32(0) & (count - 1);
}

function compareChildren(left: TreeChild, right: TreeChild): number {
  if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
  // Names are unique per type; the code-point tie-break keeps pages stable
  // when the collation considers distinct names equal.
  return left.name.localeCompare(right.name) || (left.name < right.name ? -1 : 1);
}

function structure<F extends StoredFile>(entries: readonly F[]): Structure<F> {
  const files = new Map<string, F>();
  const directories = new Map<string, Map<string, TreeChild>>([["", new Map()]]);
  const documents: string[] = [];
  for (const file of entries) {
    // Historical lenient manifests keep their first-match semantics.
    if (files.has(file.path)) continue;
    files.set(file.path, file);
    if (!isHtmlAsset(file.path, file.contentType)) continue;
    documents.push(file.path);
    const parts = file.path.split("/");
    let directory = "";
    parts.forEach((name, index) => {
      const type = index === parts.length - 1 ? "file" : "folder";
      (directories.get(directory) as Map<string, TreeChild>).set(`${type}:${name}`, { name, type });
      if (type === "folder") {
        directory += `${name}/`;
        if (!directories.has(directory)) directories.set(directory, new Map());
      }
    });
  }
  const pages = new Map<string, TreePage>();
  for (const [directory, children] of directories) {
    const sorted = Array.from(children.values()).sort(compareChildren);
    let page = 0;
    do {
      const start = page * TREE_PAGE_SIZE;
      pages.set(pageKey(directory, page), {
        children: sorted.slice(start, start + TREE_PAGE_SIZE),
        more: start + TREE_PAGE_SIZE < sorted.length,
      });
      page += 1;
    } while (page * TREE_PAGE_SIZE < sorted.length);
  }
  return { files, pages, documents, firstDocument: documents[0] ?? null };
}

function randomSalt(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}

export type IndexObject = { key: string; body: string };

/** Serialize the index for a validated manifest. Returns null when the manifest
 * key is not a deployment manifest key. Write `shards` before `root`. */
export async function deploymentIndexObjects(
  manifestKey: string,
  manifest: DeploymentManifest,
  manifestSha256: string,
  salt = randomSalt(),
): Promise<{ shards: IndexObject[]; root: IndexObject } | null> {
  const rootKey = deploymentIndexKey(manifestKey, "root.json");
  if (!rootKey) return null;
  const { pages, firstDocument } = structure(manifest.files);
  const count = indexShardCount(manifest.files.length);
  const files: FileRow[][] = Array.from({ length: count }, () => []);
  const tree: PageRow[][] = Array.from({ length: count }, () => []);
  for (const file of manifest.files) {
    files[await shardOf(salt, "f", file.path, count)].push([file.path, file.sha256, file.size, file.contentType]);
  }
  for (const [key, page] of pages) {
    const separator = key.lastIndexOf("\n");
    tree[await shardOf(salt, "t", key, count)].push([
      key.slice(0, separator),
      Number(key.slice(separator + 1)),
      page.children.map(child => [child.name, child.type === "folder" ? 1 : 0]),
      page.more ? 1 : 0,
    ]);
  }
  const root = {
    version: 1, manifestSha256, fileCount: manifest.files.length, salt, shards: count, firstDocument,
    ...(count === 1 ? { files: files[0], tree: tree[0] } : {}),
  };
  // Empty shards are still written, so a missing shard always means damage.
  const shards = count === 1 ? [] : [
    ...files.map((rows, number) => ({ key: deploymentIndexKey(manifestKey, `files/${number}.json`) as string, body: JSON.stringify({ version: 1, files: rows }) })),
    ...tree.map((rows, number) => ({ key: deploymentIndexKey(manifestKey, `tree/${number}.json`) as string, body: JSON.stringify({ version: 1, tree: rows }) })),
  ];
  return { shards, root: { key: rootKey, body: JSON.stringify(root) } };
}

function parseFileRows(value: unknown): Map<string, ManifestFile> | null {
  if (!Array.isArray(value)) return null;
  const files = new Map<string, ManifestFile>();
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const [path, sha256, size, contentType] = row as unknown[];
    if (typeof path !== "string" || cleanDeploymentPath(path) === null || files.has(path)
      || typeof sha256 !== "string" || !HEX64.test(sha256)
      || typeof size !== "number" || typeof contentType !== "string"
      || deploymentFileLimitError(path, size, contentType)) return null;
    files.set(path, { path, sha256, size, contentType });
  }
  return files;
}

function treeChild(value: unknown): TreeChild | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [name, folder] = value as unknown[];
  // Names are single canonical segments: never separators, dot segments or controls.
  if (typeof name !== "string" || name.includes("/") || cleanDeploymentPath(name) === null
    || (folder !== 0 && folder !== 1)) return null;
  return { name, type: folder ? "folder" : "file" };
}

function parsePageRows(value: unknown): Map<string, TreePage> | null {
  if (!Array.isArray(value)) return null;
  const pages = new Map<string, TreePage>();
  for (const row of value as unknown[]) {
    if (!Array.isArray(row) || row.length !== 4) return null;
    const [directory, page, children, more] = row as unknown[];
    if (typeof directory !== "string" || !validTreeDirectory(directory)
      || !Number.isSafeInteger(page) || (page as number) < 0
      || !Array.isArray(children) || (more !== 0 && more !== 1)) return null;
    const key = pageKey(directory, page as number);
    const parsed = (children as unknown[]).map(treeChild);
    if (pages.has(key) || parsed.includes(null)) return null;
    pages.set(key, { children: parsed as TreeChild[], more: more === 1 });
  }
  return pages;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function parseRoot(text: string): Root | null {
  const value = parseJson(text);
  const shards = value?.shards;
  if (!value || value.version !== 1
    || typeof value.manifestSha256 !== "string" || !HEX64.test(value.manifestSha256)
    || typeof value.salt !== "string" || !SALT.test(value.salt)
    || typeof shards !== "number" || !Number.isSafeInteger(shards) || shards < 1 || shards > MAX_INDEX_SHARDS
    || (shards & (shards - 1)) !== 0
    || !(value.firstDocument === null || (typeof value.firstDocument === "string" && cleanDeploymentPath(value.firstDocument) !== null))) {
    return null;
  }
  const root: Root = {
    manifestSha256: value.manifestSha256, salt: value.salt, shards, firstDocument: value.firstDocument,
  };
  if (shards > 1) return root;
  const files = parseFileRows(value.files);
  const tree = parsePageRows(value.tree);
  return files && tree ? { ...root, files, tree } : null;
}

function memoryIndex<F extends StoredFile>(index: Structure<F>): DeploymentIndex<F> & { documents: string[] } {
  return {
    firstDocument: index.firstDocument,
    documents: index.documents,
    file: path => Promise.resolve(index.files.get(path) ?? null),
    treePage: (directory, page) => Promise.resolve(index.pages.get(pageKey(directory, page)) ?? null),
  };
}

/** The whole manifest, parsed once per isolate: the fallback for deployments
 * written before the index and for damaged index shards. */
function manifestIndex(manifestKey: string, mode: Mode): Promise<(DeploymentIndex<StoredFile> & { documents: string[] }) | null> {
  return cache.get(`manifest\n${mode}\n${manifestKey}`, async () => {
    const text = await getObjectText(manifestKey);
    // Staging uploads keep the strict new-deployment parser; reads keep the
    // lenient parser that accepts deployments predating current limits.
    const files = mode === "staging" ? parseDeploymentManifestText(text)?.files : parseStoredManifest(text)?.files;
    // A missing manifest is not retained, so the next request reads it again.
    return files ? { value: memoryIndex(structure(files)), weight: (text as string).length } : { value: null, weight: null };
  });
}

function indexRoot(manifestKey: string): Promise<Root | null> {
  return cache.get(`root\n${manifestKey}`, async () => {
    const key = deploymentIndexKey(manifestKey, "root.json");
    const text = key ? await getObjectText(key) : null;
    // Absence is retained: an index is never added after deployment start
    // returns, and every absent or invalid index falls back to the manifest.
    return { value: text ? parseRoot(text) : null, weight: text?.length ?? 0 };
  });
}

function indexShard<T>(
  manifestKey: string,
  root: Root,
  kind: "files" | "tree",
  number: number,
  parse: (value: unknown) => Map<string, T> | null,
): Promise<Map<string, T> | null> {
  return cache.get(`${kind}\n${number}\n${root.manifestSha256}\n${manifestKey}`, async () => {
    // A valid root implies a valid manifest key.
    const text = await getObjectText(deploymentIndexKey(manifestKey, `${kind}/${number}.json`) as string);
    const value = text ? parseJson(text) : null;
    const rows = value?.version === 1 ? parse(value[kind]) : null;
    // A damaged shard is not retained; its lookups use the manifest.
    return { value: rows, weight: rows ? (text as string).length : null };
  });
}

function shardedIndex(manifestKey: string, root: Root, mode: Mode): DeploymentIndex<ManifestFile> {
  const fallback = async () => {
    const manifest = await manifestIndex(manifestKey, mode) as DeploymentIndex<ManifestFile> | null;
    if (!manifest && mode === "read") throw new ViewerBackendError();
    return manifest;
  };
  return {
    firstDocument: root.firstDocument,
    async file(path) {
      const files = root.files ?? await indexShard(manifestKey, root, "files", await shardOf(root.salt, "f", path, root.shards), parseFileRows);
      return files ? files.get(path) ?? null : (await fallback())?.file(path) ?? null;
    },
    async treePage(directory, page) {
      const key = pageKey(directory, page);
      const pages = root.tree ?? await indexShard(manifestKey, root, "tree", await shardOf(root.salt, "t", key, root.shards), parsePageRows);
      return pages ? pages.get(key) ?? null : (await fallback())?.treePage(directory, page) ?? null;
    },
  };
}

/** Open the deployment's index for exact-path and directory lookups. Staging
 * returns null when neither an index nor a readable manifest exists; reading
 * throws ViewerBackendError instead (see the note at the top). */
export async function openDeploymentIndex(manifestKey: string, mode: "staging"): Promise<DeploymentIndex<ManifestFile> | null>;
export async function openDeploymentIndex(manifestKey: string, mode?: "read"): Promise<DeploymentIndex<StoredFile>>;
export async function openDeploymentIndex(manifestKey: string, mode: Mode = "read"): Promise<DeploymentIndex<StoredFile> | null> {
  const root = await indexRoot(manifestKey);
  const index = root ? shardedIndex(manifestKey, root, mode) : await manifestIndex(manifestKey, mode);
  if (!index && mode === "read") throw new ViewerBackendError();
  return index;
}

/** Every HTML document in manifest order, for tree clients that predate
 * directory pages. Served from the cached manifest. */
export async function deploymentDocuments(manifestKey: string): Promise<string[]> {
  const manifest = await manifestIndex(manifestKey, "read");
  if (!manifest) throw new ViewerBackendError();
  return manifest.documents;
}
