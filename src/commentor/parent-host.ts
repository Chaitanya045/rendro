import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  COMMENTOR_PARENT_RESPONSE,
  COMMENTOR_PARENT_UPDATE,
  COMMENTOR_PARENT_ERROR,
  COMMENTOR_PARENT_READY,
  COMMENTOR_PARENT_REPLIES_UPDATE,
  isCommentorParentRequest,
  type CommentorParentMutationMethod,
} from "./parent-protocol";

const PAGE_SIZE = 20;

export type CommentPaginationState = {
  canLoadMore: boolean;
  loading: boolean;
};

export type DocumentCommentScope = {
  organizationId: string;
  projectId: Id<"projects">;
  documentPath: string;
};

export type CommentorParentConfig = {
  organizationId: string;
  projectId: Id<"projects">;
  convexUrl: string;
};

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
  config: Pick<CommentorParentConfig, "organizationId" | "projectId">,
): DocumentCommentScope | null {
  let url: URL;
  try {
    url = new URL(frameUrl, pageOrigin);
  } catch {
    return null;
  }
  if (url.origin !== pageOrigin) return null;
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
  return Boolean(left && right
    && left.organizationId === right.organizationId
    && left.projectId === right.projectId
    && left.documentPath === right.documentPath);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validBody(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 10_000;
}

function validAnchor(value: unknown): boolean {
  const anchor = record(value);
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

export class CommentorParentHost {
  private activeScope: DocumentCommentScope | null = null;
  private loadedScope: DocumentCommentScope | null = null;
  private activeSource: MessageEventSource | null = null;
  private threadSubscription: CommentPaginationSubscription | null = null;
  private replySubscriptions = new Map<string, CommentPaginationSubscription>();
  private threadIds = new Set<string>();
  private generation = 0;

  constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly pageOrigin: string,
    private readonly config: CommentorParentConfig,
    private readonly backend: DocumentCommentBackend,
  ) {}

  start(frameAlreadyLoaded = false): void {
    window.addEventListener("message", this.onMessage);
    this.frame.addEventListener("load", this.onFrameLoad);
    if (frameAlreadyLoaded) this.onFrameLoad();
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    this.frame.removeEventListener("load", this.onFrameLoad);
    this.reset();
    this.loadedScope = null;
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
    this.reset();
    this.loadedScope = this.currentScope();
    const source = this.frame.contentWindow;
    if (this.loadedScope && source) source.postMessage({ type: COMMENTOR_PARENT_READY }, "*");
  };

  private owns(generation: number, source: MessageEventSource, scope: DocumentCommentScope): boolean {
    return generation === this.generation
      && source === this.activeSource
      && source === this.frame.contentWindow
      && sameScope(scope, this.activeScope)
      && sameScope(scope, this.loadedScope)
      && sameScope(scope, this.currentScope());
  }

  private respond(source: MessageEventSource, requestId: string, ok: boolean, error?: string): void {
    if (!("postMessage" in source) || typeof source.postMessage !== "function") return;
    (source as WindowProxy).postMessage({
      type: COMMENTOR_PARENT_RESPONSE,
      requestId,
      ok,
      ...(error ? { error } : {}),
    }, "*");
  }

  private subscriptionError(source: MessageEventSource): void {
    if (!("postMessage" in source) || typeof source.postMessage !== "function") return;
    (source as WindowProxy).postMessage({
      type: COMMENTOR_PARENT_ERROR,
      error: "Comments could not be loaded",
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
    }, () => {
      if (this.owns(generation, source, scope)) this.subscriptionError(source);
    });
    this.respond(source, requestId, true);
  }

  private mutationArgs(method: CommentorParentMutationMethod, value: unknown): unknown | null {
    const args = record(value);
    if (!args) return null;
    if (method === "thread.create") {
      return validBody(args.body) && validAnchor(args.anchor)
        ? { body: args.body.trim(), anchor: args.anchor }
        : null;
    }
    const threadId = args.threadId;
    if (typeof threadId !== "string" || !this.threadIds.has(threadId)) return null;
    if (method === "reply.add") {
      return validBody(args.body) ? { threadId, body: args.body.trim() } : null;
    }
    return { threadId };
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
      () => {
        if (this.owns(generation, source, scope)) this.subscriptionError(source);
      },
    );
    this.replySubscriptions.set(threadId, subscription);
    this.respond(source, requestId, true);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame.contentWindow || !isCommentorParentRequest(event.data)) return;
    const scope = this.currentScope();
    if (!scope || !sameScope(scope, this.loadedScope) || !event.source) {
      if (event.source) this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
      return;
    }
    if (event.data.method === "subscribe") {
      const claim = record(event.data.args)?.documentPath;
      if (claim !== scope.documentPath) {
        this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
        return;
      }
      this.subscribe(event.source, event.data.requestId, scope);
      return;
    }
    if (!sameScope(scope, this.activeScope) || event.source !== this.activeSource) {
      this.respond(event.source, event.data.requestId, false, "Comment scope is unavailable");
      return;
    }
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
    const args = this.mutationArgs(event.data.method, event.data.args);
    if (!args) {
      this.respond(event.source, event.data.requestId, false, "Comment operation is outside this document");
      return;
    }
    const generation = this.generation;
    void this.backend.mutate(event.data.method, scope, args).then(() => {
      if (this.owns(generation, event.source!, scope)) this.respond(event.source!, event.data.requestId, true);
    }).catch(() => {
      if (this.owns(generation, event.source!, scope)) {
        this.respond(event.source!, event.data.requestId, false, "Comment operation failed");
      }
    });
  };
}

