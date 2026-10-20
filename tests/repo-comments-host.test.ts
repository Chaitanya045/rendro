// @vitest-environment happy-dom
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootCommentorParentHost, CommentorParentHost, ConvexRepoCommentBackend, documentCommentScopeFromFrame, keepRepoCommentAccess,
  REPO_ACCESS_DENIED_RETRY_MS, REPO_ACCESS_MAX_RETRY_MS, REPO_ACCESS_MIN_RENEW_MS, sameScope, type DocumentCommentBackend, type DocumentCommentScope,
} from "../src/commentor/parent-host";
import { COMMENTOR_PARENT_READY, COMMENTOR_PARENT_REQUEST, COMMENTOR_PARENT_RESPONSE, COMMENTOR_PARENT_UPDATE } from "../src/commentor/parent-protocol";

/*
 * The trusted shell's half of comments on repository docs (#254): the scope comes from the frame's URL and the
 * shell's own repository, anonymous readers may read but never write, the read path's comment access is renewed
 * halfway through each grant, and the one Convex client lives here.
 */
const clients = vi.hoisted(() => [] as Array<{ url: string; setAuth: ReturnType<typeof vi.fn>; onUpdate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>);
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    setAuth = vi.fn();
    onUpdate = vi.fn(() => vi.fn());
    close = vi.fn(async () => {});
    constructor(readonly url: string) { clients.push(this); }
  },
}));

const ORIGIN = "https://rendro.test";
const config = { repoId: 9001, accessUrl: "/r/octo/docs/comment-access", convexUrl: "https://convex.test" };
const commit = "a".repeat(40);
const frameUrl = `${ORIGIN}/r/octo/docs/@${commit}/files/docs/guide.md`;
const anchor = { kind: "repo-text", blobSha: "b".repeat(40), headingSlug: "install", prefix: "", exact: "pnpm install", suffix: "", offset: 0 };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-rendro-signed-out");
  sessionStorage.clear();
  clients.length = 0;
  Reflect.deleteProperty(window, "RENDRO_REPO_COMMENT_CONFIG");
});

describe("repository comment scopes", () => {
  it("takes the page from a frame of the shell's own repository, at any ref", () => {
    for (const url of [frameUrl, `${ORIGIN}/r/OCTO/Docs/~main/files/docs/guide.md`, `${ORIGIN}/r/octo/docs/files/docs/guide.md`]) {
      expect(documentCommentScopeFromFrame(url, ORIGIN, config), url).toEqual({ repoId: 9001, documentPath: "docs/guide.md" });
    }
    for (const url of [
      `${ORIGIN}/r/octo/other/@${commit}/files/docs/guide.md`, `${ORIGIN}/r/octo/docs/@${commit}/tree`, `${ORIGIN}/r/octo/docs/@${commit}/files/a%2Fb.md`,
      `https://elsewhere.test/r/octo/docs/files/docs/guide.md`, `${ORIGIN}/organizations/o/projects/p/docs/files/guide.md`,
    ]) expect(documentCommentScopeFromFrame(url, ORIGIN, config), url).toBeNull();
    expect(documentCommentScopeFromFrame(frameUrl, ORIGIN, { ...config, accessUrl: "/nowhere" })).toBeNull();
    // A frame address that is no URL at all names no page.
    expect(documentCommentScopeFromFrame("http://[", ORIGIN, config)).toBeNull();
  });

  it("matches repository scopes by repository and page only", () => {
    const scope: DocumentCommentScope = { repoId: 1, documentPath: "a.md" };
    expect(sameScope(scope, { repoId: 1, documentPath: "a.md" })).toBe(true);
    expect(sameScope(scope, { repoId: 2, documentPath: "a.md" })).toBe(false);
    expect(sameScope(scope, { repoId: 1, documentPath: "b.md" })).toBe(false);
    expect(sameScope(null, scope)).toBe(false);
    expect(sameScope(scope, null)).toBe(false);
  });
});

