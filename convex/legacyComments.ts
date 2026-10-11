import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { requireId } from "./ids";
import { requireIdentity, orgSlugFromEmail, requireOrgIdentity, type AuthenticatedIdentity } from "./security";
import { validateClientOperationId, validateCommentAuthor } from "./commentOperations";

export const legacyOperationArgs = {
  orgSlug: v.optional(v.string()), filePath: v.optional(v.string()),
  clientOperationId: v.optional(v.string()), expectedAuthorId: v.optional(v.string()),
};
export type LegacyOperation = {
  orgSlug?: string; filePath?: string; clientOperationId?: string; expectedAuthorId?: string;
};

export async function authorizeLegacyComment(ctx: QueryCtx | MutationCtx, orgSlug: string, input: LegacyOperation = {}) {
  const identity = await requireOrgIdentity(ctx, orgSlug);
  validateCommentAuthor(input.expectedAuthorId, identity.subject);
  validateClientOperationId(input.clientOperationId);
  return identity;
}

export async function authorizeLegacyThread(ctx: QueryCtx | MutationCtx, input: LegacyOperation & { threadId: string }) {
  // Authenticate before validating an opaque ID or revealing record existence.
  const identity = await requireIdentity(ctx);
  const thread = await ctx.db.get(requireId(ctx, "threads", input.threadId));
  if (!thread || orgSlugFromEmail(identity.email) !== thread.orgSlug) throw new ConvexError("Comment not found");
  validateCommentAuthor(input.expectedAuthorId, identity.subject);
  validateClientOperationId(input.clientOperationId);
  validateLegacyScope(thread, input);
  return { thread, identity };
}

export function validateLegacyScope(thread: Doc<"threads">, input: LegacyOperation) {
  if ((input.orgSlug !== undefined && input.orgSlug !== thread.orgSlug)
    || (input.filePath !== undefined && input.filePath !== thread.filePath)) throw new ConvexError("Comment not found");
}

// v1 has no trusted organization binding: never infer admin rights from a slug.
export function canModifyLegacyComment(identity: AuthenticatedIdentity, comment: { authorId?: string; authorEmail: string }): boolean {
  return comment.authorId ? comment.authorId === identity.subject : comment.authorEmail.toLowerCase() === identity.email;
}
export function requireLegacyCommentAuthor(identity: AuthenticatedIdentity, comment: { authorId?: string; authorEmail: string }): void {
  if (!canModifyLegacyComment(identity, comment)) throw new ConvexError("Only the comment author can modify this legacy comment");
}
export function legacyBody(value: string): string {
  const body = value.trim();
  if (!body || body.length > 10_000) throw new ConvexError("Comment body is invalid");
  return body;
}
