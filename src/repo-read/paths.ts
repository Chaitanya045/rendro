/**
 * URL grammar of the repository read path (#234), parsed from the raw
 * (still percent-encoded) pathname:
 *
 *   /r/{owner}/{repo}[/{ref}]                       shell; `?doc=<repo path>` selects the document
 *   /r/{owner}/{repo}[/{ref}]/files/{path}          rendered page (document frame) or asset bytes
 *   /r/{owner}/{repo}[/{ref}]/tree                  one sidebar directory page (JSON)
 *   /r/{owner}/{repo}/@{commit}/view/{ticket}/files/{path}   private assets, authorized by an asset ticket
 *   /r/{owner}/{repo}/@{commit}/viewer-ticket       ticket renewal for the trusted shell (JSON)
 *
 * `{ref}` is one segment: `~{branch}` (a `/` in the branch is written `%2F`) or
 * `@{commit}` (immutable). Without it the default branch is served. Owner and
 * repository names must be literal GitHub names. `{path}` is decoded once per
 * segment; empty, `.` or `..` segments, encoded separators, backslashes and
 * control characters are rejected before anything else happens. A path is only
 * ever a lookup key into the snapshot manifest, never part of a storage key.
 */
import { isGitObjectId } from "@/ingest/github/git-objects";
import { isBranchName } from "@/ingest/orchestrator/keys";
import { isOwnerLogin, isRepoName } from "@/ingest/orchestrator/messages";
import { decodeStoragePath } from "@/storage-boundary";

export type RepoRefSpec = { kind: "default" } | { kind: "branch"; branch: string } | { kind: "commit"; commit: string };

export type RepoTarget =
  | { kind: "shell" }
  | { kind: "files"; path: string }
  | { kind: "tree" }
  | { kind: "ticket-files"; ticket: string; path: string }
  | { kind: "viewer-ticket" };

export interface RepoRequestPath {
  owner: string;
  name: string;
  ref: RepoRefSpec;
  target: RepoTarget;
}

const TICKET_SEGMENT = /^[A-Za-z0-9._-]{1,2048}$/;

function parseRef(segment: string): RepoRefSpec | null {
  if (segment.startsWith("@")) {
    const commit = segment.slice(1);
    return isGitObjectId(commit) ? { kind: "commit", commit } : null;
  }
  let branch: string;
  try {
    branch = decodeURIComponent(segment.slice(1));
  } catch {
    return null;
  }
  return isBranchName(branch) ? { kind: "branch", branch } : null;
}

function parseTarget(rest: string[], ref: RepoRefSpec): RepoTarget | null {
  if (rest.length === 0) return { kind: "shell" };
  if (rest.length === 1 && rest[0] === "tree") return { kind: "tree" };
  if (rest[0] === "files" && rest.length > 1) {
    const path = decodeStoragePath(rest.slice(1).join("/"));
    return path ? { kind: "files", path } : null;
  }
  // Tickets and their renewal exist only for immutable commits.
  if (ref.kind !== "commit") return null;
  if (rest.length === 1 && rest[0] === "viewer-ticket") return { kind: "viewer-ticket" };
  if (rest[0] === "view" && rest[2] === "files" && rest.length > 3 && TICKET_SEGMENT.test(rest[1])) {
    const path = decodeStoragePath(rest.slice(3).join("/"));
    return path ? { kind: "ticket-files", ticket: rest[1], path } : null;
  }
  return null;
}

export function parseRepoPath(pathname: string): RepoRequestPath | null {
  if (!pathname.startsWith("/r/")) return null;
  const [owner, name, ...rest] = pathname.slice(3).split("/");
  if (!isOwnerLogin(owner) || !isRepoName(name)) return null;
  let ref: RepoRefSpec = { kind: "default" };
  if (rest.length && /^[~@]/.test(rest[0])) {
    const parsed = parseRef(rest.shift() as string);
    if (!parsed) return null;
    ref = parsed;
  }
  const target = parseTarget(rest, ref);
  return target ? { owner, name, ref, target } : null;
}

/** The URL prefix of a repository at a ref, as the shell and frames use it. */
export function repoBase(owner: string, name: string, ref: RepoRefSpec): string {
  const root = `/r/${owner}/${name}`;
  if (ref.kind === "commit") return `${root}/@${ref.commit}`;
  return ref.kind === "branch" ? `${root}/~${encodeURIComponent(ref.branch)}` : root;
}

/** Encode a repository path for a URL, one segment at a time. */
export function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
