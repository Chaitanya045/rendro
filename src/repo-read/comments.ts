/**
 * The serving Worker's half of comments on repository docs (#254). Convex can
 * neither ask the permission source nor read the revocation epoch, so after the
 * read path authorizes a reader (cookie, epoch, permission source: exactly what
 * a page view needs), the trusted shell asks here, and this records a grant in
 * Convex for that reader and repository. Comment queries and mutations check
 * the grant; it never outlives the authorization behind it (`RepoGrant.until`,
 * at most the five-minute capability), and P5 deletes it on a revocation epoch
 * or an uninstall. See docs/TECHNICAL.md, "Comments on repository docs".
 *
 * The frame half lives here too: the widget's configuration is the same for
 * every reader (frames are cached), so who may write is the shell's to say.
 */
import { convexMutationRequired } from "@/convex-internal";
import { COMMENTOR_STYLE_HASH } from "@/commentor/style-hash";
import { escapeHtml } from "@/routes/html";
import { COMMENTOR_VERSION } from "@/viewer/asset-versions";
import type { ManifestFile } from "@/ingest/orchestrator/snapshot";
import type { RepoGrant } from "./grant";

export interface CommentGrantInput {
  repoId: number;
  /** null: the repository is public, so the grant is for anyone. */
  userId: string | null;
  epoch: number;
  expiresAt: number;
}

export interface CommentGrants {
  /** The expiry Convex recorded, or null when it refused (revoked or removed meanwhile). Throws when it could not be asked. */
  record(input: CommentGrantInput): Promise<number | null>;
}

/** Convex's `repoCommentAccess:grant`, called with the internal secret. */
export const convexCommentGrants: CommentGrants = {
  async record(input) {
    const result = await convexMutationRequired("repoCommentAccess:grant", { ...input }) as { granted?: unknown; expiresAt?: unknown } | null;
    return result?.granted === true && typeof result.expiresAt === "number" ? result.expiresAt : null;
  },
};

/** Comment access is decided afresh when the authorization behind it would end sooner (a capability or public memory near
 * its end), so every grant lasts at least this long and the shell, renewing halfway, never sees one lapse. */
export const COMMENT_GRANT_MIN_MS = 30_000;
/** A shell renews when half its grant has passed; a grant still this fresh is not recorded again. */
const REUSE_FRACTION = 0.5;
const MAX_ENTRIES = 1_024;
/** Per isolate: repository, reader and epoch → the expiry Convex holds, so many readers of one public repository make one write. */
const recorded = new Map<string, { expiresAt: number; ttl: number }>();

export function clearCommentGrantMemory(): void {
  recorded.clear();
}

export type CommentAccess = { expiresAt: number };

/** Record (or reuse) the Convex grant for an authorized reader. Null when there is nothing to grant or Convex refused. */
export async function commentAccess(grants: CommentGrants, grant: RepoGrant, now: number): Promise<CommentAccess | null> {
  if (grant.until <= now) return null;
  // A private grant is the reader's alone; a public one is anyone's, so it never names a reader.
  const userId = grant.repo.private ? grant.viewer : null;
  const key = `${grant.repo.id}\u0000${userId ?? ""}\u0000${grant.epoch}`;
  const known = recorded.get(key);
  if (known && known.expiresAt - now > known.ttl * REUSE_FRACTION) return { expiresAt: known.expiresAt };
  const expiresAt = await grants.record({ repoId: grant.repo.id, userId, epoch: grant.epoch, expiresAt: grant.until });
  recorded.delete(key);
  if (expiresAt === null) return null;
  recorded.set(key, { expiresAt, ttl: expiresAt - now });
  if (recorded.size > MAX_ENTRIES) recorded.delete(recorded.keys().next().value as string);
  return { expiresAt };
}

/** Script and style sources the widget needs in a repository frame's policy. */
export const COMMENTOR_SCRIPT_PATH = "/commentor.js";
export const COMMENTOR_STYLE_SOURCE = COMMENTOR_STYLE_HASH;

/**
 * The widget for one rendered page. Its configuration is reader-independent so
 * the frame stays cacheable: the repository, the page and the blob it shows.
 * The parent shell decides who may write, and supplies the trusted scope.
 */
export function commentorScript(origin: string, repoId: number, path: string, file: ManifestFile): string {
  const config = { transport: "parent", repoId, documentPath: path, blobSha: file.sha };
  return `<script defer src="${origin}${COMMENTOR_SCRIPT_PATH}?v=${COMMENTOR_VERSION}" data-commentor-config="${escapeHtml(JSON.stringify(config))}"></script>\n`;
}
