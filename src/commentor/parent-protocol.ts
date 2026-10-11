import type { CommentRecoveryState } from "./operation-state";
export const COMMENTOR_PARENT_REQUEST = "commentor-parent-request";
export const COMMENTOR_PARENT_RESPONSE = "commentor-parent-response";
export const COMMENTOR_PARENT_UPDATE = "commentor-parent-update";
export const COMMENTOR_PARENT_ERROR = "commentor-parent-error";
export const COMMENTOR_PARENT_READY = "commentor-parent-ready";
export const COMMENTOR_PARENT_REPLIES_UPDATE = "commentor-parent-replies-update";

export type CommentorParentMethod =
  | "draft.save"
  | "operation.complete"
  | "subscribe"
  | "threads.more"
  | "replies.more"
  | "thread.create"
  | "thread.resolve"
  | "thread.archive"
  | "thread.remove"
  | "reply.add"
  | "reply.remove";

export type CommentorParentMutationMethod = Exclude<
  CommentorParentMethod,
  "subscribe" | "threads.more" | "replies.more" | "draft.save" | "operation.complete"
>;

export type CommentorParentRequest = {
  type: typeof COMMENTOR_PARENT_REQUEST;
  requestId: string;
  method: CommentorParentMethod;
  args: unknown;
};

export type CommentorParentResponse = {
  type: typeof COMMENTOR_PARENT_RESPONSE;
  requestId: string;
  ok: boolean;
  error?: string;
};

export type CommentorParentUpdate = {
  type: typeof COMMENTOR_PARENT_UPDATE;
  threads: unknown[];
  canLoadMore: boolean;
  loading: boolean;
};

export type CommentorParentRepliesUpdate = {
  type: typeof COMMENTOR_PARENT_REPLIES_UPDATE;
  threadId: string;
  replies: unknown[];
  canLoadMore: boolean;
  loading: boolean;
};

export type CommentorParentError = {
  type: typeof COMMENTOR_PARENT_ERROR;
  error: string;
};

export type CommentorParentReady = {
  type: typeof COMMENTOR_PARENT_READY;
  // Stable across resubscriptions; replaced when the parent host is recreated.
  parentGeneration: string;
  recoveryState?: CommentRecoveryState;
};

const METHODS = new Set<CommentorParentMethod>([
  "draft.save",
  "operation.complete",
  "subscribe",
  "threads.more",
  "replies.more",
  "thread.create",
  "thread.resolve",
  "thread.archive",
  "thread.remove",
  "reply.add",
  "reply.remove",
]);

export function isCommentorParentRequest(value: unknown): value is CommentorParentRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentRequest>;
  return candidate.type === COMMENTOR_PARENT_REQUEST
    && typeof candidate.requestId === "string"
    && candidate.requestId.length > 0
    && candidate.requestId.length <= 160
    && typeof candidate.method === "string"
    && METHODS.has(candidate.method as CommentorParentMethod);
}

export function isCommentorParentResponse(value: unknown): value is CommentorParentResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentResponse>;
  return candidate.type === COMMENTOR_PARENT_RESPONSE
    && typeof candidate.requestId === "string"
    && typeof candidate.ok === "boolean";
}

export function isCommentorParentUpdate(value: unknown): value is CommentorParentUpdate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentUpdate>;
  return candidate.type === COMMENTOR_PARENT_UPDATE
    && Array.isArray(candidate.threads)
    && typeof candidate.canLoadMore === "boolean"
    && typeof candidate.loading === "boolean";
}

export function isCommentorParentRepliesUpdate(value: unknown): value is CommentorParentRepliesUpdate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentRepliesUpdate>;
  return candidate.type === COMMENTOR_PARENT_REPLIES_UPDATE
    && typeof candidate.threadId === "string"
    && Array.isArray(candidate.replies)
    && typeof candidate.canLoadMore === "boolean"
    && typeof candidate.loading === "boolean";
}

export function isCommentorParentError(value: unknown): value is CommentorParentError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentError>;
  return candidate.type === COMMENTOR_PARENT_ERROR && typeof candidate.error === "string";
}

export function isCommentorParentReady(value: unknown): value is CommentorParentReady {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CommentorParentReady>;
  return candidate.type === COMMENTOR_PARENT_READY
    && typeof candidate.parentGeneration === "string"
    && candidate.parentGeneration.length > 0;
}
