import { ConvexError } from "convex/values";
import { isPublicErrorData } from "../shared/public-errors";
import { showViewerUpdateNotice, updateViewerActiveDeployment } from "../viewer/client";
import { commentErrorMessage, commentRetryAfter, isDefinitiveCommentRejection } from "./errors";
import { COMMENT_RECOVERY_PREFIX, syncCommentRecoveryUser } from "./recovery-session";
import { normalizeMutationArgs, record, validAnchor } from "./mutation-args";
import { CommentOperationState, mutationKey } from "./operation-state";
import { ConvexClient } from "convex/browser";
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

type CommentPaginationState = {
  canLoadMore: boolean;
  loading: boolean;
};

export type ProjectCommentScope = {
  organizationId: string;
  projectId: Id<"projects">;
  documentPath: string;
};

export type LegacyCommentScope = { orgSlug: string; filePath: string; documentPath: string };
export type DocumentCommentScope = ProjectCommentScope | LegacyCommentScope;

export type CommentorParentConfig = {
  organizationId: string;
  projectId: Id<"projects">;
  convexUrl: string;
} | { orgSlug: string; convexUrl: string };

export interface DocumentCommentBackend {
  subscribe(
    scope: DocumentCommentScope,
    onUpdate: (threads: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription;
  subscribeReplies(
    scope: DocumentCommentScope,
    threadId: Id<"documentThreads">,
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

function safeRelativePath(encodedPath: string): string | null {
  let path: string;
  try {
    path = encodedPath.split("/").map(decodeURIComponent).join("/");
  } catch {
    return null;
  }
  return path
    && !path.includes("\\")
    && path.split("/").every((part) => Boolean(part) && part !== "." && part !== "..")
    ? path
    : null;
}

export function documentCommentScopeFromFrame(
  frameUrl: string,
  pageOrigin: string,
  config: { organizationId: string; projectId: Id<"projects"> } | { orgSlug: string },
): DocumentCommentScope | null {
  let url: URL;
  try {
    url = new URL(frameUrl, pageOrigin);
  } catch {
    return null;
  }
  if (url.origin !== pageOrigin) return null;
  if ("orgSlug" in config) {
    const prefix = `/legacy-view/${encodeURIComponent(config.orgSlug)}/files/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const documentPath = safeRelativePath(url.pathname.slice(prefix.length));
    return documentPath ? { orgSlug: config.orgSlug, documentPath, filePath: `${config.orgSlug}/${documentPath}` } : null;
  }
  const prefix = `/organizations/${encodeURIComponent(config.organizationId)}/projects/${encodeURIComponent(config.projectId)}/docs/files/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const documentPath = safeRelativePath(url.pathname.slice(prefix.length));
  return documentPath ? {
    organizationId: config.organizationId,
    projectId: config.projectId,
    documentPath,
  } : null;
}

function sameScope(left: DocumentCommentScope | null, right: DocumentCommentScope | null): boolean {
  return Boolean(left && right && left.documentPath === right.documentPath
    && ("orgSlug" in left ? "orgSlug" in right && left.orgSlug === right.orgSlug
      : "organizationId" in right && left.organizationId === right.organizationId && left.projectId === right.projectId));
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

  private allowBackendRequest(): boolean {
    const now = performance.now();
    this.requestTokens = Math.min(20, this.requestTokens + (now - this.requestBudgetAt) / 1000);
    this.requestBudgetAt = now;
    if (this.requestTokens < 1) return false;
    this.requestTokens--;
    return true;
  }

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly pageOrigin: string,
    private readonly config: CommentorParentConfig,
    private readonly backend: DocumentCommentBackend,
    private userId: string | null,
  ) {
    syncCommentRecoveryUser(window.sessionStorage, userId);
  }

  setUserId(userId: string | null): void {
    if (this.userId === userId) return;
    syncCommentRecoveryUser(window.sessionStorage, userId);
    this.userId = userId;
    this.parentGeneration = crypto.randomUUID();
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
    if (!this.userId) throw new Error("Comment authentication required");
    return new CommentOperationState(window.sessionStorage, `${COMMENT_RECOVERY_PREFIX}${JSON.stringify([this.userId, scope])}`, this.userId);
  }

  private currentScope(): DocumentCommentScope | null {
    return documentCommentScopeFromFrame(this.frame.src, this.pageOrigin, this.config);
  }

  private reset(): void {
    this.generation += 1;
    this.threadSubscription?.unsubscribe();
    this.threadSubscription = null;
    for (const subscription of this.replySubscriptions.values()) subscription.unsubscribe();
    this.replySubscriptions.clear();
    this.activeScope = null;
    this.activeSource = null;
    this.threadIds.clear();
  }

  private readonly onFrameLoad = (): void => {
    this.connectionGeneration += 1;
    this.reset();
    this.loadedScope = this.currentScope();
    const source = this.frame.contentWindow;
    if (this.loadedScope && source) {
      try {
        source.postMessage({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, canReloadViewer: true, parentGeneration: this.parentGeneration, userId: this.userId, recoveryState: this.userId ? this.recovery(this.loadedScope).value : { operations: {}, drafts: {} } }, "*");
      } catch { this.subscriptionError(source); }
    }
  };

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
    this.threadSubscription = this.backend.subscribe(scope, (threads, state) => {
      if (!this.owns(generation, source, scope)) return;
      this.threadIds = new Set(threads.flatMap((thread) => {
        const value = record(thread)?._id;
        return typeof value === "string" ? [value] : [];
      }));
      for (const [threadId, subscription] of this.replySubscriptions) {
        if (this.threadIds.has(threadId)) continue;
        subscription.unsubscribe();
        this.replySubscriptions.delete(threadId);
      }
      if ("postMessage" in source && typeof source.postMessage === "function") {
        (source as WindowProxy).postMessage({
          type: COMMENTOR_PARENT_UPDATE,
          threads,
          ...state,
        }, "*");
      }
    }, (error) => {
      if (this.owns(generation, source, scope)) this.subscriptionError(source, error);
    });
    this.respond(source, requestId, true);
  }

  private mutationArgs(method: CommentorParentMutationMethod, value: unknown): unknown | null {
    const args = normalizeMutationArgs(method, value);
    if (!args) return null;
    if (method === "thread.create") return args;
    const clientOperationId = args.clientOperationId;
    const threadId = args.threadId;
    if (typeof threadId !== "string") return null;
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
      threadId as Id<"documentThreads">,
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
    if (event.source !== this.frame.contentWindow) return;
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
    if (!this.userId || !scope || !sameScope(scope, this.loadedScope) || !event.source) {
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
            || (args.key !== "create" && !this.threadIds.has(args.key))
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
      const values = args as Record<string, unknown>;
      const legacyToggle = (event.data.method === "thread.resolve" && values.resolved === undefined)
        || (event.data.method === "thread.archive" && values.archived === undefined);
      operation = legacyToggle ? { method: event.data.method, args: values, clientOperationId: undefined } : state.prepare(event.data.method, values);
      // Ensure writes cannot escape if durable storage is unavailable.
      state.save();
    } catch {
      this.respond(event.source, event.data.requestId, false, "Comment recovery state could not be saved");
      return;
    }
    const generation = this.connectionGeneration;
    const key = mutationKey(operation.method, operation.args);
    this.mutationsInFlight++;
    void this.backend.mutate(operation.method, scope, { ...operation.args, clientOperationId: operation.clientOperationId, expectedAuthorId: this.userId }).then(() => {
      // An abandoned acknowledgement cannot retire the durable identity: the
      // replacement widget may still hold (or save) the unconfirmed draft.
      if (this.ownsConnection(generation, event.source!, scope)) {
        if (operation.clientOperationId) this.recovery(scope).complete(key, operation.clientOperationId);
        this.respond(event.source!, event.data.requestId, true);
      }
    }).catch((error: unknown) => {
      if (this.ownsConnection(generation, event.source!, scope)) {
        // Only known definitive rejections release the durable operation identity.
        const rejected = isDefinitiveCommentRejection(error);
        if (rejected && operation.clientOperationId) this.recovery(scope).reject(key, operation.clientOperationId);
        const message = commentErrorMessage(error, "Comment operation failed");
        this.respond(event.source!, event.data.requestId, false, message, rejected, commentRetryAfter(error) ?? undefined);
      }
    }).finally(() => { this.mutationsInFlight--; });
  };
}

class ConvexDocumentCommentBackend implements DocumentCommentBackend {
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
    if ("orgSlug" in scope) throw new Error("Invalid project scope");
    return this.subscribePaginated(api.documentThreads.list, scope, false, onUpdate, onError);
  }

  subscribeReplies(
    scope: DocumentCommentScope,
    threadId: Id<"documentThreads">,
    onUpdate: (replies: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription {
    if ("orgSlug" in scope) throw new Error("Invalid project scope");
    return this.subscribePaginated(api.documentReplies.list, { ...scope, threadId }, true, onUpdate, onError);
  }

  mutate(method: CommentorParentMutationMethod, scope: DocumentCommentScope, value: unknown): Promise<unknown> {
    if ("orgSlug" in scope) throw new Error("Invalid project scope");
    const args = value as { body?: string; anchor?: never; threadId?: string; replyId?: string; clientOperationId?: string; expectedAuthorId?: string; resolved?: boolean; archived?: boolean };
    const operation = { clientOperationId: args.clientOperationId, expectedAuthorId: args.expectedAuthorId };
    if (method === "thread.create") {
      return this.client.mutation(api.documentThreads.create, {
        ...scope,
        ...operation,
        body: args.body!,
        anchor: args.anchor!,
      });
    }
    const threadId = args.threadId as Id<"documentThreads">;
    if (method === "thread.resolve") return this.client.mutation(api.documentThreads.resolve, { ...scope, ...operation, threadId, resolved: args.resolved });
    if (method === "thread.archive") return this.client.mutation(api.documentThreads.archive, { ...scope, ...operation, threadId, archived: args.archived });
    if (method === "thread.remove") return this.client.mutation(api.documentThreads.remove, { ...scope, ...operation, threadId });
    if (method === "reply.remove") {
      return this.client.mutation(api.documentReplies.remove, { ...scope, ...operation, threadId, replyId: args.replyId as Id<"documentReplies"> });
    }
    return this.client.mutation(api.documentReplies.add, { ...scope, ...operation, threadId, body: args.body! });
  }
}

export class ConvexLegacyCommentBackend implements DocumentCommentBackend {
  constructor(private readonly client: ConvexClient) {}
  subscribe(scope: DocumentCommentScope, update: (threads: unknown[], state: CommentPaginationState) => void, error: (error: Error) => void): CommentPaginationSubscription {
    if (!("orgSlug" in scope)) throw new Error("Invalid legacy scope");
    const unsubscribe = this.client.onUpdate(api.threads.list, { orgSlug: scope.orgSlug, filePath: scope.filePath },
      threads => update(threads, { canLoadMore: false, loading: false }), error);
    // v1 returns all replies inline; retain that behavior without dropping any.
    return { unsubscribe, loadMore: () => false };
  }
  subscribeReplies(): CommentPaginationSubscription {
    return { unsubscribe() {}, loadMore: () => false };
  }
  mutate(method: CommentorParentMutationMethod, scope: DocumentCommentScope, value: unknown): Promise<unknown> {
    if (!("orgSlug" in scope)) throw new Error("Invalid legacy scope");
    const args = value as { body?: string; anchor?: never; threadId?: string; replyId?: string; clientOperationId?: string; expectedAuthorId?: string; resolved?: boolean; archived?: boolean };
    const common = { orgSlug: scope.orgSlug, filePath: scope.filePath, clientOperationId: args.clientOperationId, expectedAuthorId: args.expectedAuthorId };
    if (method === "thread.create") return this.client.mutation(api.threads.create, { ...common, body: args.body!, anchor: args.anchor! });
    const threadId = args.threadId!;
    if (method === "thread.resolve") return this.client.mutation(api.threads.resolve, { ...common, threadId, resolved: args.resolved });
    if (method === "thread.archive") return this.client.mutation(api.threads.archive, { ...common, threadId, archived: args.archived });
    if (method === "thread.remove") return this.client.mutation(api.threads.remove, { ...common, threadId });
    if (method === "reply.remove") return this.client.mutation(api.replies.remove, { ...common, threadId, replyId: args.replyId! });
    return this.client.mutation(api.replies.add, { ...common, threadId, body: args.body! });
  }
}

async function requestAuthToken(onAccessLost: () => void): Promise<string | null> {
  const response = await fetch("/api/auth/convex/token", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) onAccessLost();
    return null;
  }
  const payload = await response.json() as { token?: unknown };
  if (typeof payload.token === "string" && payload.token) return payload.token;
  onAccessLost();
  return null;
}

export function bootCommentorParentHost(frameAlreadyLoaded = false): (() => void) | null {
  if (document.documentElement.dataset.rendroSignedOut === "true") return null;
  const globals = window as Window & { RENDRO_SHARE_CONFIG?: CommentorParentConfig; RENDRO_LEGACY_COMMENT_CONFIG?: CommentorParentConfig };
  const config = globals.RENDRO_LEGACY_COMMENT_CONFIG ?? globals.RENDRO_SHARE_CONFIG;
  const frame = document.getElementById("content-frame");
  if (!config?.convexUrl || !(frame instanceof HTMLIFrameElement)) return null;
  let disposed = false;
  let signedOut = false;
  let frameLoaded = frameAlreadyLoaded;
  const rememberLoad = () => { frameLoaded = true; };
  frame.addEventListener("load", rememberLoad);
  let host: CommentorParentHost | null = null;
  let unsubscribeDeployment: (() => void) | undefined;
  let deploymentStopped = false;
  const stopDeployment = () => {
    deploymentStopped = true;
    const unsubscribe = unsubscribeDeployment;
    unsubscribeDeployment = undefined;
    unsubscribe?.();
    updateViewerActiveDeployment(null);
  };
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
        if (!userId) { signOut(); return null; }
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
    host = new CommentorParentHost(frame, location.origin, config, "orgSlug" in config ? new ConvexLegacyCommentBackend(client) : new ConvexDocumentCommentBackend(client), userId);
    // The iframe may have loaded while checking the session.
    host.start(frameLoaded || document.readyState === "complete");
    frame.removeEventListener("load", rememberLoad);
    client.setAuth(async () => {
      if (!await checkIdentity() || disposed || signedOut) return null;
      const token = await requestAuthToken(() => { if (!disposed && !signedOut) stopDeployment(); });
      return disposed || signedOut ? null : token;
    });
    if (!("orgSlug" in config) && userId && !deploymentStopped) {
      const unsubscribe = client.onUpdate(api.projects.activeDeployment,
        { organizationId: config.organizationId, projectId: config.projectId },
        deploymentId => { if (!deploymentStopped) updateViewerActiveDeployment(deploymentId); },
        error => {
          if (deploymentStopped) return;
          if (error instanceof ConvexError && isPublicErrorData(error.data)
            && ["unauthenticated", "forbidden", "not_found"].includes(error.data.code)) stopDeployment();
          else updateViewerActiveDeployment(null); // Transient failures retain renewal fallback.
        });
      // Also handle a cached denial delivered synchronously by the client.
      if (deploymentStopped) unsubscribe();
      else unsubscribeDeployment = unsubscribe;
    }
  }).catch(() => {});
  const signOut = () => {
    if (signedOut || disposed) return;
    signedOut = true;
    stopDeployment();
    host?.setUserId(null);
    void client.close();
    window.dispatchEvent(new Event("commentor-sign-out"));
  };
  const focus = () => { void checkIdentity().catch(() => {}); };
  window.addEventListener("commentor-sign-out", signOut);
  window.addEventListener("focus", focus);
  return () => {
    disposed = true;
    frame.removeEventListener("load", rememberLoad);
    window.removeEventListener("commentor-sign-out", signOut);
    window.removeEventListener("focus", focus);
    host?.dispose();
    stopDeployment();
    void client.close();
  };
}
