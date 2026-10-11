import {
  COMMENTOR_PARENT_REQUEST,
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

export class CommentMutationOutcomeUnknownError extends Error {
  constructor() {
    super("The comment connection was replaced before confirmation. The outcome is unknown; your change may still be saved. Check the comments before making further changes.");
  }
}

export class ParentCommentTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private updateHandler: UpdateHandler | null = null;
  private repliesUpdateHandler: RepliesUpdateHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private slowHandler: SlowHandler | null = null;
  private refreshHandler: (() => void) | null = null;
  private sequence = 0;
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
  ): void {
    this.updateHandler = onUpdate;
    this.repliesUpdateHandler = onRepliesUpdate;
    this.errorHandler = onError;
    this.slowHandler = onSlowMutation ?? null;
    this.refreshHandler = onRefresh ?? null;
  }

  mutate(method: CommentorParentMutationMethod, args: unknown): Promise<void> {
    const key = this.mutationKey(method, args);
    const existing = this.mutations.get(key);
    if (existing) return existing;
    const operation = this.request(method, args).finally(() => {
      if (this.mutations.get(key) === operation) this.mutations.delete(key);
    });
    this.mutations.set(key, operation);
    return operation;
  }

  isMutationPending(method: CommentorParentMutationMethod, args: unknown = {}): boolean {
    return this.mutations.has(this.mutationKey(method, args));
  }

  private mutationKey(method: CommentorParentMutationMethod, args: unknown): string {
    const threadId = (args as { threadId?: string } | null)?.threadId;
    return JSON.stringify([method, threadId ?? null]);
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

  private request(method: CommentorParentMethod, args: unknown): Promise<void> {
    const requestId = `${Date.now()}-${++this.sequence}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const mutation = method.startsWith("thread.") || method === "reply.add";
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
    if (isCommentorParentReady(event.data)) {
      if (this.parentGeneration !== null && this.parentGeneration !== event.data.parentGeneration) {
        // The replacement host cannot acknowledge requests owned by its
        // predecessor. Settle them honestly without replaying any writes.
        this.retirePending(new CommentMutationOutcomeUnknownError());
      }
      this.parentGeneration = event.data.parentGeneration;
      if (this.updateHandler && this.errorHandler) {
        void this.refresh().catch(this.errorHandler);
      }
      return;
    }
    if (isCommentorParentError(event.data)) {
      this.errorHandler?.(new Error(event.data.error || "Comments could not be loaded"));
      return;
    }
    if (isCommentorParentRepliesUpdate(event.data)) {
      this.repliesUpdateHandler?.(
        event.data.threadId,
        event.data.replies,
        event.data.canLoadMore,
        event.data.loading,
      );
      return;
    }
    if (isCommentorParentUpdate(event.data)) {
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
    else request.reject(new Error(event.data.error || "Comment operation failed"));
  };
}
