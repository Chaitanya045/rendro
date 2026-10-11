import { normalizeMutationArgs } from "./mutation-args";
import { CommentOperationState, mutationKey } from "./operation-state";
import {
  COMMENTOR_PARENT_REQUEST,
  COMMENTOR_UPGRADE_NOTICE,
  COMMENTOR_VIEWER_RELOAD,
  isCommentorParentReadySignal,
  isCommentorParentError,
  isCommentorParentReady,
  isCommentorParentRepliesUpdate,
  isCommentorParentResponse,
  isCommentorParentUpdate,
  type CommentorParentMethod,
  type CommentorParentMutationMethod,
} from "./parent-protocol";

type UpdateHandler = (threads: unknown[], canLoadMore: boolean, loading: boolean) => void;
type RepliesUpdateHandler = (
  threadId: string,
  replies: unknown[],
  canLoadMore: boolean,
  loading: boolean,
) => void;
type ErrorHandler = (error: Error) => void;
type SlowHandler = () => void | (() => void);

type PendingRequest = {
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: number;
  dismissSlow?: () => void;
};

export class CommentMutationRejectedError extends Error {}

export class CommentMutationOutcomeUnknownError extends Error {
  constructor() {
    super("The comment connection was replaced before confirmation. The outcome is unknown; your change may still be saved. Resubmitting this action is safe; it will reuse the original operation.");
  }
}

export class ParentCommentTransport {
  readonly recovery = new CommentOperationState();
  private readonly pending = new Map<string, PendingRequest>();
  private updateHandler: UpdateHandler | null = null;
  private repliesUpdateHandler: RepliesUpdateHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private slowHandler: SlowHandler | null = null;
  private refreshHandler: (() => void) | null = null;
  private compatible = false;
  private canReloadViewer = false;
  private compatibilityHandler: ((compatible: boolean, canReloadViewer: boolean) => void) | null = null;
  private sequence = 0;
  private userId: string | null | undefined;
  private identityChangeHandler: (() => void) | null = null;
  private parentGeneration: string | null = null;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(
    private readonly parent: Pick<WindowProxy, "postMessage">,
    private readonly events: Pick<Window, "addEventListener" | "removeEventListener">,
    private readonly documentPath: string,
  ) {
    this.events.addEventListener("message", this.onMessage as EventListener);
  }

  subscribe(
    onUpdate: UpdateHandler,
    onRepliesUpdate: RepliesUpdateHandler,
    onError: ErrorHandler,
    onSlowMutation?: SlowHandler,
    onRefresh?: () => void,
    onIdentityChange?: () => void,
    onCompatibility?: (compatible: boolean, canReloadViewer: boolean) => void,
  ): void {
    this.updateHandler = onUpdate;
    this.repliesUpdateHandler = onRepliesUpdate;
    this.errorHandler = onError;
    this.slowHandler = onSlowMutation ?? null;
    this.refreshHandler = onRefresh ?? null;
    this.compatibilityHandler = onCompatibility ?? null;
    this.identityChangeHandler = onIdentityChange ?? null;
  }

  mutate(method: CommentorParentMutationMethod, args: unknown): Promise<void> {
    if (!this.compatible) return Promise.reject(new Error(COMMENTOR_UPGRADE_NOTICE));
    const key = mutationKey(method, (args ?? {}) as Record<string, unknown>);
    const existing = this.mutations.get(key);
    if (existing) return existing;
    const normalized = normalizeMutationArgs(method, args);
    if (!normalized || (method === "thread.resolve" && normalized.resolved === undefined)
      || (method === "thread.archive" && normalized.archived === undefined)) return Promise.reject(new CommentMutationRejectedError("Comment arguments are invalid (comments must contain 1–10,000 characters)."));
    let prepared;
    try { prepared = this.recovery.prepare(method, normalized); }
    catch (error) { return Promise.reject(error); }
    const operation = this.request(method, { ...prepared.args, clientOperationId: prepared.clientOperationId }).then(() => {
      this.recovery.complete(key, prepared.clientOperationId);
    }).catch((error: unknown) => {
      if (error instanceof CommentMutationRejectedError) this.recovery.reject(key, prepared.clientOperationId);
      throw error;
    }).finally(() => {
      if (this.mutations.get(key) === operation) this.mutations.delete(key);
    });
    this.mutations.set(key, operation);
    return operation;
  }

  isMutationPending(method: CommentorParentMutationMethod, args: unknown = {}): boolean {
    return this.mutations.has(mutationKey(method, (args ?? {}) as Record<string, unknown>));
  }

  saveDraft(key: string, args: Record<string, unknown>): void {
    if (!this.compatible) return;
    this.recovery.draft(key, args);
    void this.request("draft.save", { key, draft: args }).catch(() => {
      this.errorHandler?.(new Error("Comment draft could not be saved"));
    });
  }

  private complete(key: string, id: string): void {
    this.recovery.complete(key, id);
    void this.request("operation.complete", { key, clientOperationId: id }).catch(() => {});
  }

