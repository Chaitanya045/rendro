import { ConvexError } from "convex/values";
import { installViewerParent } from "../../src/viewer/client";
import { CommentorParentHost, type CommentPaginationSubscription, type DocumentCommentBackend } from "../../src/commentor/parent-host";

// A scriptable in-memory comment backend behind the real parent host, so Chromium
// tests exercise the real widget, transport and host with only Convex replaced.
// Edits (#287): `canEdit` is opt-in, so a seed without it offers no Edit.
type Edited = { canEdit?: boolean; editedAt?: number; editOperationId?: string };
type Reply = { _id: string; _creationTime: number; authorName: string; authorEmail: string; body: string; canDelete?: boolean; clientOperationId?: string } & Edited;
type Thread = {
  _id: string; _creationTime: number; authorName: string; authorEmail: string; body: string; anchor: unknown;
  resolved: boolean; archived?: boolean; canDelete?: boolean; replies: Reply[]; repliesHasMore?: boolean; clientOperationId?: string;
} & Edited;
type Failure = { kind: "plain" } | { kind: "convex"; code: string } | { kind: "quota"; retryAfter: number } | { kind: "unknown-convex" };
type Held = { method: string; args: Record<string, unknown>; settle: (failure?: Failure) => void };

const failureError = (failure: Failure) => failure.kind === "plain" ? new Error("private backend detail")
  : failure.kind === "quota" ? new ConvexError({ kind: "RateLimited", name: "comments", retryAfter: failure.retryAfter })
  : failure.kind === "unknown-convex" ? new ConvexError({ code: "surprise", message: "private backend detail" })
  : new ConvexError({ code: failure.code, message: "private backend detail" });

let threadUpdate: Parameters<DocumentCommentBackend["subscribe"]>[1] | null = null;
let threadError: ((error: Error) => void) | null = null;
const replyUpdates = new Map<string, Parameters<DocumentCommentBackend["subscribeReplies"]>[2]>();
let sequence = 0;

const lab = {
  threads: [] as Thread[],
  // Older pages the next loadMore() reveals; replies likewise per thread.
  olderThreads: [] as Thread[],
  olderReplies: {} as Record<string, Reply[]>,
  pagination: { canLoadMore: false, loading: false },
  loadMoreResult: true,
  // When false a mutation is applied but its snapshot is only published on request, so the acknowledgement arrives first.
  publishOnMutate: true,
  // Reply subscriptions begin with an empty, still-loading page.
  replyLoading: false,
  calls: [] as Array<{ method: string; args: Record<string, unknown> }>,
  failures: {} as Record<string, Failure>,
  holds: [] as string[],
  held: [] as Held[],
  subscriptions: 0,
  // The scope each thread subscription was opened with, in order.
  scopes: [] as unknown[],
  replySubscriptions: () => replyUpdates.size,
  unsubscribed: 0,
  host: null as CommentorParentHost | null,
  /** The same repository anchor as tests/helpers/comment-lab.ts `anchorOn`, for callbacks that run in this page. */
  anchorOn(exact: string, headingSlug = "title") {
    return { kind: "repo-text", blobSha: "b".repeat(40), headingSlug, prefix: "", exact, suffix: "", offset: 0 };
  },
  publish() {
    threadUpdate?.([...lab.threads].sort((a, b) => a._creationTime - b._creationTime), { ...lab.pagination });
  },
  publishReplies(threadId: string, replies: Reply[], canLoadMore = false, loading = false) {
    replyUpdates.get(threadId)?.(replies, { canLoadMore, loading });
  },
  seed(threads: Partial<Thread>[]) {
    lab.threads = threads.map(thread => lab.thread(thread));
    lab.publish();
  },
  thread(overrides: Partial<Thread> = {}): Thread {
    const id = overrides._id ?? `thread-${++sequence}`;
    return {
      _id: id, _creationTime: Date.now() - 60_000 + sequence, authorName: "Ada", authorEmail: "ada@example.test",
      body: `Body of ${id}`, anchor: { kind: "repo-text", blobSha: "b".repeat(40), headingSlug: "title", prefix: "", exact: "Quarterly report", suffix: "", offset: 0 },
      resolved: false, canDelete: true, replies: [], ...overrides,
    };
  },
  reply(overrides: Partial<Reply> = {}): Reply {
    return { _id: `reply-${++sequence}`, _creationTime: Date.now() - 30_000 + sequence, authorName: "Grace", authorEmail: "grace@example.test", body: "A reply", canDelete: true, ...overrides };
  },
  settle(index: number, failure?: Failure) { lab.held.splice(index, 1)[0].settle(failure); },
  fail(error: Error) { threadError?.(error); },
  mutate(method: string, args: Record<string, unknown>): Promise<unknown> {
    lab.calls.push({ method, args });
    const failure = lab.failures[method];
    if (failure) return Promise.reject(failureError(failure));
    const apply = () => {
      const thread = lab.threads.find(candidate => candidate._id === args.threadId);
      const clientOperationId = args.clientOperationId as string | undefined;
      if (method === "thread.create") lab.threads.push(lab.thread({ body: args.body as string, anchor: args.anchor, authorName: "Me", clientOperationId }));
      else if (method === "thread.remove") lab.threads = lab.threads.filter(candidate => candidate !== thread);
      else if (thread && method === "thread.resolve") thread.resolved = typeof args.resolved === "boolean" ? args.resolved : !thread.resolved;
      else if (thread && method === "thread.archive") thread.archived = typeof args.archived === "boolean" ? args.archived : !thread.archived;
      else if (thread && method === "reply.add") thread.replies = [...thread.replies, lab.reply({ body: args.body as string, authorName: "Me", clientOperationId })];
      else if (thread && method === "reply.remove") thread.replies = thread.replies.filter(reply => reply._id !== args.replyId);
      else if (thread && method === "thread.edit") Object.assign(thread, { body: args.body, editedAt: Date.now(), editOperationId: clientOperationId });
      else if (thread && method === "reply.edit") thread.replies = thread.replies.map(reply => reply._id === args.replyId
        ? { ...reply, body: args.body as string, editedAt: Date.now(), editOperationId: clientOperationId } : reply);
      if (lab.publishOnMutate) lab.publish();
    };
    if (lab.holds.includes(method)) {
      return new Promise((resolve, reject) => {
        lab.held.push({ method, args, settle: failure => { if (failure) reject(failureError(failure)); else { apply(); resolve(undefined); } } });
      });
    }
    apply();
    return Promise.resolve();
  },
  reset() { lab.threads = []; lab.olderThreads = []; lab.olderReplies = {}; lab.calls = []; lab.failures = {}; lab.holds = []; lab.held = []; },
};

