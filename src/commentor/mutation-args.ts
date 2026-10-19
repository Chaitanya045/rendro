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
  const anchor = record(value);
  // Repository docs (#254) anchor by heading and quote, not by element path.
  if (anchor?.kind === "repo-text") return validRepoAnchor(anchor);
  if (
    !anchor
    || !Array.isArray(anchor.path)
    || anchor.path.length === 0
    || anchor.path.length > 64
    || !anchor.path.every((part) => typeof part === "string" && Boolean(part.trim()) && part.length <= 256)
  ) return false;
  if (anchor.kind === "element") return true;
  return anchor.kind === "text-range"
    && typeof anchor.quote === "string"
    && Boolean(anchor.quote.trim())
    && anchor.quote.length <= 4_096
    && Number.isSafeInteger(anchor.startOffset)
    && (anchor.startOffset as number) >= 0
    && (anchor.startOffset as number) <= 1_000_000
    && Number.isSafeInteger(anchor.endOffset)
    && (anchor.endOffset as number) >= 0
    && (anchor.endOffset as number) <= 1_000_000;
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
  if (method === "reply.add") return validBody(args.body) ? { ...operation, threadId, body: args.body.trim() } : null;
  if (method === "reply.remove") return typeof args.replyId === "string" && args.replyId
    ? { ...operation, threadId, replyId: args.replyId } : null;
  if (method === "thread.resolve" || method === "thread.archive") {
    const field = method === "thread.resolve" ? "resolved" : "archived";
    if (args[field] === undefined) return id === undefined ? { threadId } : null;
    return typeof args[field] === "boolean" ? { ...operation, threadId, [field]: args[field] } : null;
  }
  return { ...operation, threadId };
}