export class ConvexDocumentCommentBackend implements DocumentCommentBackend {
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
    return this.subscribePaginated(api.documentThreads.list, scope, false, onUpdate, onError);
  }

  subscribeReplies(
    scope: DocumentCommentScope,
    threadId: Id<"documentThreads">,
    onUpdate: (replies: unknown[], state: CommentPaginationState) => void,
    onError: (error: Error) => void,
  ): CommentPaginationSubscription {
    return this.subscribePaginated(api.documentReplies.list, { ...scope, threadId }, true, onUpdate, onError);
  }

  mutate(method: CommentorParentMutationMethod, scope: DocumentCommentScope, value: unknown): Promise<unknown> {
    const args = value as { body?: string; anchor?: never; threadId?: string };
    if (method === "thread.create") {
      return this.client.mutation(api.documentThreads.create, {
        ...scope,
        body: args.body!,
        anchor: args.anchor!,
      });
    }
    const threadId = args.threadId as Id<"documentThreads">;
    if (method === "thread.resolve") return this.client.mutation(api.documentThreads.resolve, { ...scope, threadId });
    if (method === "thread.archive") return this.client.mutation(api.documentThreads.archive, { ...scope, threadId });
    if (method === "thread.remove") return this.client.mutation(api.documentThreads.remove, { ...scope, threadId });
    return this.client.mutation(api.documentReplies.add, { ...scope, threadId, body: args.body! });
  }
}

async function requestAuthToken(): Promise<string | null> {
  const response = await fetch("/api/auth/convex/token", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const payload = await response.json() as { token?: unknown };
  return typeof payload.token === "string" ? payload.token : null;
}

export function bootCommentorParentHost(frameAlreadyLoaded = false): (() => void) | null {
  const globals = window as Window & { RENDRO_SHARE_CONFIG?: CommentorParentConfig };
  const config = globals.RENDRO_SHARE_CONFIG;
  const frame = document.getElementById("content-frame");
  if (!config?.organizationId || !config.projectId || !config.convexUrl || !(frame instanceof HTMLIFrameElement)) return null;
  const client = new ConvexClient(config.convexUrl);
  client.setAuth(requestAuthToken);
  const host = new CommentorParentHost(frame, location.origin, config, new ConvexDocumentCommentBackend(client));
  host.start(frameAlreadyLoaded);
  return () => {
    host.dispose();
    void client.close();
  };
}