const backend: DocumentCommentBackend = {
  subscribe(scope, update, onError) {
    lab.subscriptions++;
    lab.scopes.push(scope);
    threadUpdate = update;
    threadError = onError;
    // The first page arrives like a Convex snapshot, after the request is acknowledged.
    queueMicrotask(() => lab.publish());
    return {
      unsubscribe() { lab.unsubscribed++; if (threadUpdate === update) threadUpdate = null; },
      loadMore() {
        if (!lab.loadMoreResult) return false;
        lab.threads.push(...lab.olderThreads.splice(0));
        lab.pagination = { canLoadMore: false, loading: false };
        lab.publish();
        return true;
      },
    };
  },
  subscribeReplies(_scope, threadId, update) {
    replyUpdates.set(threadId, update);
    const subscription: CommentPaginationSubscription = {
      unsubscribe() { replyUpdates.delete(threadId); },
      loadMore() {
        const older = lab.olderReplies[threadId];
        if (!older || !lab.loadMoreResult) return false;
        const thread = lab.threads.find(candidate => candidate._id === threadId);
        update([...older, ...(thread?.replies ?? [])], { canLoadMore: false, loading: false });
        return true;
      },
    };
    queueMicrotask(() => {
      const thread = lab.threads.find(candidate => candidate._id === threadId);
      update(lab.replyLoading ? [] : thread?.replies ?? [], { canLoadMore: Boolean(lab.olderReplies[threadId]), loading: lab.replyLoading });
    });
    return subscription;
  },
  mutate: (_method, _scope, args) => lab.mutate(_method, args as Record<string, unknown>),
};

const query = new URLSearchParams(location.search);
const frame = document.querySelector<HTMLIFrameElement>("#content-frame")!;
// The lab's shell names the frame's document in its own HTML: that document is the shell's (#296). Its later loads are
// not tracked, as the lab's tests reload and move the frame themselves.
Object.assign(frame.dataset, { navigation: "1", document: "1" });
lab.host = new CommentorParentHost(frame, location.origin,
  { repoId: 9101, accessUrl: "/r/acme/docs/comment-access", convexUrl: "http://unused.test" }, backend, query.get("user") === "" ? null : query.get("user") ?? "user-a");
// The read path's comment access decides who may write (#254); the lab grants it unless the test asked for a reader.
lab.host.setWritable(!new URLSearchParams(document.currentScript ? new URL((document.currentScript as HTMLScriptElement).src).search : "").has("readonly"));
lab.host.start(true);
// The real shell's reload notice and Reload button, for the tests that press them.
if (query.has("viewer")) installViewerParent({ base: location.pathname });
Object.assign(window, { lab });
export type CommentLab = typeof lab;
