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
import { convexMutationRequired, convexQueryRequired } from "@/convex-internal";
import { COMMENTOR_STYLE_HASH } from "@/commentor/style-hash";
import { escapeHtml } from "@/routes/html";
import { COMMENTOR_VERSION } from "@/viewer/asset-versions";
import type { ManifestFile } from "@/ingest/orchestrator/snapshot";
import type { ModerationRole, RepoModerationSource, RevocationEpochs } from "./access";
import type { RepoGrant } from "./grant";

export interface CommentGrantInput {
  repoId: number;
  /** null: the repository is public, so the grant is for anyone. */
  userId: string | null;
  epoch: number;
  expiresAt: number;
}

/** A reader's moderation role on a repository (#259), as the control Worker's mirror stated it just now. */
export interface ModeratorGrantInput {
  repoId: number;
  userId: string;
  role: ModerationRole;
  epoch: number;
  expiresAt: number;
}

export interface CommentGrants {
  /** The expiry Convex recorded, or null when it refused (revoked or removed meanwhile). Throws when it could not be asked. */
  record(input: CommentGrantInput): Promise<number | null>;
  /** The same for a moderator grant (#259). */
  recordModerator(input: ModeratorGrantInput): Promise<number | null>;
}

function grantedExpiry(result: { granted?: unknown; expiresAt?: unknown } | null): number | null {
  return result?.granted === true && typeof result.expiresAt === "number" ? result.expiresAt : null;
}

/** Convex's `repoCommentAccess:grant` and `grantModerator`, called with the internal secret. */
export const convexCommentGrants: CommentGrants = {
  async record(input) {
    return grantedExpiry(await convexMutationRequired("repoCommentAccess:grant", { ...input }) as { granted?: unknown; expiresAt?: unknown } | null);
  },
  async recordModerator(input) {
    return grantedExpiry(await convexMutationRequired("repoCommentAccess:grantModerator", { ...input }) as { granted?: unknown; expiresAt?: unknown } | null);
  },
};

/** The first page of a document's threads, as the shell renders it before its live subscription delivers (#284). */
export type CommentSnapshot = { page: unknown[]; isDone: boolean };

export interface CommentSnapshots {
  /** The page Convex gives this reader, or null when its answer is malformed. Throws when it could not be asked. */
  threads(input: { repoId: number; path: string; userId: string | null; epoch: number; viewerId?: string; moderator?: true }): Promise<CommentSnapshot | null>;
}

/** Convex's `repoComments:threadSnapshot`, called with the internal secret. */
export const convexCommentSnapshots: CommentSnapshots = {
  async threads(input) {
    const result = await convexQueryRequired("repoComments:threadSnapshot", { ...input }) as { page?: unknown; isDone?: unknown } | null;
    return Array.isArray(result?.page) && typeof result.isDone === "boolean" ? { page: result.page, isDone: result.isDone } : null;
  },
};

/**
 * The first thread page for an authorized reader, decided as the grant is (the reader alone, or anyone for a public
 * repository). A public page is read for `reader`, the signed-in reader when there is one (#303), so their own threads
 * carry their Archive and Delete from the first paint; a private page is always read for the grant's reader.
 */
export function commentSnapshot(snapshots: CommentSnapshots, grant: RepoGrant, path: string, reader: string | null, moderator = false): Promise<CommentSnapshot | null> {
  // The page says which comments the reader may archive or delete: a moderator's role (#259) widens that to everyone's.
  const role = moderator && (grant.repo.private ? grant.viewer : reader) !== null ? { moderator: true as const } : {};
  if (grant.repo.private) return snapshots.threads({ repoId: grant.repo.id, path, userId: grant.viewer, epoch: grant.epoch, ...role });
  return snapshots.threads({ repoId: grant.repo.id, path, userId: null, epoch: grant.epoch, ...(reader ? { viewerId: reader } : {}), ...role });
}

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
  moderators.clear();
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

/** What the control Worker said of a reader's moderation role, and what is left to record of it. */
export interface ModeratorDecision {
  viewer: string;
  role: ModerationRole;
  epoch: number;
  /** A grant for this very decision is already held in Convex (this isolate recorded it, and it is still fresh). */
  recorded: boolean;
}

export interface ModerationSources {
  roles: RepoModerationSource;
  epochs: RevocationEpochs;
}

/** Per isolate: repository, reader and epoch → their role (null: none) and the expiry the decision holds until. */
const moderators = new Map<string, { role: ModerationRole | null; expiresAt: number; ttl: number }>();

function moderatorKey(repoId: number, viewer: string, epoch: number): string {
  return `${repoId}\u0000${viewer}\u0000${epoch}`;
}

function rememberModerator(key: string, entry: { role: ModerationRole | null; expiresAt: number; ttl: number }): void {
  moderators.delete(key);
  moderators.set(key, entry);
  if (moderators.size > MAX_ENTRIES) moderators.delete(moderators.keys().next().value as string);
}

/**
 * The moderation role of `viewer`, the signed-in reader of an authorized grant, on its repository (#259), asked of
 * the control Worker's mirror (never taken from the request). A private grant is the reader's own, at the epoch its
 * authorization rested on; a public one names no reader, so the reader's own epoch is read before the role is asked,
 * and Convex refuses what a later revocation already overtook. No role is the answer for no reader, for an
 * authorization about to end, and for a role the mirror cannot state: it throws only when it could not be asked.
 */
export async function moderatorDecision(sources: ModerationSources, grant: RepoGrant, viewer: string | null, now: number): Promise<ModeratorDecision | null> {
  if (viewer === null || grant.until <= now) return null;
  const epoch = grant.repo.private ? grant.epoch : await sources.epochs.currentEpoch(viewer);
  const key = moderatorKey(grant.repo.id, viewer, epoch);
  const known = moderators.get(key);
  if (known && known.expiresAt - now > known.ttl * REUSE_FRACTION) return known.role ? { viewer, role: known.role, epoch, recorded: true } : null;
  const role = await sources.roles.moderationRole(viewer, grant.repo.owner, grant.repo.name);
  if (role === null) {
    rememberModerator(key, { role: null, expiresAt: grant.until, ttl: grant.until - now });
    return null;
  }
  return { viewer, role, epoch, recorded: false };
}

/** Record a decided role in Convex (or reuse the one held). The role, or null when Convex refused it. Throws when it could not be asked. */
export async function recordModerator(grants: CommentGrants, grant: RepoGrant, decision: ModeratorDecision, now: number): Promise<ModerationRole | null> {
  if (decision.recorded) return decision.role;
  const key = moderatorKey(grant.repo.id, decision.viewer, decision.epoch);
  const expiresAt = await grants.recordModerator({ repoId: grant.repo.id, userId: decision.viewer, role: decision.role, epoch: decision.epoch, expiresAt: grant.until });
  moderators.delete(key);
  if (expiresAt === null) return null;
  rememberModerator(key, { role: decision.role, expiresAt, ttl: expiresAt - now });
  return decision.role;
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
