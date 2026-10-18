import type { GitHubSource, GitTreeEntry, RepoRef } from "../github/source";
import { workPool } from "./concurrency";
import { IngestError } from "./errors";
import { treeKey } from "./keys";
import type { RepoContent } from "./store";

export interface TreeListing {
  /** The commit's root tree. */
  treeSha: string;
  /** Every entry with its full repository path. */
  entries: GitTreeEntry[];
  /** True when GitHub truncated the recursive listing and the tree was walked one directory at a time. */
  walked: boolean;
  /** Directory listings fetched from GitHub during a walk (cached ones cost nothing). */
  walkRequests: number;
}

export interface TreeListingOptions {
  /** A walk stops (permanently) beyond this many directories. */
  maxDirectories?: number;
  concurrency?: number;
  /** Directories a walk never descends into; their entries are still listed. */
  skipDirectory?: (path: string) => boolean;
}

const SKIPPED = new Set(["node_modules", "vendor", "third_party", "bower_components", "jspm_packages"]);

export function defaultSkipDirectory(path: string): boolean {
  return SKIPPED.has(path.slice(path.lastIndexOf("/") + 1));
}

/**
 * The full listing of a commit. One recursive request covers most
 * repositories. GitHub truncates past 100,000 entries or 7 MB; then the tree is
 * walked with non-recursive requests, and each directory listing is cached by
 * its tree ID, so a later push only fetches the directories that changed.
 */
export async function listCommitTree(
  source: GitHubSource, content: RepoContent, repo: RepoRef, commitSha: string, options: TreeListingOptions = {},
): Promise<TreeListing> {
  const recursive = await source.getTree(repo, commitSha, true);
  if (!recursive.truncated) return { treeSha: recursive.sha, entries: recursive.entries, walked: false, walkRequests: 0 };

  const maxDirectories = options.maxDirectories ?? 20_000;
  const skip = options.skipDirectory ?? defaultSkipDirectory;
  const entries: GitTreeEntry[] = [];
  let directories = 0;
  let walkRequests = 0;
  await workPool([{ path: "", sha: recursive.sha }], options.concurrency ?? 4, async (directory, push) => {
    directories += 1;
    if (directories > maxDirectories) {
      throw new IngestError("tree-too-large", `Repository has more than ${maxDirectories} directories`, true);
    }
    const key = treeKey(repo.id, directory.sha);
    let listing = await content.getJson<GitTreeEntry[]>(key);
    if (!listing) {
      walkRequests += 1;
      listing = (await source.getTree(repo, directory.sha, false)).entries;
      await content.putJson(key, listing);
    }
    for (const child of listing) {
      const path = directory.path ? `${directory.path}/${child.path}` : child.path;
      entries.push({ ...child, path });
      if (child.type === "tree" && !skip(path)) push({ path, sha: child.sha });
    }
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { treeSha: recursive.sha, entries, walked: true, walkRequests };
}