  private reconcile(rows: unknown[]): void {
    const records = rows as Array<Record<string, unknown>>;
    const all = records.flatMap((row) => [row, ...(Array.isArray(row.replies) ? row.replies : [])]) as Array<Record<string, unknown>>;
    for (const [key, op] of Object.entries(this.recovery.value.operations)) {
      const found = all.some((row) => row.clientOperationId === op.clientOperationId);
      // A matching status boolean does not identify who applied it. Status
      // operations settle only on their own mutation acknowledgement/receipt.
      // Absence from a paginated subscription is never proof of deletion.
      if (found && (op.method === "thread.create" || op.method === "reply.add")) this.complete(key, op.clientOperationId);
    }
  }

  refresh(): Promise<void> {
    // Keep this realm, request IDs and write guards alive while the parent
    // replaces only its subscriptions. Never replay outstanding mutations.
    this.refreshHandler?.();
    return this.request("subscribe", { documentPath: this.documentPath });
  }

  loadMoreThreads(): Promise<void> {
    return this.request("threads.more", {});
  }

  loadMoreReplies(threadId: string): Promise<void> {
    return this.request("replies.more", { threadId });
  }

  dispose(): void {
    this.events.removeEventListener("message", this.onMessage as EventListener);
    this.retirePending(new Error("Comment transport closed"));
    this.updateHandler = null;
    this.repliesUpdateHandler = null;
    this.errorHandler = null;
    this.slowHandler = null;
    this.refreshHandler = null;
    this.identityChangeHandler = null;
    this.compatibilityHandler = null;
    this.compatible = false;
    this.canReloadViewer = false;
  }

  private retirePending(error: Error): void {
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timeout);
      request.dismissSlow?.();
      request.reject(error);
    }
    this.pending.clear();
    this.mutations.clear();
  }

  reloadViewer(): void {
    if (this.canReloadViewer) this.parent.postMessage({ type: COMMENTOR_VIEWER_RELOAD }, "*");
  }

  private request(method: CommentorParentMethod, args: unknown): Promise<void> {
    if (!this.compatible) return Promise.reject(new Error(COMMENTOR_UPGRADE_NOTICE));
    const requestId = `${Date.now()}-${++this.sequence}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      // Mirror CommentorParentMutationMethod: only subscription/pagination
      // requests may time out. Every write must keep its guard and late ack.
      const mutation = method !== "subscribe" && method !== "threads.more" && method !== "replies.more" && method !== "draft.save" && method !== "operation.complete";
      const timeout = window.setTimeout(() => {
        if (mutation) {
          // Convex retries disconnected mutations and may commit before its
          // acknowledgement arrives. A deadline cannot establish failure.
          // Keep the operation pending and accept the eventual server result;
          // never resubmit toggles, creates or replies on a timer.
          const pending = this.pending.get(requestId);
          if (pending) pending.dismissSlow = this.slowHandler?.() || undefined;
          return;
        }
        this.pending.delete(requestId);
        reject(new Error("Comments are taking longer to load. Still waiting for the connection."));
      }, mutation ? 60_000 : 10_000);
      this.pending.set(requestId, { resolve, reject, timeout });
      this.parent.postMessage({
        type: COMMENTOR_PARENT_REQUEST,
        requestId,
        method,
        args,
      }, "*");
    });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.parent) return;
    if (isCommentorParentReadySignal(event.data)) {
      this.compatible = isCommentorParentReady(event.data);
      this.canReloadViewer = event.data.canReloadViewer === true;
      this.compatibilityHandler?.(this.compatible, this.canReloadViewer);
      if (!isCommentorParentReady(event.data)) {
        this.retirePending(new CommentMutationOutcomeUnknownError());
        return;
      }
      if (this.parentGeneration !== null && this.parentGeneration !== event.data.parentGeneration) {
        // The replacement host cannot acknowledge requests owned by its
        // predecessor. Settle them honestly without replaying any writes.
        this.retirePending(new CommentMutationOutcomeUnknownError());
      }
      const identityChanged = this.userId !== undefined && event.data.userId !== undefined && this.userId !== event.data.userId;
      if (event.data.userId !== undefined) this.userId = event.data.userId;
      if (event.data.recoveryState) this.recovery.value = event.data.recoveryState;
      if (identityChanged) this.identityChangeHandler?.();
      this.parentGeneration = event.data.parentGeneration;
      if (this.updateHandler && this.errorHandler) {
        void this.refresh().catch(this.errorHandler);
      }
      return;
    }
    if (!this.compatible) return;
    if (isCommentorParentError(event.data)) {
      this.errorHandler?.(new Error(event.data.error || "Comments could not be loaded"));
      return;
    }
    if (isCommentorParentRepliesUpdate(event.data)) {
      this.reconcile(event.data.replies);
      this.repliesUpdateHandler?.(
        event.data.threadId,
        event.data.replies,
        event.data.canLoadMore,
        event.data.loading,
      );
      return;
    }
    if (isCommentorParentUpdate(event.data)) {
      this.reconcile(event.data.threads);
      this.updateHandler?.(event.data.threads, event.data.canLoadMore, event.data.loading);
      return;
    }
    if (!isCommentorParentResponse(event.data)) return;
    const request = this.pending.get(event.data.requestId);
    if (!request) return;
    this.pending.delete(event.data.requestId);
    window.clearTimeout(request.timeout);
    request.dismissSlow?.();
    if (event.data.ok) request.resolve();
    else request.reject(event.data.rejected === true
      ? new CommentMutationRejectedError(event.data.error || "Comment operation failed")
      : new Error(event.data.error || "Comment operation failed"));
  };
}
