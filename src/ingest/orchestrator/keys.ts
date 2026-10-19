/**
 * Storage key schema for repository content (docs/TECHNICAL.md, "Repository
 * ingest orchestration"). Everything a repo owns sits under one prefix keyed by
 * GitHub's numeric repository ID, so a purge is one prefix delete and renames
 * never move data. Every key except the ref pointer names immutable bytes.
 */
import { isGitObjectId } from "../github/git-objects";

export const ROOT_PREFIX = "gh/v1/";
export const TRACKED_PREFIX = `${ROOT_PREFIX}tracked/`;
export const REDELIVERY_CHECKPOINT_KEY = `${ROOT_PREFIX}reconcile/redelivery.json`;

const RENDER_KEY = /^render\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

function requireRepoId(repoId: number): void {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new TypeError("Expected a GitHub repository ID");
}

function requireObjectId(sha: string): void {
  if (!isGitObjectId(sha)) throw new TypeError("Expected a git object ID");
}

export function repoPrefix(repoId: number): string {
  requireRepoId(repoId);
  return `${ROOT_PREFIX}repo/${repoId}/`;
}

/** The repository a canonical storage key belongs to, or null for anything else. */
export function storageKeyRepoId(storageKey: string): number | null {
  const match = /^gh\/v1\/repo\/([1-9]\d*)\/./.exec(storageKey);
  return match ? Number(match[1]) : null;
}

/** Raw blob bytes, content-addressed: shared by every commit that contains the blob. */
export function blobKey(repoId: number, blobSha: string): string {
  requireObjectId(blobSha);
  return `${repoPrefix(repoId)}blob/${blobSha}`;
}

/** Rendered page output. `renderKey` comes from the pipeline and already carries the renderer version. */
export function renderObjectKey(repoId: number, renderKey: string): string {
  if (!RENDER_KEY.test(renderKey) || renderKey.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError("Unexpected render key");
  }
  return `${repoPrefix(repoId)}${renderKey}`;
}

/** One directory's non-recursive listing, cached for walks of trees GitHub truncates. */
export function treeKey(repoId: number, treeSha: string): string {
  requireObjectId(treeSha);
  return `${repoPrefix(repoId)}tree/${treeSha}.json`;
}

function snapshotPrefix(repoId: number, commitSha: string, rendererVersion: number): string {
  requireObjectId(commitSha);
  if (!Number.isSafeInteger(rendererVersion) || rendererVersion < 0) throw new TypeError("Expected a renderer version");
  return `${repoPrefix(repoId)}snapshot/${commitSha}/r${rendererVersion}/`;
}

/** Written last: its presence means every object the snapshot names exists. */
export function manifestKey(repoId: number, commitSha: string, rendererVersion: number): string {
  return `${snapshotPrefix(repoId, commitSha, rendererVersion)}manifest.json`;
}

export function sidebarKey(repoId: number, commitSha: string, rendererVersion: number): string {
  return `${snapshotPrefix(repoId, commitSha, rendererVersion)}sidebar.json`;
}

/** The only mutable object: which complete snapshot a branch serves. */
export function refKey(repoId: number, branch: string): string {
  if (!isBranchName(branch)) throw new TypeError("Expected a branch name");
  return `${repoPrefix(repoId)}ref/${encodeURIComponent(branch)}.json`;
}

/** Registry entry the reconciliation cron walks. */
export function trackedKey(repoId: number): string {
  requireRepoId(repoId);
  return `${TRACKED_PREFIX}${repoId}.json`;
}

/** Branch names as `git check-ref-format --branch` accepts them, without the refs/heads/ prefix. */
export function isBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name === "@") return false;
  return name.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"))
    && !name.endsWith(".");
}
