import { ConvexError } from "convex/values";
import { CommentorParentHost, type DocumentCommentBackend } from "../../src/commentor/parent-host";

const state = { failure: "quota", calls: [] as Record<string, unknown>[], refresh: () => {} };
(window as unknown as { commentFixture: typeof state }).commentFixture = state;
const threads = [{ _id: "thread-1", _creationTime: Date.now(), authorName: "Author", body: "Existing comment",
  anchor: { kind: "element", path: ["#target"] }, resolved: false, canDelete: true, replies: [] }];
const backend: DocumentCommentBackend = {
  subscribe(_scope, update) {
    state.refresh = () => update(threads, { canLoadMore: false, loading: false });
    state.refresh();
    return { unsubscribe() {}, loadMore: () => false };
  },
  subscribeReplies() { return { unsubscribe() {}, loadMore: () => false }; },
  mutate(method, _scope, args) {
    state.calls.push({ method, ...args as Record<string, unknown> });
    if (state.failure === "quota") return Promise.reject(new ConvexError({ kind: "RateLimited", name: "comments", retryAfter: 2100 }));
    if (state.failure === "generic") return Promise.reject(new Error("private diagnostic must not reach the user"));
    return Promise.resolve();
  },
};
const host = new CommentorParentHost(document.querySelector("iframe")!, location.origin,
  { organizationId: "org-a", projectId: "project-a" as never, convexUrl: "http://unused.test" }, backend, "user-a");
host.start(true);
