import { ConvexError } from "convex/values";
import { showViewerUpdateNotice } from "../viewer/client";
import { commentErrorMessage, commentRetryAfter, isDefinitiveCommentRejection } from "./errors";
import { COMMENT_RECOVERY_PREFIX, syncCommentRecoveryUser } from "./recovery-session";
import { whenVisible } from "./visibility";
import { normalizeMutationArgs, record, validAnchor } from "./mutation-args";
import { CommentOperationState, mutationKey } from "./operation-state";
import { ConvexClient } from "convex/browser";
import { parseRepoPath } from "../repo-read/paths";
import { CONTENT_FRAME_EVENT, shellFrameNavigation } from "../viewer/content-frame";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  COMMENTOR_PARENT_RESPONSE,
  COMMENTOR_PARENT_UPDATE,
  COMMENTOR_PARENT_ERROR,
  COMMENTOR_PARENT_READY,
  COMMENTOR_PROTOCOL_VERSION,
  COMMENTOR_VIEWER_RELOAD,
  COMMENTOR_PARENT_REPLIES_UPDATE,
  isCommentorParentRequest,
  type CommentorParentMutationMethod,
} from "./parent-protocol";

const PAGE_SIZE = 20;
/** Real-user monitoring (#282) reads these from the shell's performance timeline: repository docs only. */
export const COMMENTS_READY_MEASURE = "rendro:comments";
export const COMMENT_ECHO_MEASURE = "rendro:comment-echo";

/** A duration on the performance timeline, `kind` saying whether it belongs to the shell's opening page. */
function measure(name: string, start: number, kind: "cold" | "switch"): void {
  try {
    performance.measure(name, { start, end: performance.now(), detail: { kind } });
  } catch {
    // A browser without User Timing's measure options reports nothing; comments work the same.
  }
}

type CommentPaginationState = {
  canLoadMore: boolean;
  loading: boolean;
};

/** A repository doc (#254): the shell's repository and the page its frame shows. */
export type DocumentCommentScope = { repoId: number; documentPath: string };

/** The repository shell's comments (#254): where it asks the read path for comment access, and the document it opens with (#284). */
export type CommentorParentConfig = { repoId: number; accessUrl: string; convexUrl: string; documentPath?: string };

/** The first page of one document's threads, from the first comment-access answer (#284). */
export type RepoCommentSnapshot = { documentPath: string; threads: unknown[]; canLoadMore: boolean };

