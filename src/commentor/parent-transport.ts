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

export class ParentCommentTransport {
  private readonly pending = new Map<string, PendingRequest>();
  private updateHandler: UpdateHandler | null = null;
  private repliesUpdateHandler: RepliesUpdateHandler | null = null;
  private errorHandler: ErrorHandler | null = null;
  private slowHandler: SlowHandler | null = null;
  private sequence = 0;

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
  ): void {
    this.updateHandler = onUpdate;
    this.repliesUpdateHandler = onRepliesUpdate;
    this.errorHandler = onError;
    this.slowHandler = onSlowMutation ?? null;
  }

  mutate(method: CommentorParentMutationMethod, args: unknown): Promise<void> {
    return this.request(method, args);
  }

  loadMoreThreads(): Promise<void> {
    return this.request("threads.more", {});
  }

  loadMoreReplies(threadId: string): Promise<void> {
    return this.request("replies.more", { threadId });
  }

  dispose(): void {
    this.events.removeEventListener("message", this.onMessage as EventListener);
    for (const request of this.pending.values()) {
      window.clearTimeout(request.timeout);
      request.dismissSlow?.();
      request.reject(new Error("Comment transport closed"));
    }
    this.pending.clear();
    this.updateHandler = null;
    this.repliesUpdateHandler = null;
    this.errorHandler = null;
    this.slowHandler = null;
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
        reject(new Error("Comments are taking longer to load. Refresh the page."));
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
      // A BFCache restore creates a fresh parent host while this child realm
      // survives, so each parent-ready generation needs a fresh subscription.
      if (this.updateHandler && this.errorHandler) {
        void this.request("subscribe", { documentPath: this.documentPath }).catch(this.errorHandler);
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