describe("the repository comment host", () => {
  function setup(userId: string | null, hostConfig: ConstructorParameters<typeof CommentorParentHost>[2] = config) {
    const posted: Array<Record<string, unknown>> = [];
    const child = { postMessage: vi.fn((message: Record<string, unknown>) => { posted.push(message); }) };
    let load = () => {};
    const frame = { src: frameUrl, dataset: { navigation: "1", document: "1" }, contentWindow: child, addEventListener: (_type: string, listener: () => void) => { load = listener; }, removeEventListener: vi.fn() };
    const subscribe = vi.fn<DocumentCommentBackend["subscribe"]>(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) }));
    const mutate = vi.fn<DocumentCommentBackend["mutate"]>(() => Promise.resolve(null));
    const backend: DocumentCommentBackend = { subscribe, subscribeReplies: vi.fn(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) })), mutate };
    const host = new CommentorParentHost(frame as never, ORIGIN, hostConfig, backend, userId);
    host.start();
    load();
    const request = (requestId: string, method: string, args: unknown = {}) =>
      window.dispatchEvent(new MessageEvent("message", { data: { type: COMMENTOR_PARENT_REQUEST, requestId, method, args }, source: child as never }));
    const responses = () => posted.filter(message => message.type === COMMENTOR_PARENT_RESPONSE);
    const readies = () => posted.filter(message => message.type === COMMENTOR_PARENT_READY);
    const updates = () => posted.filter(message => message.type === COMMENTOR_PARENT_UPDATE);
    const live = (threads: unknown[], state = { canLoadMore: false, loading: false }) => subscribe.mock.calls.at(-1)![1](threads, state);
    return { host, subscribe, mutate, request, responses, readies, updates, live, load };
  }

  it("lets an anonymous reader read, and never write or keep drafts", () => {
    const { subscribe, mutate, request, responses, readies } = setup(null);
    expect(readies()).toEqual([expect.objectContaining({ userId: null, canWrite: false })]);
    request("sub", "subscribe", { documentPath: "docs/guide.md" });
    request("more", "threads.more");
    request("create", "thread.create", { body: "Hi", anchor });
    request("draft", "draft.save", { key: "create", draft: { body: "Hi", anchor } });
    expect(subscribe).toHaveBeenCalledWith({ repoId: 9001, documentPath: "docs/guide.md" }, expect.any(Function), expect.any(Function));
    expect(responses()).toEqual([
      expect.objectContaining({ requestId: "sub", ok: true }),
      expect.objectContaining({ requestId: "more", ok: true }),
      expect.objectContaining({ requestId: "create", ok: false, error: "Comment scope is unavailable" }),
      expect.objectContaining({ requestId: "draft", ok: false, error: "Comment scope is unavailable" }),
    ]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("carries edits (#287): says so, keeps an edit's draft only for a thread on the page, and sends the author's edit", async () => {
    const { host, mutate, request, responses, readies, live } = setup("user-a");
    host.setWritable(true);
    expect(readies().at(-1)).toMatchObject({ edits: true });
    request("sub", "subscribe", { documentPath: "docs/guide.md" });
    live([{ _id: "t1", replies: [{ _id: "r1" }] }]);
    const draft = (requestId: string, key: string) => request(requestId, "draft.save", { key, draft: { body: "Unsaved edit" } });
    draft("thread", "edit:t1");
    draft("reply", "edit:t1:r1");
    draft("other-thread", "edit:t2");
    draft("empty-reply", "edit:t1:");
    draft("extra", "edit:t1:r1:x");
    draft("no-thread", "edit:");
    draft("kind", "note:t1");
    request("edit", "thread.edit", { threadId: "t1", body: " Edited " });
    request("edit-reply", "reply.edit", { threadId: "t1", replyId: "r1", body: "Edited reply" });
    request("edit-other", "thread.edit", { threadId: "t2", body: "Edited" });
    request("edit-empty", "reply.edit", { threadId: "t1", replyId: "r1", body: "  " });
    request("edit-no-reply", "reply.edit", { threadId: "t1", body: "Edited" });
    await vi.waitFor(() => expect(responses()).toHaveLength(13));
    const answer = (requestId: string) => responses().find(response => response.requestId === requestId);
    for (const id of ["thread", "reply", "edit", "edit-reply"]) expect(answer(id), id).toMatchObject({ ok: true });
    for (const id of ["other-thread", "empty-reply", "extra", "no-thread", "kind"]) expect(answer(id), id).toMatchObject({ ok: false, error: "Comment recovery state could not be saved" });
    for (const id of ["edit-other", "edit-empty", "edit-no-reply"]) expect(answer(id), id).toMatchObject({ ok: false, error: "Comment operation is outside this document" });
    expect(mutate.mock.calls.map(([method, , args]) => [method, args])).toEqual([
      ["thread.edit", expect.objectContaining({ threadId: "t1", body: "Edited", expectedAuthorId: "user-a", clientOperationId: expect.any(String) })],
      ["reply.edit", expect.objectContaining({ threadId: "t1", replyId: "r1", body: "Edited reply" })],
    ]);
  });

  it("tells the widget it may write only once the read path granted access to a signed-in reader", async () => {
    const { host, mutate, request, responses, readies } = setup("user-a");
    expect(readies().at(-1)).toMatchObject({ userId: "user-a", canWrite: false });
    host.setWritable(true);
    host.setWritable(true);
    expect(readies()).toHaveLength(2);
    expect(readies().at(-1)).toMatchObject({ canWrite: true, parentGeneration: readies()[0].parentGeneration });
    request("sub", "subscribe", { documentPath: "docs/guide.md" });
    request("create", "thread.create", { body: "Hi", anchor });
    await vi.waitFor(() => expect(responses().map(response => response.requestId)).toEqual(["sub", "create"]));
    expect(mutate).toHaveBeenCalledWith("thread.create", { repoId: 9001, documentPath: "docs/guide.md" }, expect.objectContaining({ body: "Hi", anchor, expectedAuthorId: "user-a" }));
    host.setWritable(false);
    expect(readies().at(-1)).toMatchObject({ canWrite: false });
  });

  it("follows the shell to an adopted preload, announcing itself to the new frame only", () => {
    const { host, readies } = setup("user-a");
    const before = readies().length;
    const posted: Array<Record<string, unknown>> = [];
    // A preload the shell loaded (#296); a preload that went somewhere by itself is announced nothing.
    const stray = { src: `${ORIGIN}/r/octo/docs/@${commit}/files/docs/other.md`, dataset: { navigation: "1" }, contentWindow: { postMessage: (message: Record<string, unknown>) => { posted.push(message); } },
      addEventListener: vi.fn(), removeEventListener: vi.fn() };
    host.replaceFrame(stray as never);
    expect(posted).toEqual([]);
    const next = { ...stray, dataset: { navigation: "1", document: "1" }, addEventListener: vi.fn() };
    host.replaceFrame(next as never);
    host.replaceFrame(next as never);
    expect(posted.filter(message => message.type === COMMENTOR_PARENT_READY)).toHaveLength(1);
    expect(readies()).toHaveLength(before);
    expect(next.addEventListener).toHaveBeenCalledTimes(1);
  });
});

describe("the first comments before the live subscription (#284)", () => {
  function setup(userId: string | null, hostConfig?: ConstructorParameters<typeof CommentorParentHost>[2]) {
    const posted: Array<Record<string, unknown>> = [];
    const child = { postMessage: vi.fn((message: Record<string, unknown>) => { posted.push(message); }) };
    let load = () => {};
    const frame = { src: frameUrl, dataset: { navigation: "1", document: "1" }, contentWindow: child, addEventListener: (_type: string, listener: () => void) => { load = listener; }, removeEventListener: vi.fn() };
    const subscribe = vi.fn<DocumentCommentBackend["subscribe"]>(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) }));
    const mutate = vi.fn<DocumentCommentBackend["mutate"]>(() => Promise.resolve(null));
    const backend: DocumentCommentBackend = { subscribe, subscribeReplies: vi.fn(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) })), mutate };
    const host = new CommentorParentHost(frame as never, ORIGIN, hostConfig ?? config, backend, userId);
    host.start();
    load();
    const request = (requestId: string, method: string, args: unknown = {}) =>
      window.dispatchEvent(new MessageEvent("message", { data: { type: COMMENTOR_PARENT_REQUEST, requestId, method, args }, source: child as never }));
    const updates = () => posted.filter(message => message.type === COMMENTOR_PARENT_UPDATE);
    const responses = () => posted.filter(message => message.type === COMMENTOR_PARENT_RESPONSE);
    const live = (threads: unknown[], state = { canLoadMore: false, loading: false }) => subscribe.mock.calls.at(-1)![1](threads, state);
    return { host, subscribe, mutate, request, updates, responses, live, frame, load: () => load() };
  }
  const snapshot = (documentPath = "docs/guide.md") => ({ documentPath, threads: [{ _id: "t1" }, { _id: 7 }], canLoadMore: true });
  const subscribeNow = (request: (id: string, method: string, args?: unknown) => void, id = "sub") => request(id, "subscribe", { documentPath: "docs/guide.md" });

  it("holds the live subscription until the first access answer, shows its page, then lets the live page replace it", async () => {
    const { host, subscribe, mutate, request, updates, responses, live } = setup("user-a");
    host.holdLive();
    subscribeNow(request);
    // Answered at once; nothing is shown and nothing subscribes before the reader's grant is recorded.
    expect(responses()).toEqual([expect.objectContaining({ requestId: "sub", ok: true })]);
    expect(subscribe).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
    host.accessAnswered(snapshot());
    expect(updates()).toEqual([{ type: COMMENTOR_PARENT_UPDATE, threads: [{ _id: "t1" }, { _id: 7 }], canLoadMore: true, loading: false }]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    // The snapshot's threads may be replied to before the live page arrives, also while it is still loading.
    live([], { canLoadMore: false, loading: true });
    expect(updates().at(-1)).toMatchObject({ threads: [], loading: true });
    request("reply", "reply.add", { threadId: "t1", body: "Hi" });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    // The live page supersedes it: a deleted thread goes, a new one arrives.
    live([{ _id: "t2" }]);
    expect(updates().at(-1)).toMatchObject({ threads: [{ _id: "t2" }], loading: false });
    request("gone", "reply.add", { threadId: "t1", body: "Late" });
    expect(responses().at(-1)).toMatchObject({ requestId: "gone", ok: false, error: "Comment operation is outside this document" });
    // Once superseded, a later subscription never shows the stale snapshot again.
    subscribeNow(request, "again");
    expect(updates()).toHaveLength(3);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("shows a snapshot that arrived first at once, and never one of another page", () => {
    const first = setup("user-a");
    first.host.accessAnswered(snapshot());
    subscribeNow(first.request);
    expect(first.updates()).toHaveLength(1);
    expect(first.subscribe).toHaveBeenCalledTimes(1);

    const other = setup("user-a");
    other.host.accessAnswered(snapshot("docs/other.md"));
    subscribeNow(other.request);
    expect(other.updates()).toEqual([]);
    expect(other.subscribe).toHaveBeenCalledTimes(1);

    const none = setup(null);
    none.host.holdLive();
    subscribeNow(none.request);
    none.host.accessAnswered(null);
    expect(none.updates()).toEqual([]);
    expect(none.subscribe).toHaveBeenCalledTimes(1);
  });

  it("marks when each page's first comments reached its widget, and how long the reader's own writes took to save, for monitoring", async () => {
    performance.clearMeasures();
    const marks = (name: string) => performance.getEntriesByName(name).map(entry => ({ start: entry.startTime, kind: ((entry as PerformanceMeasure).detail as { kind: string }).kind }));
    const { host, mutate, request, live, load, frame } = setup("user-a");
    host.accessAnswered(snapshot());
    subscribeNow(request);
    // The opening page counts from navigation start; its snapshot was its first comments. The live page that follows is not another.
    live([{ _id: "t1" }]);
    expect(marks("rendro:comments")).toEqual([{ start: 0, kind: "cold" }]);
    // The reader's own thread and reply are timed until saved; other writes, and failures, are not.
    request("create", "thread.create", { body: "Hi", anchor });
    request("reply", "reply.add", { threadId: "t1", body: "Hi" });
    request("resolve", "thread.resolve", { threadId: "t1", resolved: true });
    await vi.waitFor(() => expect(marks("rendro:comment-echo")).toHaveLength(2));
    expect(marks("rendro:comment-echo").every(mark => mark.kind === "cold" && mark.start > 0)).toBe(true);
    mutate.mockImplementationOnce(() => Promise.reject(new Error("down")));
    request("failed", "reply.add", { threadId: "t1", body: "Again" });
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    expect(marks("rendro:comment-echo")).toHaveLength(2);
    // The next page counts from its frame's load, and only once its page is no longer loading.
    frame.src = `${ORIGIN}/r/octo/docs/@${commit}/files/docs/guide.md?next`;
    load();
    subscribeNow(request, "next");
    live([], { canLoadMore: false, loading: true });
    expect(marks("rendro:comments")).toHaveLength(1);
    live([]);
    expect(marks("rendro:comments")).toEqual([{ start: 0, kind: "cold" }, { start: expect.any(Number), kind: "switch" }]);
    expect(marks("rendro:comments")[1].start).toBeGreaterThan(0);
  });

  it("keeps working where measures are unavailable", () => {
    vi.spyOn(performance, "measure").mockImplementation(() => { throw new TypeError("no options"); });
    const { host, request, updates } = setup("user-a");
    host.accessAnswered(snapshot());
    subscribeNow(request);
    expect(updates()).toHaveLength(1);
  });

  it("answers nothing to a read from a page the shell has already left, and still refuses a write from it", () => {
    const { subscribe, mutate, request, responses, frame } = setup("user-a");
    // The sidebar moved the frame on; the page it is leaving has not unloaded, and its requests still arrive.
    frame.src = `${ORIGIN}/r/octo/docs/@${commit}/files/docs/next.md`;
    subscribeNow(request);
    request("more", "threads.more");
    request("replies", "replies.more", { threadId: "t1" });
    expect(responses()).toEqual([]);
    expect(subscribe).not.toHaveBeenCalled();
    request("create", "thread.create", { body: "Hi", anchor });
    expect(responses()).toEqual([expect.objectContaining({ requestId: "create", ok: false, error: "Comment scope is unavailable" })]);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("starts nothing for a frame that was replaced while it waited", () => {
    const { host, subscribe, request, updates, load } = setup("user-a");
    host.holdLive();
    subscribeNow(request);
    load();
    host.accessAnswered(snapshot());
    expect(subscribe).not.toHaveBeenCalled();
    expect(updates()).toEqual([]);
  });
});

describe("the repository Convex backend", () => {
  function client() {
    const calls: Array<{ query: unknown; args: unknown }> = [];
    const value = {
      onPaginatedUpdate_experimental(query: unknown, args: unknown) { calls.push({ query, args }); return vi.fn(); },
      mutation: vi.fn((..._args: unknown[]) => Promise.resolve(null)),
    };
    return { calls, value, backend: new ConvexRepoCommentBackend(value as never) };
  }
  const scope = { repoId: 9001, documentPath: "docs/guide.md" };

  it("reads threads and replies of one repository page", () => {
    const { calls, backend } = client();
    backend.subscribe(scope, vi.fn(), vi.fn());
    backend.subscribeReplies(scope, "t1" as never, vi.fn(), vi.fn());
    expect(calls.map(call => [getFunctionName(call.query as never), call.args])).toEqual([
      ["repoComments:listThreads", { repoId: 9001, path: "docs/guide.md" }],
      ["repoComments:listReplies", { repoId: 9001, path: "docs/guide.md", threadId: "t1" }],
    ]);
  });

  it("maps every write onto its mutation with explicit targets", async () => {
    const { value, backend } = client();
    const operation = { clientOperationId: "op", expectedAuthorId: "user-a" };
    await backend.mutate("thread.create", scope, { ...operation, body: "Hi", anchor });
    await backend.mutate("thread.resolve", scope, { ...operation, threadId: "t1", resolved: true });
    await backend.mutate("thread.archive", scope, { ...operation, threadId: "t1", archived: false });
    await backend.mutate("thread.remove", scope, { ...operation, threadId: "t1" });
    await backend.mutate("reply.add", scope, { ...operation, threadId: "t1", body: "Reply" });
    await backend.mutate("reply.remove", scope, { ...operation, threadId: "t1", replyId: "r1" });
    await backend.mutate("thread.edit", scope, { ...operation, threadId: "t1", body: "Edited" });
    await backend.mutate("reply.edit", scope, { ...operation, threadId: "t1", replyId: "r1", body: "Edited reply" });
    const common = { repoId: 9001, path: "docs/guide.md", ...operation };
    expect(value.mutation.mock.calls.map(([fn, args]) => [getFunctionName(fn as never), args])).toEqual([
      ["repoComments:createThread", { ...common, body: "Hi", anchor }],
      ["repoComments:resolve", { ...common, threadId: "t1", resolved: true }],
      ["repoComments:archive", { ...common, threadId: "t1", archived: false }],
      ["repoComments:removeThread", { ...common, threadId: "t1" }],
      ["repoComments:addReply", { ...common, threadId: "t1", body: "Reply" }],
      ["repoComments:removeReply", { ...common, threadId: "t1", replyId: "r1" }],
      ["repoComments:editThread", { ...common, threadId: "t1", body: "Edited" }],
      ["repoComments:editReply", { ...common, threadId: "t1", replyId: "r1", body: "Edited reply" }],
    ]);
    // A status write without a target is refused here as well as in the frame.
    await expect(backend.mutate("thread.resolve", scope, { threadId: "t1" })).rejects.toThrow("Invalid input");
    await expect(backend.mutate("thread.archive", scope, { threadId: "t1" })).rejects.toThrow("Invalid input");
  });
});

describe("keeping comment access", () => {
  function answers(...replies: Array<Response | Error>) {
    const fetcher = vi.fn(() => {
      const reply = replies.shift() ?? new Response(null, { status: 503 });
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

  it("renews halfway through each grant, waits after a denial and backs off after failures", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const fetcher = answers(
      Response.json({ expiresAt: now + 4 * 60_000 }),
      new Response(null, { status: 404 }),
      new Error("offline"), new Response(null, { status: 503 }), new Response("not json", { status: 200 }), new Response(null, { status: 503 }),
      Response.json({ expiresAt: now }),
    );
    const changes: boolean[] = [];
    const stop = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
    await settle();
    expect(fetcher).toHaveBeenCalledWith(config.accessUrl, expect.objectContaining({ method: "POST", credentials: "same-origin" }));
    expect(changes).toEqual([true]);
    await vi.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(changes).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(REPO_ACCESS_DENIED_RETRY_MS);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
    // Failures back off from five seconds, doubling, at most a minute.
    for (const delay of [5_000, 10_000, 20_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(7);
    expect(changes).toEqual([true, false, true]);
    // A grant already at its end is renewed after the minimum interval, never in a busy loop.
    await vi.advanceTimersByTimeAsync(REPO_ACCESS_MIN_RENEW_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(7);
    stop();
    await vi.advanceTimersByTimeAsync(REPO_ACCESS_MAX_RETRY_MS * 2);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("asks for the opening page's first comments once, and reports the first answer whatever it is (#284)", async () => {
    vi.useFakeTimers();
    const page = [{ _id: "t1" }];
    const fetcher = answers(Response.json({ expiresAt: Date.now() + 60_000, threads: { path: "docs/guide.md", page, isDone: false } }));
    const first = vi.fn();
    const stop = keepRepoCommentAccess(config.accessUrl, vi.fn(), { documentPath: "docs/guide.md", onAnswer: first });
    await settle();
    expect(fetcher).toHaveBeenCalledWith(`${config.accessUrl}?path=docs%2Fguide.md`, expect.objectContaining({ method: "POST", cache: "no-store" }));
    expect(first).toHaveBeenCalledWith({ documentPath: "docs/guide.md", threads: page, canLoadMore: true });
    // Renewals (halfway through the minute) ask for access only.
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(fetcher).toHaveBeenLastCalledWith(config.accessUrl, expect.anything());
    expect(first).toHaveBeenCalledTimes(1);
    stop();

    // A page for another document, a malformed one, none at all, a denial, a fault and an outage are all "no snapshot".
    for (const reply of [
      Response.json({ expiresAt: Date.now() + 60_000, threads: { path: "docs/other.md", page, isDone: true } }),
      Response.json({ expiresAt: Date.now() + 60_000, threads: { path: "docs/guide.md", page: "x", isDone: true } }),
      Response.json({ expiresAt: Date.now() + 60_000 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 503 }),
      new Error("offline"),
    ]) {
      answers(reply);
      const onAnswer = vi.fn();
      const stopOne = keepRepoCommentAccess(config.accessUrl, vi.fn(), { documentPath: "docs/guide.md", onAnswer });
      await settle();
      expect(onAnswer).toHaveBeenCalledWith(null);
      stopOne();
    }
    // Without an opening page, the first request asks for access only, and its answer still releases the host.
    const plain = answers(Response.json({ expiresAt: Date.now() + 60_000, threads: { path: "docs/guide.md", page, isDone: true } }));
    const onAnswer = vi.fn();
    const stopPlain = keepRepoCommentAccess(config.accessUrl, vi.fn(), { documentPath: null, onAnswer });
    await settle();
    expect(plain).toHaveBeenCalledWith(config.accessUrl, expect.anything());
    expect(onAnswer).toHaveBeenCalledWith(null);
    stopPlain();
    // Stopped while offline: nobody is told.
    let fail!: (error: Error) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })));
    const late = vi.fn();
    const stopLate = keepRepoCommentAccess(config.accessUrl, vi.fn(), { documentPath: "docs/guide.md", onAnswer: late });
    await settle();
    stopLate();
    fail(new Error("offline"));
    await settle();
    expect(late).not.toHaveBeenCalled();
  });

  it("caps the backoff at a minute", async () => {
    vi.useFakeTimers();
    const fetcher = answers();
    const stop = keepRepoCommentAccess(config.accessUrl, vi.fn());
    for (let index = 0; index < 8; index += 1) await vi.advanceTimersByTimeAsync(REPO_ACCESS_MAX_RETRY_MS);
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REPO_ACCESS_MAX_RETRY_MS);
    expect(fetcher.mock.calls.length).toBe(calls + 1);
    stop();
  });

  it("holds renewals while the tab is hidden, and drops an answer that arrives after it stopped", async () => {
    const show = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      show("hidden");
      const fetcher = answers(Response.json({ expiresAt: Date.now() + 60_000 }));
      const changes: boolean[] = [];
      const stop = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
      await settle();
      expect(fetcher).not.toHaveBeenCalled();
      show("visible");
      await settle();
      expect(changes).toEqual([true]);
      stop();
      show("hidden");
      const late = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
      late();
      show("visible");
      await settle();
      let resolve!: (response: Response) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
      const raced = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
      await settle();
      raced();
      resolve(Response.json({ expiresAt: Date.now() + 60_000 }));
      await settle();
      expect(changes).toEqual([true]);
      // Stopped while the answer's body was still being read: nothing is scheduled.
      vi.useFakeTimers();
      let body!: (value: unknown) => void;
      vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => new Promise(done => { body = done; }) })));
      const reading = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
      await settle();
      reading();
      body({ expiresAt: Date.now() + 60_000 });
      await settle();
      expect(vi.getTimerCount()).toBe(0);
      expect(changes).toEqual([true]);
      // Stopped while offline: the failure schedules nothing either.
      let fail!: (error: Error) => void;
      vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { fail = reject; })));
      const offline = keepRepoCommentAccess(config.accessUrl, writable => changes.push(writable));
      await settle();
      offline();
      fail(new Error("offline"));
      await settle();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      show("visible");
    }
  });
});

