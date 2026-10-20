import type { CommentorParentMutationMethod } from "./parent-protocol";
import { validRepoAnchor } from "./repo-anchor";

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validBody(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 10_000;
}

export function validAnchor(value: unknown): boolean {
  // Repository docs (#254) anchor by heading and quote, not by element path.
  const anchor = record(value);
  return anchor?.kind === "repo-text" && validRepoAnchor(anchor);
}

// Validate before assigning an identity or persisting a submitted draft.
export function normalizeMutationArgs(method: CommentorParentMutationMethod, value: unknown): Record<string, unknown> | null {
  const args = record(value);
  if (!args) return null;
  const id = args.clientOperationId;
  if (id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 128)) return null;
  const operation = id === undefined ? {} : { clientOperationId: id };
  if (method === "thread.create") return validBody(args.body) && validAnchor(args.anchor)
    ? { ...operation, body: args.body.trim(), anchor: args.anchor } : null;
  const threadId = args.threadId;
  if (typeof threadId !== "string" || !threadId) return null;
  if (method === "reply.add" || method === "thread.edit") return validBody(args.body) ? { ...operation, threadId, body: args.body.trim() } : null;
  const replyId = typeof args.replyId === "string" && args.replyId ? args.replyId : null;
  if (method === "reply.remove") return replyId ? { ...operation, threadId, replyId } : null;
  if (method === "reply.edit") return replyId && validBody(args.body) ? { ...operation, threadId, replyId, body: args.body.trim() } : null;
  if (method === "thread.resolve" || method === "thread.archive") {
    // Status writes always name their target, so a retry is idempotent.
    const field = method === "thread.resolve" ? "resolved" : "archived";
    return typeof args[field] === "boolean" ? { ...operation, threadId, [field]: args[field] } : null;
  }
  return { ...operation, threadId };
}