export interface DocumentCommentBackend {
  subscribe(
    scope: DocumentCommentScope,
    onUpdate: (threads: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription;
  subscribeReplies(
    scope: DocumentCommentScope,
    threadId: Id<"repoThreads">,
    onUpdate: (replies: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription;
  mutate(
    method: CommentorParentMutationMethod,
    scope: DocumentCommentScope,
    args: unknown,
  ): Promise<unknown>;
}

export interface CommentPaginationSubscription {
  unsubscribe(): void;
  loadMore(): boolean;
}

export function documentCommentScopeFromFrame(
  frameUrl: string,
  pageOrigin: string,
  config: { repoId: number; accessUrl: string },
): DocumentCommentScope | null {
  let url: URL;
  try {
    url = new URL(frameUrl, pageOrigin);
  } catch {
    return null;
  }
  if (url.origin !== pageOrigin) return null;
  // The frame must show a page of the shell's own repository, at any ref; the read path parses it the same way.
  const frame = parseRepoPath(url.pathname);
  const shell = parseRepoPath(config.accessUrl);
  if (!frame || !shell || frame.target.kind !== "files"
    || `${frame.owner}/${frame.name}`.toLowerCase() !== `${shell.owner}/${shell.name}`.toLowerCase()) return null;
  return { repoId: config.repoId, documentPath: frame.target.path };
}

/** The thread a draft belongs to: a reply box's is keyed by its thread, an edit's (#287) by `editDraftKey`. */
function draftThread(key: string): string {
  const [kind, threadId, replyId, ...rest] = key.split(":");
  return kind === "edit" && threadId && replyId !== "" && rest.length === 0 ? threadId : key;
}

export function sameScope(left: DocumentCommentScope | null, right: DocumentCommentScope | null): boolean {
  return Boolean(left && right && left.documentPath === right.documentPath && left.repoId === right.repoId);
}

export class CommentorParentHost {
  private activeScope: DocumentCommentScope | null = null;
  private loadedScope: DocumentCommentScope | null = null;
  private activeSource: MessageEventSource | null = null;
  private threadSubscription: CommentPaginationSubscription | null = null;
  private replySubscriptions = new Map<string, CommentPaginationSubscription>();
  private threadIds = new Set<string>();
  private generation = 0;
  // Subscription refreshes must not invalidate outstanding mutation responses.
  private connectionGeneration = 0;
  private parentGeneration = crypto.randomUUID();
  private requestTokens = 20;
  private requestBudgetAt = performance.now();
  private mutationsInFlight = 0;
  // Repository docs (#254): may this reader write, as the read path last said? Anyone may read a public repository.
  private writable: boolean;
  // Repository docs (#284): until the first comment-access answer has recorded this reader's grant, a live
  // subscription would only see the empty page Convex gives a reader without one, so it waits.
  private liveHeld = false;
  private startLive: (() => void) | null = null;
  // That answer's first page of the opening document, shown until the live subscription delivers its own.
  private snapshot: { scope: DocumentCommentScope; threads: unknown[]; canLoadMore: boolean } | null = null;
  // Real-user monitoring (#284): the pages this shell has shown, when the current one began (the opening page at
  // navigation start, as the lazy tree's measures count it; later ones at their frame's load), and whether its first
  // comments have been measured yet.
  private documents = 0;
  private documentStart = 0;
  private readyMeasured = true;

  private allowBackendRequest(): boolean {
    const now = performance.now();
    this.requestTokens = Math.min(20, this.requestTokens + (now - this.requestBudgetAt) / 1000);
    this.requestBudgetAt = now;
    if (this.requestTokens < 1) return false;
    this.requestTokens--;
    return true;
  }

  constructor(
    private frame: HTMLIFrameElement,
    private readonly pageOrigin: string,
    private readonly config: CommentorParentConfig,
    private readonly backend: DocumentCommentBackend,
    private userId: string | null,
  ) {
    this.writable = false;
    syncCommentRecoveryUser(window.sessionStorage, userId);
  }

  /** The read path's latest answer on comment access (repository docs): tell the widget when it changes. */
  setWritable(writable: boolean): void {
    if (this.writable === writable) return;
    this.writable = writable;
    this.announce();
  }

  /** Hold live thread subscriptions until `accessAnswered` (repository docs, #284). */
  holdLive(): void {
    this.liveHeld = true;
  }

  /**
   * The first comment-access answer came back (#284), with the opening document's first thread page when the read
   * path served one. A subscription waiting for it shows that page and starts live; the live page then replaces it.
   */
  accessAnswered(snapshot: RepoCommentSnapshot | null): void {
    if (snapshot) {
      this.snapshot = { scope: { repoId: this.config.repoId, documentPath: snapshot.documentPath }, threads: snapshot.threads, canLoadMore: snapshot.canLoadMore };
    }
    this.liveHeld = false;
    const start = this.startLive;
    this.startLive = null;
    start?.();
  }

  setUserId(userId: string | null): void {
    if (this.userId === userId) return;
    syncCommentRecoveryUser(window.sessionStorage, userId);
    this.userId = userId;
    this.parentGeneration = crypto.randomUUID();
    this.reload();
  }

  /** The shell made another, already loaded iframe the content frame (an adopted preload): talk to that one now. */
  replaceFrame(frame: HTMLIFrameElement): void {
    if (frame === this.frame) return;
    this.frame.removeEventListener("load", this.onFrameLoad);
    this.frame = frame;
    frame.addEventListener("load", this.onFrameLoad);
    this.onFrameLoad();
  }

  start(frameAlreadyLoaded = false): void {
    window.addEventListener("message", this.onMessage);
    this.frame.addEventListener("load", this.onFrameLoad);
    if (frameAlreadyLoaded) this.onFrameLoad();
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    this.frame.removeEventListener("load", this.onFrameLoad);
    this.connectionGeneration += 1;
    this.reset();
    this.loadedScope = null;
  }

  private recovery(scope: DocumentCommentScope): CommentOperationState {
    if (!window.sessionStorage) throw new Error("Durable comment storage unavailable");
    // Every caller has already rejected an unauthenticated request.
    return new CommentOperationState(window.sessionStorage, `${COMMENT_RECOVERY_PREFIX}${JSON.stringify([this.userId, scope])}`, this.userId!);
  }

  private currentScope(): DocumentCommentScope | null {
    // A document the frame loaded by itself has no comment session (#296): it is not the page `src` names.
    if (shellFrameNavigation(this.frame) === null) return null;
    return documentCommentScopeFromFrame(this.frame.src, this.pageOrigin, this.config);
  }

  private reset(): void {
    this.generation += 1;
    this.threadSubscription?.unsubscribe();
    this.threadSubscription = null;
    this.startLive = null;
    for (const subscription of this.replySubscriptions.values()) subscription.unsubscribe();
    this.replySubscriptions.clear();
    this.activeScope = null;
    this.activeSource = null;
    this.threadIds.clear();
  }

  private readonly onFrameLoad = (): void => {
    this.documents += 1;
    this.documentStart = this.documents === 1 ? 0 : performance.now();
    this.readyMeasured = false;
    this.reload();
  };

  private pageKind(): "cold" | "switch" {
    return this.documents === 1 ? "cold" : "switch";
  }

  private reload(): void {
    this.connectionGeneration += 1;
    this.reset();
    this.loadedScope = this.currentScope();
    this.announce();
  }

  private announce(): void {
    const source = this.frame.contentWindow;
    if (this.loadedScope && source) {
      try {
        source.postMessage({
          type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, canReloadViewer: true, parentGeneration: this.parentGeneration,
          userId: this.userId, recoveryState: this.userId ? this.recovery(this.loadedScope).value : { operations: {}, drafts: {} },
          // A repository frame is the same for every reader, so the widget learns here whether this one may write.
          canWrite: this.userId !== null && this.writable, edits: true,
        }, "*");
      } catch { this.subscriptionError(source); }
    }
  }

  private owns(generation: number, source: MessageEventSource, scope: DocumentCommentScope): boolean {
    return generation === this.generation && this.ownsConnection(this.connectionGeneration, source, scope);
  }

  private ownsConnection(generation: number, source: MessageEventSource, scope: DocumentCommentScope): boolean {
    return generation === this.connectionGeneration
      && source === this.activeSource
      && source === this.frame.contentWindow
      && sameScope(scope, this.activeScope)
      && sameScope(scope, this.loadedScope)
      && sameScope(scope, this.currentScope());
  }

  private respond(source: MessageEventSource, requestId: string, ok: boolean, error?: string, rejected = !ok, retryAfter?: number): void {
    if (!("postMessage" in source) || typeof source.postMessage !== "function") return;
    (source as WindowProxy).postMessage({
      type: COMMENTOR_PARENT_RESPONSE,
      requestId,
      ok,
      ...(error ? { error, rejected } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    }, "*");
  }

  private subscriptionError(source: MessageEventSource, error?: unknown): void {
    if (!("postMessage" in source) || typeof source.postMessage !== "function") return;
    (source as WindowProxy).postMessage({
      type: COMMENTOR_PARENT_ERROR,
      error: commentErrorMessage(error, "Comments could not be loaded"),
    }, "*");
  }

  private subscribe(source: MessageEventSource, requestId: string, scope: DocumentCommentScope): void {
    this.reset();
    this.activeScope = scope;
    this.activeSource = source;
    const generation = this.generation;
    const deliver = (threads: unknown[], state: CommentPaginationState) => {
      // A first page still loading carries no rows (the widget keeps what it shows): keep the IDs it may write to.
      if (!state.loading || threads.length > 0) {
        this.threadIds = new Set(threads.flatMap((thread) => {
          const value = record(thread)?._id;
          return typeof value === "string" ? [value] : [];
        }));
        for (const [threadId, subscription] of this.replySubscriptions) {
          if (this.threadIds.has(threadId)) continue;
          subscription.unsubscribe();
          this.replySubscriptions.delete(threadId);
        }
      }
      if ("postMessage" in source && typeof source.postMessage === "function") {
        (source as WindowProxy).postMessage({
          type: COMMENTOR_PARENT_UPDATE,
          threads,
          ...state,
        }, "*");
      }
      // The page's first comments (snapshot or live) have reached its widget.
      if (!state.loading && !this.readyMeasured) {
        this.readyMeasured = true;
        measure(COMMENTS_READY_MEASURE, this.documentStart, this.pageKind());
      }
    };
    const begin = () => {
      // A snapshot of this page (#284) is shown at once; one of another page is never shown, and is stale by now.
      const snapshot = this.snapshot;
      if (snapshot && !sameScope(snapshot.scope, scope)) this.snapshot = null;
      else if (snapshot) deliver(snapshot.threads, { canLoadMore: snapshot.canLoadMore, loading: false });
      this.threadSubscription = this.backend.subscribe(scope, (threads, state) => {
        if (!this.owns(generation, source, scope)) return;
        // The live page has arrived: it supersedes the snapshot, adding, removing and editing as it says.
        if (!state.loading || threads.length > 0) this.snapshot = null;
        deliver(threads, state);
      }, (error) => {
        if (this.owns(generation, source, scope)) this.subscriptionError(source, error);
      });
    };
    if (this.liveHeld) this.startLive = begin;
    else begin();
    this.respond(source, requestId, true);
  }

  private mutationArgs(method: CommentorParentMutationMethod, value: unknown): unknown | null {
    const args = normalizeMutationArgs(method, value);
    if (!args) return null;
    if (method === "thread.create") return args;
    const clientOperationId = args.clientOperationId;
    // normalizeMutationArgs only accepts the other methods with a non-empty string thread ID.
    const threadId = args.threadId as string;
    if (!this.threadIds.has(threadId)) {
      // An acknowledged deletion can disappear from the page before a retry.
      // Only a durable removal from this document may bypass the visible IDs.
      try {
        const pending = this.activeScope && this.recovery(this.activeScope).value.operations[mutationKey(method, args)];
        if ((method !== "thread.remove" && method !== "reply.remove") || !pending
          || pending.clientOperationId !== clientOperationId) return null;
      } catch { return null; }
    }
    return args;
  }

  private loadMoreReplies(
    source: MessageEventSource,
    requestId: string,
    scope: DocumentCommentScope,
    value: unknown,
  ): void {
    const args = record(value);
    const threadId = args?.threadId;
    if (typeof threadId !== "string" || !this.threadIds.has(threadId)) {
      this.respond(source, requestId, false, "Comment operation is outside this document");
      return;
    }
    const existing = this.replySubscriptions.get(threadId);
    if (existing) {
      if (!existing.loadMore()) {
        this.respond(source, requestId, false, "No older replies are available");
      } else {
        this.respond(source, requestId, true);
      }
      return;
    }
    const generation = this.generation;
    const subscription = this.backend.subscribeReplies(
      scope,
      threadId as Id<"repoThreads">,
      (replies, state) => {
        if (!this.owns(generation, source, scope) || !this.threadIds.has(threadId)) return;
        if ("postMessage" in source && typeof source.postMessage === "function") {
          (source as WindowProxy).postMessage({
            type: COMMENTOR_PARENT_REPLIES_UPDATE,
            threadId,
            replies,
            ...state,
          }, "*");
        }
      },
      (error) => {
        if (this.owns(generation, source, scope)) this.subscriptionError(source, error);
      },
    );
    this.replySubscriptions.set(threadId, subscription);
    this.respond(source, requestId, true);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    // Nothing is answered to a document the shell did not load (#296), not even a refusal.
    if (event.source !== this.frame.contentWindow || shellFrameNavigation(this.frame) === null) return;
    if (record(event.data)?.type === COMMENTOR_VIEWER_RELOAD) {
      // Publisher code shares this opaque frame with the widget. Neither the
      // source check nor a claimed gesture can authorize navigation. Only the
      // reader's Reload button in the parent-owned notice can reload the page.
      const scope = this.currentScope();
      if (scope && sameScope(scope, this.loadedScope)) showViewerUpdateNotice(window, "Reload this document to continue.");
      return;
    }
    if (!isCommentorParentRequest(event.data)) return;
    const scope = this.currentScope();
    // Anyone may read a public repository's comments; every write (and draft) still needs the signed-in reader.
    const reading = event.data.method === "subscribe" || event.data.method === "threads.more" || event.data.method === "replies.more";
    // The shell has already sent this frame to another page (#284): a read from the page it is leaving is for a
    // document that is no longer current. It is dropped without an answer, so the leaving page shows no error.
    if (reading && this.loadedScope && !sameScope(scope, this.loadedScope)) return;
    const anonymous = !this.userId && !reading;
    if (anonymous || !scope || !sameScope(scope, this.loadedScope) || !event.source) {
      if (event.source) this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
      return;
    }
    if (event.data.method === "subscribe") {
      const claim = record(event.data.args)?.documentPath;
      if (claim !== scope.documentPath) {
        this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
        return;
      }
      if (!this.allowBackendRequest()) return;
      this.subscribe(event.source, event.data.requestId, scope);
      return;
    }
    if (!sameScope(scope, this.activeScope) || event.source !== this.activeSource) {
      this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
      return;
    }
    // Local recovery writes remain available even while backend requests are
    // throttled. A withheld reply keeps pending mutations retryable (#19).
    if (event.data.method !== "draft.save" && event.data.method !== "operation.complete"
      && (this.mutationsInFlight >= 20 || !this.allowBackendRequest())) return;
    if (event.data.method === "threads.more") {
      if (!this.threadSubscription?.loadMore()) {
        this.respond(event.source, event.data.requestId, false, "No older comments are available");
      } else {
        this.respond(event.source, event.data.requestId, true);
      }
      return;
    }
    if (event.data.method === "replies.more") {
      this.loadMoreReplies(event.source, event.data.requestId, scope, event.data.args);
      return;
    }
    if (event.data.method === "draft.save" || event.data.method === "operation.complete") {
      const args = record(event.data.args);
      try {
        const state = this.recovery(scope);
        if (typeof args?.key !== "string" || args.key.length > 256) throw new Error("Invalid state key");
        if (event.data.method === "draft.save") {
          const draft = record(args.draft);
          if (!draft || typeof draft.body !== "string" || draft.body.length > 10_000
            || (args.key !== "create" && !this.threadIds.has(draftThread(args.key)))
            || (args.key === "create" && !validAnchor(draft.anchor))) throw new Error("Invalid draft");
          state.draft(args.key, draft);
        } else if (typeof args.clientOperationId === "string") state.complete(args.key, args.clientOperationId);
        this.respond(event.source, event.data.requestId, true);
      } catch { this.respond(event.source, event.data.requestId, false, "Comment recovery state could not be saved"); }
      return;
    }
    const args = this.mutationArgs(event.data.method, event.data.args);
    if (!args) {
      this.respond(event.source, event.data.requestId, false, "Comment operation is outside this document");
      return;
    }
    let operation;
    try {
      const state = this.recovery(scope);
      operation = state.prepare(event.data.method, args as Record<string, unknown>);
      // Ensure writes cannot escape if durable storage is unavailable.
      state.save();
    } catch {
      this.respond(event.source, event.data.requestId, false, "Comment recovery state could not be saved");
      return;
    }
    const generation = this.connectionGeneration;
    const key = mutationKey(operation.method, operation.args);
    // The reader's own thread or reply shows at once (#284); this is how long it takes to be saved.
    const sentAt = performance.now();
    const echo = (operation.method === "thread.create" || operation.method === "reply.add");
    this.mutationsInFlight++;
    void this.backend.mutate(operation.method, scope, { ...operation.args, clientOperationId: operation.clientOperationId, expectedAuthorId: this.userId }).then(() => {
      // An abandoned acknowledgement cannot retire the durable identity: the
      // replacement widget may still hold (or save) the unconfirmed draft.
      if (this.ownsConnection(generation, event.source!, scope)) {
        if (echo) measure(COMMENT_ECHO_MEASURE, sentAt, this.pageKind());
        this.recovery(scope).complete(key, operation.clientOperationId);
        this.respond(event.source!, event.data.requestId, true);
      }
    }).catch((error: unknown) => {
      if (this.ownsConnection(generation, event.source!, scope)) {
        // Only known definitive rejections release the durable operation identity.
        const rejected = isDefinitiveCommentRejection(error);
        if (rejected) this.recovery(scope).reject(key, operation.clientOperationId);
        const message = commentErrorMessage(error, "Comment operation failed");
        this.respond(event.source!, event.data.requestId, false, message, rejected, commentRetryAfter(error) ?? undefined);
      }
    }).finally(() => { this.mutationsInFlight--; });
  };
}

/** Repository docs (#254): `repoComments`, scoped by repository and page; the reader's access is Convex's to decide. */
export class ConvexRepoCommentBackend implements DocumentCommentBackend {
  constructor(private readonly client: ConvexClient) {}

  private subscribePaginated(
    query: unknown,
    args: unknown,
    reverse: boolean,
    onUpdate: (items: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription {
    type RuntimeResult = {
      results: unknown[];
      status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
      loadMore: (count: number) => boolean;
    };
    type Subscribe = (
      query: unknown,
      args: unknown,
      options: { initialNumItems: number },
      callback: (result: RuntimeResult) => void,
      onError: (error: Error) => void,
    ) => (() => void);
    let runtimeLoadMore: ((count: number) => boolean) | null = null;
    const subscribe = this.client.onPaginatedUpdate_experimental.bind(this.client) as unknown as Subscribe;
    const unsubscribe = subscribe(query, args, { initialNumItems: PAGE_SIZE }, (result) => {
      runtimeLoadMore = result.loadMore;
      onUpdate(reverse ? [...result.results].reverse() : result.results, {
        canLoadMore: result.status !== "Exhausted",
        loading: result.status === "LoadingFirstPage" || result.status === "LoadingMore",
      });
    }, onError);
    return {
      unsubscribe,
      loadMore: () => runtimeLoadMore?.(PAGE_SIZE) ?? false,
    };
  }

  subscribe(
    scope: DocumentCommentScope,
    onUpdate: (threads: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription {
    return this.subscribePaginated(api.repoComments.listThreads, { repoId: scope.repoId, path: scope.documentPath }, false, onUpdate, onError);
  }

  subscribeReplies(
    scope: DocumentCommentScope,
    threadId: Id<"repoThreads">,
    onUpdate: (replies: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription {
    return this.subscribePaginated(api.repoComments.listReplies, { repoId: scope.repoId, path: scope.documentPath, threadId }, true, onUpdate, onError);
  }

  mutate(method: CommentorParentMutationMethod, scope: DocumentCommentScope, value: unknown): Promise<unknown> {
    const args = value as { body?: string; anchor?: never; threadId?: string; replyId?: string; clientOperationId?: string; expectedAuthorId?: string; resolved?: boolean; archived?: boolean };
    const common = { repoId: scope.repoId, path: scope.documentPath, clientOperationId: args.clientOperationId, expectedAuthorId: args.expectedAuthorId };
    if (method === "thread.create") return this.client.mutation(api.repoComments.createThread, { ...common, body: args.body!, anchor: args.anchor! });
    const threadId = args.threadId!;
    // Status writes always name their target here: there are no old widgets to toggle for.
    if (method === "thread.resolve" || method === "thread.archive") {
      const target = method === "thread.resolve" ? args.resolved : args.archived;
      if (typeof target !== "boolean") return Promise.reject(new ConvexError({ code: "invalid_input", message: "Invalid input" }));
      return method === "thread.resolve"
        ? this.client.mutation(api.repoComments.resolve, { ...common, threadId, resolved: target })
        : this.client.mutation(api.repoComments.archive, { ...common, threadId, archived: target });
    }
    if (method === "thread.remove") return this.client.mutation(api.repoComments.removeThread, { ...common, threadId });
    if (method === "reply.remove") return this.client.mutation(api.repoComments.removeReply, { ...common, threadId, replyId: args.replyId! });
    if (method === "thread.edit") return this.client.mutation(api.repoComments.editThread, { ...common, threadId, body: args.body! });
    if (method === "reply.edit") return this.client.mutation(api.repoComments.editReply, { ...common, threadId, replyId: args.replyId!, body: args.body! });
    return this.client.mutation(api.repoComments.addReply, { ...common, threadId, body: args.body! });
  }
}

async function requestAuthToken(): Promise<string | null> {
  const response = await fetch("/api/auth/convex/token", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { token?: unknown };
  return typeof payload.token === "string" && payload.token ? payload.token : null;
}

/** Renewal pacing for repository comment access (#254). */
export const REPO_ACCESS_MIN_RENEW_MS = 15_000;
export const REPO_ACCESS_DENIED_RETRY_MS = 60_000;
export const REPO_ACCESS_MAX_RETRY_MS = 60_000;

/** The opening document whose first comments the first access request asks for, and who wants the answer (#284). */
export type FirstRepoCommentAccess = { documentPath: string | null; onAnswer: (snapshot: RepoCommentSnapshot | null) => void };

function repoCommentSnapshot(body: { threads?: unknown } | null, documentPath: string | null): RepoCommentSnapshot | null {
  const threads = record(body?.threads);
  return documentPath !== null && threads && threads.path === documentPath && Array.isArray(threads.page) && typeof threads.isDone === "boolean"
    ? { documentPath, threads: threads.page, canLoadMore: !threads.isDone } : null;
}

/**
 * Keep the reader's comment access recorded in Convex while the shell is open
 * (#254): ask the read path at once, then again halfway through each grant.
 * The read path decides exactly as for a page view; a denial is a 404 and a
 * failure to check is retried with backoff. A hidden tab holds its renewal
 * until it is shown again (the grant lapses meanwhile, and comments with it).
 * The first request names the opening document (#284): its answer, whatever it
 * is, goes to `first.onAnswer`, with that document's first thread page if the
 * read path sent one.
 */
export function keepRepoCommentAccess(accessUrl: string, onChange: (writable: boolean) => void, first?: FirstRepoCommentAccess): () => void {
  let disposed = false;
  let timer: number | undefined;
  let retry = REPO_ACCESS_MIN_RENEW_MS / 3;
  let pending = first ?? null;
  const schedule = (delay: number) => {
    if (!disposed) timer = window.setTimeout(() => { void renew(); }, delay);
  };
  const backoff = () => {
    const delay = retry;
    retry = Math.min(retry * 2, REPO_ACCESS_MAX_RETRY_MS);
    schedule(delay);
  };
  const answered = (body: { threads?: unknown } | null) => {
    const waiting = pending;
    pending = null;
    waiting?.onAnswer(repoCommentSnapshot(body, waiting.documentPath));
  };
  const renew = async () => {
    await whenVisible();
    if (disposed) return;
    const url = pending?.documentPath ? `${accessUrl}?path=${encodeURIComponent(pending.documentPath)}` : accessUrl;
    let response: Response;
    try {
      response = await fetch(url, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
    } catch {
      if (!disposed) answered(null);
      backoff();
      return;
    }
    const body = response.ok ? await response.json().catch(() => null) as { expiresAt?: unknown; threads?: unknown } | null : null;
    if (disposed) return;
    if (body && typeof body.expiresAt === "number") {
      retry = REPO_ACCESS_MIN_RENEW_MS / 3;
      onChange(true);
      answered(body);
      schedule(Math.max(REPO_ACCESS_MIN_RENEW_MS, (body.expiresAt - Date.now()) / 2));
    } else if (response.status === 404) {
      onChange(false);
      answered(null);
      schedule(REPO_ACCESS_DENIED_RETRY_MS);
    } else {
      answered(null);
      backoff();
    }
  };
  void renew();
  return () => {
    disposed = true;
    window.clearTimeout(timer);
  };
}

export function bootCommentorParentHost(frameAlreadyLoaded = false): (() => void) | null {
  if (document.documentElement.dataset.rendroSignedOut === "true") return null;
  const config = (window as Window & { RENDRO_REPO_COMMENT_CONFIG?: CommentorParentConfig }).RENDRO_REPO_COMMENT_CONFIG;
  const frame = document.getElementById("content-frame");
  if (!config?.convexUrl || !(frame instanceof HTMLIFrameElement)) return null;
  let disposed = false;
  // Repository docs (#284): comment access is cookie-authorized, so it is asked at once, in parallel with the
  // frame and the session check, and its first answer brings the opening document's first comments.
  let writable: boolean | null = null;
  let firstAnswer: { snapshot: RepoCommentSnapshot | null } | null = null;
  let signedOut = false;
  let signedIn = false;
  let frameLoaded = frameAlreadyLoaded;
  const rememberLoad = () => { frameLoaded = true; };
  frame.addEventListener("load", rememberLoad);
  let host: CommentorParentHost | null = null;
  const stopAccess = keepRepoCommentAccess(config.accessUrl, (value) => {
    writable = value;
    host?.setWritable(value);
  }, {
    // A page restored from the back/forward cache shows whatever page the reader had moved to.
    documentPath: documentCommentScopeFromFrame(frame.src, location.origin, config)?.documentPath ?? config.documentPath ?? null,
    onAnswer: (snapshot) => {
      firstAnswer = { snapshot };
      host?.accessAnswered(snapshot);
    },
  });
  const client = new ConvexClient(config.convexUrl);
  let checking: Promise<string | null> | null = null;
  const checkIdentity = (): Promise<string | null> => {
    if (signedOut || disposed) return Promise.resolve(null);
    if (checking) return checking;
    checking = (async () => {
      const response = await fetch("/api/auth/get-session?disableCookieCache=true", { credentials: "same-origin", cache: "no-store" });
      const denied = response.status === 401 || response.status === 403;
      if (!response.ok && !denied) throw new Error("Comment session could not be checked");
      const session = denied ? null : await response.json() as { user?: { id?: unknown } } | null;
      const userId = typeof session?.user?.id === "string" && session.user.id ? session.user.id : null;
      if (!disposed && !signedOut) {
        // Repository docs (#254) are readable without signing in when public: an anonymous reader stays one,
        // while a reader who loses the session mid-visit has signed out.
        if (!userId) { if (signedIn) signOut(); return null; }
        signedIn = true;
        syncCommentRecoveryUser(window.sessionStorage, userId);
        host?.setUserId(userId);
      }
      return signedOut ? null : userId;
    })().finally(() => { checking = null; });
    return checking;
  };
  // BFCache and full reloads must check the live session before hydrating drafts.
  void checkIdentity().then((userId) => {
    if (disposed || signedOut) return;
    // A preload may have become the content frame meanwhile (#245); it has loaded by then.
    const current = document.getElementById("content-frame");
    const adopted = current instanceof HTMLIFrameElement && current !== frame ? current : null;
    host = new CommentorParentHost(adopted ?? frame, location.origin, config, new ConvexRepoCommentBackend(client), userId);
    if (writable !== null) host.setWritable(writable);
    if (firstAnswer) host.accessAnswered(firstAnswer.snapshot);
    else host.holdLive();
    // The iframe may have loaded while checking the session.
    host.start(Boolean(adopted) || frameLoaded || document.readyState === "complete");
    frame.removeEventListener("load", rememberLoad);
    // Anonymous readers use the client unauthenticated.
    if (userId) client.setAuth(async args => {
      // Convex refreshes before expiry (and after a rejection) with forceRefreshToken. A hidden tab
      // has nobody to serve: hold the refresh, and settle it the moment the tab is visible again.
      if (args?.forceRefreshToken) await whenVisible();
      if (!await checkIdentity() || disposed || signedOut) return null;
      const token = await requestAuthToken();
      return disposed || signedOut ? null : token;
    });
  }).catch(() => {});
  const signOut = () => {
    if (signedOut || disposed) return;
    signedOut = true;
    stopAccess();
    host?.setUserId(null);
    void client.close();
    window.dispatchEvent(new Event("commentor-sign-out"));
  };
  const focus = () => { void checkIdentity().catch(() => {}); };
  const follow = (event: Event) => {
    const next = (event as CustomEvent<unknown>).detail;
    if (next instanceof HTMLIFrameElement) host?.replaceFrame(next);
  };
  window.addEventListener("commentor-sign-out", signOut);
  window.addEventListener("focus", focus);
  window.addEventListener(CONTENT_FRAME_EVENT, follow);
  return () => {
    disposed = true;
    frame.removeEventListener("load", rememberLoad);
    window.removeEventListener("commentor-sign-out", signOut);
    window.removeEventListener("focus", focus);
    window.removeEventListener(CONTENT_FRAME_EVENT, follow);
    stopAccess();
    host?.dispose();
    void client.close();
  };
}
