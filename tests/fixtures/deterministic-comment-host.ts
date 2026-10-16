import { CommentorParentHost, type DocumentCommentBackend } from "../../src/commentor/parent-host";
import { updateViewerActiveDeployment } from "../../src/viewer/client";

const updates: Array<Parameters<DocumentCommentBackend["subscribe"]>[1]> = [];
const backend: DocumentCommentBackend = {
  subscribe(_scope, update) {
    updates.push(update);
    return { unsubscribe() {}, loadMore: () => false };
  },
  subscribeReplies() { return { unsubscribe() {}, loadMore: () => false }; },
  mutate: () => Promise.resolve(null),
};
const frame = document.querySelector<HTMLIFrameElement>("#content-frame")!;
const host = new CommentorParentHost(frame, location.origin, { orgSlug: "fixture", convexUrl: "http://localhost" }, backend, "reader");
function publishThreads() {
  updates.at(-1)!(Array.from({ length: 12 }, (_, index) => ({
    _id: `thread-${index}`, _creationTime: Date.now(), authorName: "Reader", authorEmail: "reader@example.test",
    body: `Comment ${index}`, anchor: { kind: "element", path: ["#target"] }, resolved: false, replies: [],
  })), { canLoadMore: true, loading: false });
}
Object.assign(window, { fixtureHost: host, fixtureUpdates: updates, publishThreads,
  clearDeployment: () => updateViewerActiveDeployment(null),
});
