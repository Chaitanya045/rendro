import { CommentorParentHost, type DocumentCommentBackend } from "../../src/commentor/parent-host";

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
// The lab's shell names the frame's document in its own HTML: that document is the shell's (#296). Its later loads are
// not tracked, as the lab's tests reload and move the frame themselves.
Object.assign(frame.dataset, { navigation: "1", document: "1" });
const host = new CommentorParentHost(frame, location.origin, { repoId: 9101, accessUrl: "/r/acme/docs/comment-access", convexUrl: "http://localhost" }, backend, "reader");
host.setWritable(true);
function publishThreads() {
  updates.at(-1)!(Array.from({ length: 12 }, (_, index) => ({
    _id: `thread-${index}`, _creationTime: Date.now(), authorName: "Reader", authorEmail: "reader@example.test", body: `Comment ${index}`,
    anchor: { kind: "repo-text", blobSha: "b".repeat(40), headingSlug: "title", prefix: "", exact: "Document", suffix: "", offset: 0 }, resolved: false, replies: [],
  })), { canLoadMore: true, loading: false });
}
Object.assign(window, { fixtureHost: host, fixtureUpdates: updates, publishThreads });
