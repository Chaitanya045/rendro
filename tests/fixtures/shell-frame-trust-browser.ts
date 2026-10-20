import { installViewerParent } from "../../src/viewer/client";
import { CommentorParentHost, type DocumentCommentBackend } from "../../src/commentor/parent-host";
import { startShellNavigation } from "../../src/viewer/content-frame";

/*
 * A private repository's shell (#296) with the real comment host and ticket renewal, and Convex replaced by a recorder.
 * The shell navigates its frame as the lazy tree does; `shell.navigate(path)` is the reader picking a page.
 */
const base = `/r/octo/secret/@${"c0ffee".padEnd(40, "0")}`;
const calls: Array<{ method: string; args: unknown }> = [];
const backend: DocumentCommentBackend = {
  subscribe(scope, update) {
    calls.push({ method: "subscribe", args: scope });
    queueMicrotask(() => update([{ _id: "thread-1", body: "Kept for readers" }], { canLoadMore: false, loading: false }));
    return { unsubscribe() {}, loadMore: () => false };
  },
  subscribeReplies() { return { unsubscribe() {}, loadMore: () => false }; },
  mutate(method, _scope, args) {
    calls.push({ method, args });
    return Promise.resolve(null);
  },
};
const frame = document.querySelector<HTMLIFrameElement>("#content-frame")!;
const host = new CommentorParentHost(frame, location.origin, { repoId: 9101, accessUrl: "/r/octo/secret/comment-access", convexUrl: "http://unused.test" }, backend, "user-a");
host.setWritable(true);
host.start();
installViewerParent({ base });
const shell = {
  calls,
  navigate(path: string) {
    startShellNavigation(frame);
    frame.src = `${base}/files/${path}`;
    frame.contentWindow?.location.replace(frame.src);
  },
};
Object.assign(window, { shell });
export type ShellFrameTrust = typeof shell;