describe("booting the repository shell's comments", () => {
  function page() {
    document.body.innerHTML = `<iframe id="content-frame" data-navigation="1" data-document="1"></iframe>`;
    Object.assign(window, { RENDRO_REPO_COMMENT_CONFIG: config });
  }
  function server(users: Array<string | null>) {
    const fetcher = vi.fn((url: string) => {
      if (String(url).includes("get-session")) {
        const user = users.length > 1 ? users.shift()! : users[0];
        return Promise.resolve(new Response(JSON.stringify(user ? { user: { id: user } } : null)));
      }
      if (String(url) === config.accessUrl) return Promise.resolve(Response.json({ expiresAt: Date.now() + 60_000 }));
      return Promise.resolve(new Response(JSON.stringify({ token: "jwt" })));
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  beforeEach(page);

  it("reads anonymously without authenticating the client, and asks the read path for access", async () => {
    const fetcher = server([null]);
    const signedOut = vi.fn();
    window.addEventListener("commentor-sign-out", signedOut);
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === config.accessUrl)).toBe(true));
    expect(clients).toHaveLength(1);
    expect(clients[0].url).toBe(config.convexUrl);
    expect(clients[0].setAuth).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(signedOut).not.toHaveBeenCalled();
    dispose();
    window.removeEventListener("commentor-sign-out", signedOut);
  });

  it("hands the host whichever frame is the content frame, also one adopted while the session was checked", async () => {
    server([null]);
    let started: unknown[] = [];
    vi.spyOn(CommentorParentHost.prototype, "start").mockImplementation(function (this: CommentorParentHost, loaded?: boolean) {
      started = [(this as unknown as { frame: unknown }).frame, loaded];
    });
    const replaced = vi.spyOn(CommentorParentHost.prototype, "replaceFrame").mockImplementation(() => {});
    const original = document.getElementById("content-frame") as HTMLIFrameElement;
    const dispose = bootCommentorParentHost()!;
    // Announced before the host exists: nothing to tell yet.
    window.dispatchEvent(new CustomEvent("rendro:content-frame", { detail: document.createElement("iframe") }));
    // A preload becomes the content frame before the host exists: it has loaded by then.
    original.removeAttribute("id");
    const adopted = Object.assign(document.createElement("iframe"), { id: "content-frame" });
    document.body.append(adopted);
    await vi.waitFor(() => expect(started).toEqual([adopted, true]));
    // Later adoptions are announced by the shell; anything but a frame is ignored.
    window.dispatchEvent(new CustomEvent("rendro:content-frame", { detail: "not a frame" }));
    expect(replaced).not.toHaveBeenCalled();
    const later = document.createElement("iframe");
    window.dispatchEvent(new CustomEvent("rendro:content-frame", { detail: later }));
    expect(replaced).toHaveBeenCalledWith(later);
    dispose();
    window.dispatchEvent(new CustomEvent("rendro:content-frame", { detail: later }));
    expect(replaced).toHaveBeenCalledTimes(1);
  });

  it("asks for access and the opening page's comments at once, before the session check, and hands the host the answer (#284)", async () => {
    Object.assign(window, { RENDRO_REPO_COMMENT_CONFIG: { ...config, documentPath: "docs/guide.md" } });
    let session!: (response: Response) => void;
    const accessUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("get-session")) return new Promise<Response>(done => { session = done; });
      accessUrls.push(String(url));
      return Promise.resolve(Response.json({ expiresAt: Date.now() + 60_000, threads: { path: "docs/guide.md", page: [], isDone: true } }));
    }));
    const answered = vi.spyOn(CommentorParentHost.prototype, "accessAnswered");
    const writable = vi.spyOn(CommentorParentHost.prototype, "setWritable");
    const held = vi.spyOn(CommentorParentHost.prototype, "holdLive");
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(accessUrls).toEqual([`${config.accessUrl}?path=docs%2Fguide.md`]));
    // Answered before the host existed: the host gets it as it is created.
    await Promise.resolve();
    session(new Response("null"));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledWith({ documentPath: "docs/guide.md", threads: [], canLoadMore: false }));
    expect(writable).toHaveBeenCalledWith(true);
    expect(held).not.toHaveBeenCalled();
    dispose();
  });

  it("holds the host's live subscription when the access answer comes after it, and names the page the frame shows", async () => {
    // As after a back/forward-cache restore: the frame shows another page than the shell opened with.
    Object.defineProperty(document.getElementById("content-frame")!, "src", { value: `${location.origin}/r/octo/docs/~main/files/docs/shown.md` });
    let access!: (response: Response) => void;
    const accessUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (String(url).includes("get-session")) return Promise.resolve(new Response("null"));
      accessUrls.push(String(url));
      return new Promise<Response>(done => { access = done; });
    }));
    const answered = vi.spyOn(CommentorParentHost.prototype, "accessAnswered");
    const writable = vi.spyOn(CommentorParentHost.prototype, "setWritable");
    const held = vi.spyOn(CommentorParentHost.prototype, "holdLive");
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(held).toHaveBeenCalled());
    expect(accessUrls).toEqual([`${config.accessUrl}?path=docs%2Fshown.md`]);
    expect(answered).not.toHaveBeenCalled();
    access(new Response(null, { status: 404 }));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledWith(null));
    expect(writable).toHaveBeenCalledWith(false);
    dispose();
  });

  it("authenticates a signed-in reader, and stops everything when that reader signs out", async () => {
    const fetcher = server(["user-a", null]);
    const signedOut = vi.fn();
    window.addEventListener("commentor-sign-out", signedOut);
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(clients[0].setAuth).toHaveBeenCalled());
    await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => url === config.accessUrl)).toBe(true));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalled());
    expect(clients[0].close).toHaveBeenCalled();
    dispose();
    window.removeEventListener("commentor-sign-out", signedOut);
  });
});
