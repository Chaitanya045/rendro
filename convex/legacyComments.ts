import { requireLegacyMember } from "./legacyAccess";
import { v } from "convex/values";
import { publicError } from "./publicErrors";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import { requireId } from "./ids";
import { requireIdentity, type AuthenticatedIdentity } from "./security";
import { validateClientOperationId, validateCommentAuthor } from "./commentOperations";

export const legacyOperationArgs = {
  orgSlug: v.optional(v.string()), filePath: v.optional(v.string()),
  clientOperationId: v.optional(v.string()), expectedAuthorId: v.optional(v.string()),
};
export type LegacyOperation = {
  orgSlug?: string; filePath?: string; clientOperationId?: string; expectedAuthorId?: string;
};

export async function authorizeLegacyComment(ctx: QueryCtx | MutationCtx, orgSlug: string, input: LegacyOperation = {}) {
  const identity = await requireIdentity(ctx);
  const authorized = await requireLegacyMember(ctx, orgSlug);
  const role = authorized.member.role;
  const result = { ...identity, admin: role.split(",").some(value => ["owner", "admin"].includes(value.trim())) };
  validateCommentAuthor(input.expectedAuthorId, identity.subject);
  validateClientOperationId(input.clientOperationId);
  return result;
}

export async function authorizeLegacyThread(ctx: QueryCtx | MutationCtx, input: LegacyOperation & { threadId: string }) {
  // Authenticate before validating an opaque ID or revealing record existence.
  await requireIdentity(ctx);
  const thread = await ctx.db.get(requireId(ctx, "threads", input.threadId));
  if (!thread) publicError("not_found");
  const identity = await authorizeLegacyComment(ctx, thread.orgSlug, input);
  validateLegacyScope(thread, input);
  return { thread, identity };
}

export function validateLegacyScope(thread: Doc<"threads">, input: LegacyOperation) {
  if ((input.orgSlug !== undefined && input.orgSlug !== thread.orgSlug)
    || (input.filePath !== undefined && input.filePath !== thread.filePath)) publicError("not_found");
}

// Modern comment rules: the author or a live mapped organization administrator.
export function canModifyLegacyComment(identity: AuthenticatedIdentity & { admin?: boolean }, comment: { authorId?: string; authorEmail: string }): boolean {
  return identity.admin === true || (comment.authorId ? comment.authorId === identity.subject : comment.authorEmail.toLowerCase() === identity.email);
}
export function requireLegacyCommentAuthor(identity: AuthenticatedIdentity & { admin?: boolean }, comment: { authorId?: string; authorEmail: string }): void {
  if (!canModifyLegacyComment(identity, comment)) publicError("forbidden");
}
export function legacyBody(value: string): string {
  const body = value.trim();
  if (!body || body.length > 10_000) publicError("invalid_input");
  return body;
}
