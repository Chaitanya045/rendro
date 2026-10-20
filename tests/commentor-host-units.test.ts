// @vitest-environment happy-dom
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootCommentorParentHost, CommentorParentHost, ConvexRepoCommentBackend, type DocumentCommentBackend,
} from "../src/commentor/parent-host";
import {
  COMMENTOR_PARENT_ERROR, COMMENTOR_PARENT_READY, COMMENTOR_PARENT_REQUEST, COMMENTOR_PARENT_RESPONSE, COMMENTOR_PARENT_REPLIES_UPDATE,
} from "../src/commentor/parent-protocol";

const clients = vi.hoisted(() => [] as Array<{
  url: string; setAuth: ReturnType<typeof vi.fn>; onUpdate: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
}>);
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    setAuth = vi.fn();
    onUpdate = vi.fn(() => vi.fn());
    close = vi.fn(async () => {});
    constructor(readonly url: string) { clients.push(this); }
  },
}));

const repo = { repoId: 9101, accessUrl: "/r/acme/docs/comment-access" };
const documentUrl = "https://rendro.test/r/acme/docs/files/guide.html";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; document.documentElement.removeAttribute("data-rendro-signed-out"); sessionStorage.clear(); clients.length = 0; });

describe("comment host protocol handling", () => {
  type Subscription = { unsubscribe: ReturnType<typeof vi.fn>; loadMore: ReturnType<typeof vi.fn> };
  function setup(options: { contentWindow?: unknown; src?: string; userId?: string | null } = {}) {
    const posted: Array<Record<string, unknown>> = [];
    const child = { postMessage: vi.fn((message: Record<string, unknown>) => { posted.push(message); }) };
    let load = () => {};
    const frame = {
      src: options.src ?? documentUrl,
      contentWindow: "contentWindow" in options ? options.contentWindow : child,
      addEventListener: (_type: string, listener: () => void) => { load = listener; },
      removeEventListener: vi.fn(),
    };
    const subscriptions: Subscription[] = [];
    const replySubscriptions: Subscription[] = [];
    let publish!: Parameters<DocumentCommentBackend["subscribe"]>[1];
    let fail!: (error: Error) => void;
    let publishReplies!: Parameters<DocumentCommentBackend["subscribeReplies"]>[2];
    let failReplies!: (error: Error) => void;
    const pendingMutations: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const mutate = vi.fn<DocumentCommentBackend["mutate"]>(() => new Promise<void>((resolve, reject) => { pendingMutations.push({ resolve, reject }); }));
    const backend: DocumentCommentBackend = {
      subscribe: (_scope, onUpdate, onError) => {
        publish = onUpdate; fail = onError;
        const subscription = { unsubscribe: vi.fn(), loadMore: vi.fn(() => true) };
        subscriptions.push(subscription);
        return subscription;
      },
      subscribeReplies: (_scope, _threadId, onUpdate, onError) => {
        publishReplies = onUpdate; failReplies = onError;
        const subscription = { unsubscribe: vi.fn(), loadMore: vi.fn(() => false) };
        replySubscriptions.push(subscription);
        return subscription;
      },
      mutate,
    };
    const host = new CommentorParentHost(frame as never, "https://rendro.test", { ...repo, convexUrl: "https://convex.test" }, backend,
      options.userId === undefined ? "user-a" : options.userId);
    host.start();
    const receive = (data: unknown, source: unknown = child) => window.dispatchEvent(new MessageEvent("message", { data, source: source as never }));
    const request = (requestId: string, method: string, args: unknown = {}, source: unknown = child) =>
      receive({ type: COMMENTOR_PARENT_REQUEST, requestId, method, args }, source);
    const responses = () => posted.filter(message => message.type === COMMENTOR_PARENT_RESPONSE);
    const subscribe = () => { load(); request("sub", "subscribe", { documentPath: "guide.html" }); };
    return { host, frame, child, posted, backend, mutate, load: () => load(), receive, request, responses, subscribe, subscriptions, replySubscriptions, pendingMutations,
      publish: (...args: Parameters<typeof publish>) => publish(...args), fail: (error: Error) => fail(error),
      publishReplies: (...args: Parameters<typeof publishReplies>) => publishReplies(...args), failReplies: (error: Error) => failReplies(error) };
  }
  const thread = (id: unknown) => ({ _id: id });

  it("announces itself only for the document it owns, and reports a failed announcement", () => {
    const foreign = setup({ src: "https://elsewhere.test/r/acme/docs/files/guide.html" });
    foreign.load();
    expect(foreign.posted).toEqual([]);
    const detached = setup({ contentWindow: null });
    detached.load();
    detached.host.dispose();
    const throwing = setup();
    throwing.child.postMessage.mockImplementationOnce(() => { throw new Error("detached"); });
    throwing.load();
    expect(throwing.posted).toEqual([{ type: COMMENTOR_PARENT_ERROR, error: "Comments could not be loaded" }]);
    const anonymous = setup({ userId: null });
    anonymous.load();
    expect(anonymous.posted[0]).toMatchObject({ type: COMMENTOR_PARENT_READY, userId: null, recoveryState: { operations: {}, drafts: {} } });
  });

  it("reports unavailable durable storage instead of announcing recovery state or accepting writes", () => {
    const unavailable = setup();
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(undefined as never);
    unavailable.load();
    expect(unavailable.posted).toEqual([{ type: COMMENTOR_PARENT_ERROR, error: "Comments could not be loaded" }]);
    unavailable.request("write", "thread.resolve", { threadId: "t", resolved: true });
    unavailable.request("draft", "draft.save", { key: "create", draft: { body: "x", anchor: { kind: "repo-text", blobSha: "b".repeat(40), headingSlug: "install", prefix: "", exact: "pnpm install", suffix: "", offset: 0 } } });
    expect(unavailable.responses()).toEqual([
      expect.objectContaining({ requestId: "write", ok: false, error: "Comment scope is unavailable" }),
      expect.objectContaining({ requestId: "draft", ok: false, error: "Comment scope is unavailable" }),
    ]);
  });

  it("stays silent toward a window it cannot post to, and answers none of a missing source", () => {
    const mute = setup({ contentWindow: {} });
    mute.load();
    mute.request("x", "subscribe", { documentPath: "guide.html" }, mute.frame.contentWindow);
    mute.publish([thread("t")], { canLoadMore: false, loading: false });
    mute.request("more", "replies.more", { threadId: "t" }, mute.frame.contentWindow);
    mute.publishReplies([{ _id: "r" }], { canLoadMore: false, loading: false });
    mute.fail(new Error("boom"));
    expect(mute.posted).toEqual([]);
    const sourceless = setup({ contentWindow: null });
    sourceless.load();
    sourceless.receive({ type: COMMENTOR_PARENT_REQUEST, requestId: "x", method: "subscribe", args: {} }, null);
    expect(sourceless.posted).toEqual([]);
  });

  it("requires a subscription from the current window before serving anything else", () => {
    const state = setup();
    state.load();
    state.request("early", "thread.remove", { threadId: "t" });
    expect(state.responses()[0]).toMatchObject({ requestId: "early", ok: false, error: "Comment scope is unavailable" });
    state.request("sub", "subscribe", { documentPath: "guide.html" });
    state.publish([thread("t"), thread(7), thread(null)], { canLoadMore: false, loading: false });
    const other = { postMessage: vi.fn() };
    state.frame.contentWindow = other;
    state.request("swapped", "thread.resolve", { threadId: "t", resolved: true }, other);
    expect(other.postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "swapped", ok: false, error: "Comment scope is unavailable" }), "*");
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it("keeps a thread's reply stream only while the thread is listed, and drops stale streams and errors", () => {
    const state = setup();
    state.subscribe();
    state.publish([thread("a"), thread("b")], { canLoadMore: false, loading: false });
    state.request("replies", "replies.more", { threadId: "a" });
    state.request("again", "replies.more", { threadId: "a" });
    expect(state.responses().slice(-2)).toMatchObject([{ requestId: "replies", ok: true }, { requestId: "again", ok: false, error: "No older replies are available" }]);
    state.request("replies-b", "replies.more", { threadId: "b" });
    state.publish([thread("a")], { canLoadMore: true, loading: false });
    expect(state.replySubscriptions.map(subscription => subscription.unsubscribe.mock.calls.length)).toEqual([0, 1]);
    state.publishReplies([{ _id: "r" }], { canLoadMore: false, loading: false });
    expect(state.posted.filter(message => message.type === COMMENTOR_PARENT_REPLIES_UPDATE)).toHaveLength(0);
    state.failReplies(new ConvexError({ code: "forbidden", message: "private" }));
    expect(state.posted.at(-1)).toEqual({ type: COMMENTOR_PARENT_ERROR, error: "You do not have permission to change this comment." });
    // After navigation nothing from the old subscriptions reaches the document.
    state.load();
    const count = state.posted.length;
    expect(state.posted.at(-1)).toMatchObject({ type: COMMENTOR_PARENT_READY });
    state.fail(new Error("late"));
    state.failReplies(new Error("late"));
    state.publishReplies([{ _id: "r" }], { canLoadMore: false, loading: false });
    state.publish([thread("a")], { canLoadMore: false, loading: false });
    expect(state.posted).toHaveLength(count);
  });

  it("lets a retried removal through only when its durable operation survives, and only for removals", () => {
    const state = setup();
    state.subscribe();
    state.publish([thread("gone")], { canLoadMore: false, loading: false });
    state.request("first", "thread.remove", { threadId: "gone", clientOperationId: "op-1" });
    expect(state.mutate).toHaveBeenCalledTimes(1);
    // The deletion appeared to finish: the thread has left the page but the operation is still recorded.
    state.publish([], { canLoadMore: false, loading: false });
    state.request("retry", "thread.remove", { threadId: "gone", clientOperationId: "op-1" });
    expect(state.mutate).toHaveBeenCalledTimes(2);
    state.request("other-id", "thread.remove", { threadId: "gone", clientOperationId: "op-2" });
    state.request("other-method", "thread.resolve", { threadId: "gone", resolved: true, clientOperationId: "op-1" });
    state.request("unknown", "thread.remove", { threadId: "never-seen", clientOperationId: "op-1" });
    expect(state.responses().slice(1).map(response => [response.requestId, response.error])).toEqual([
      ["other-id", "Comment operation is outside this document"], ["other-method", "Comment operation is outside this document"], ["unknown", "Comment operation is outside this document"],
    ]);
    vi.spyOn(window, "sessionStorage", "get").mockReturnValue(undefined as never);
    state.request("no-storage", "thread.remove", { threadId: "gone", clientOperationId: "op-1" });
    expect(state.responses().at(-1)).toMatchObject({ requestId: "no-storage", error: "Comment operation is outside this document" });
  });

  it("never answers a write whose document was replaced while it was in flight", async () => {
    const state = setup();
    state.subscribe();
    state.publish([thread("t")], { canLoadMore: false, loading: false });
    state.request("resolve", "thread.resolve", { threadId: "t", resolved: true });
    state.request("archive", "thread.archive", { threadId: "t", archived: true });
    state.load();
    state.pendingMutations[0].resolve();
    state.pendingMutations[1].reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.responses().map(response => response.requestId)).toEqual(["sub"]);
  });

  it("acknowledges operation completion without an identity and rejects oversized keys", () => {
    const state = setup();
    state.subscribe();
    state.publish([thread("t")], { canLoadMore: false, loading: false });
    state.request("noid", "operation.complete", { key: "t" });
    state.request("longkey", "operation.complete", { key: "k".repeat(257), clientOperationId: "id" });
    expect(state.responses().map(response => [response.requestId, response.ok])).toEqual([["sub", true], ["noid", true], ["longkey", false]]);
  });
});

describe("Convex backends", () => {
  type Client = ConstructorParameters<typeof ConvexRepoCommentBackend>[0];
  function fakeClient() {
    const calls: Array<{ query: unknown; args: unknown; options: unknown }> = [];
    let report!: (result: { results: unknown[]; status: string; loadMore: (count: number) => boolean }) => void;
    const unsubscribe = vi.fn();
    const client = {
      onPaginatedUpdate_experimental(query: unknown, args: unknown, options: unknown, callback: typeof report) { calls.push({ query, args, options }); report = callback; return unsubscribe; },
      onUpdate: vi.fn(() => unsubscribe),
      mutation: vi.fn(() => Promise.resolve(null)),
    };
    return { client: client as unknown as Client, calls, report: (result: Parameters<typeof report>[0]) => report(result), unsubscribe, raw: client };
  }
  const scope = { repoId: 9101, documentPath: "guide.html" };

  it("pages thread and reply subscriptions, reversing replies and reporting pagination state", () => {
    const { client, calls, report, unsubscribe } = fakeClient();
    const backend = new ConvexRepoCommentBackend(client);
    const onUpdate = vi.fn();
    const threads = backend.subscribe(scope, onUpdate, vi.fn());
    expect(getFunctionName(calls[0].query as never)).toBe("repoComments:listThreads");
    expect(calls[0].args).toEqual({ repoId: 9101, path: "guide.html" });
    expect(calls[0].options).toEqual({ initialNumItems: 20 });
    expect(threads.loadMore()).toBe(false);
    const loadMore = vi.fn(() => true);
    report({ results: [1, 2], status: "CanLoadMore", loadMore });
    report({ results: [3], status: "LoadingFirstPage", loadMore });
    report({ results: [4], status: "LoadingMore", loadMore });
    report({ results: [5], status: "Exhausted", loadMore });
    expect(onUpdate.mock.calls).toEqual([[[1, 2], { canLoadMore: true, loading: false }], [[3], { canLoadMore: true, loading: true }], [[4], { canLoadMore: true, loading: true }], [[5], { canLoadMore: false, loading: false }]]);
    expect(threads.loadMore()).toBe(true);
    expect(loadMore).toHaveBeenCalledWith(20);
    threads.unsubscribe();
    expect(unsubscribe).toHaveBeenCalled();
    const replies = vi.fn();
    backend.subscribeReplies(scope, "t" as never, replies, vi.fn());
    expect(getFunctionName(calls[1].query as never)).toBe("repoComments:listReplies");
    expect(calls[1].args).toEqual({ repoId: 9101, path: "guide.html", threadId: "t" });
    report({ results: [1, 2, 3], status: "Exhausted", loadMore });
    expect(replies).toHaveBeenCalledWith([3, 2, 1], { canLoadMore: false, loading: false });
  });
});

describe("booting the parent host", () => {
  const repoConfig = { ...repo, convexUrl: "https://convex.test" };
  function page(config: Record<string, unknown> | null = repoConfig) {
    document.body.innerHTML = '<iframe id="content-frame"></iframe>';
    Reflect.deleteProperty(window, "RENDRO_REPO_COMMENT_CONFIG");
    if (config) Object.assign(window, { RENDRO_REPO_COMMENT_CONFIG: config });
  }
  // The read path's comment access answers "not granted" (404): this suite is about sessions and tokens.
  function session(user: unknown = { id: "user-a" }, token: unknown = { token: "jwt" }, status = 200, tokenStatus = 200) {
    const fetcher = vi.fn((url: string) => Promise.resolve(String(url).includes("get-session")
      ? new Response(JSON.stringify(user ? { user } : null), { status })
      : String(url).includes("comment-access") ? new Response(null, { status: 404 })
      : new Response(JSON.stringify(token), { status: tokenStatus })));
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }
  beforeEach(() => { page(); });

  it("does not start for a signed-out page, without configuration or without the document frame", () => {
    document.documentElement.dataset.rendroSignedOut = "true";
    expect(bootCommentorParentHost()).toBeNull();
    document.documentElement.removeAttribute("data-rendro-signed-out");
    page(null);
    expect(bootCommentorParentHost()).toBeNull();
    page({ ...repo });
    expect(bootCommentorParentHost()).toBeNull();
    page();
    document.body.innerHTML = "<div id='content-frame'></div>";
    expect(bootCommentorParentHost()).toBeNull();
    expect(clients).toHaveLength(0);
  });

  it("shares one session check among concurrent callers and hands out tokens only while access holds", async () => {
    const fetcher = session();
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(clients[0].setAuth).toHaveBeenCalled());
    const authenticate = clients[0].setAuth.mock.calls[0][0] as () => Promise<string | null>;
    fetcher.mockClear();
    window.dispatchEvent(new Event("focus"));
    const [first, second] = await Promise.all([authenticate(), authenticate()]);
    expect([first, second]).toEqual(["jwt", "jwt"]);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("get-session"))).toHaveLength(1);
    // A refused, empty or failed token gives the client nothing.
    fetcher.mockImplementation((url: string) => Promise.resolve(String(url).includes("get-session") ? new Response(JSON.stringify({ user: { id: "user-a" } })) : new Response("{}", { status: 403 })));
    expect(await authenticate()).toBeNull();
    fetcher.mockImplementation((url: string) => Promise.resolve(String(url).includes("get-session") ? new Response(JSON.stringify({ user: { id: "user-a" } })) : new Response(JSON.stringify({ token: "" }))));
    expect(await authenticate()).toBeNull();
    fetcher.mockImplementation((url: string) => Promise.resolve(String(url).includes("get-session") ? new Response(JSON.stringify({ user: { id: "user-a" } })) : new Response("{}", { status: 500 })));
    expect(await authenticate()).toBeNull();
    dispose();
    expect(await authenticate()).toBeNull();
    expect(clients[0].close).toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
  });

  it("holds a scheduled token refresh while the tab is hidden and runs it when the tab returns", async () => {
    const fetcher = session();
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(clients[0].setAuth).toHaveBeenCalled());
    const authenticate = clients[0].setAuth.mock.calls[0][0] as (args?: { forceRefreshToken: boolean }) => Promise<string | null>;
    const show = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      fetcher.mockClear();
      show("hidden");
      // A cached token is only checked, and the client can always ask without forcing.
      expect(await authenticate({ forceRefreshToken: false })).toBe("jwt");
      expect(fetcher).toHaveBeenCalledTimes(2);
      fetcher.mockClear();
      const refresh = authenticate({ forceRefreshToken: true });
      const rejected = authenticate({ forceRefreshToken: true });
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
      expect(fetcher).not.toHaveBeenCalled();
      show("visible");
      expect(await Promise.all([refresh, rejected])).toEqual(["jwt", "jwt"]);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes("convex/token"))).toHaveLength(2);
      // A visible tab refreshes at once.
      fetcher.mockClear();
      expect(await authenticate({ forceRefreshToken: true })).toBe("jwt");
      expect(fetcher).toHaveBeenCalledTimes(2);
      // A page closed while hidden hands the late refresh nothing.
      fetcher.mockClear();
      show("hidden");
      const late = authenticate({ forceRefreshToken: true });
      dispose();
      show("visible");
      expect(await late).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it.each([
    { name: "a token", reply: () => new Response(JSON.stringify({ token: "late" })) },
    { name: "a refusal", reply: () => new Response("{}", { status: 401 }) },
  ])("hands nothing to the client when the page closes before $name arrives", async ({ reply }) => {
    let answer!: (response: Response) => void;
    const fetcher = session();
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(clients[0].setAuth).toHaveBeenCalled());
    const authenticate = clients[0].setAuth.mock.calls[0][0] as () => Promise<string | null>;
    fetcher.mockImplementation((url: string) => String(url).includes("get-session")
      ? Promise.resolve(new Response(JSON.stringify({ user: { id: "user-a" } })))
      : new Promise<Response>(resolve => { answer = resolve; }));
    const pending = authenticate();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    dispose();
    answer(reply());
    expect(await pending).toBeNull();
  });

  it("signs out when a signed-in reader's session ends", async () => {
    const fetcher = session();
    const signedOut = vi.fn();
    window.addEventListener("commentor-sign-out", signedOut);
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(clients[0].setAuth).toHaveBeenCalled());
    fetcher.mockImplementation((url: string) => Promise.resolve(String(url).includes("get-session") ? new Response("null", { status: 401 }) : new Response(null, { status: 404 })));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(signedOut).toHaveBeenCalled());
    expect(clients[0].close).toHaveBeenCalled();
    window.removeEventListener("commentor-sign-out", signedOut);
    dispose();
  });

  it("stays quiet when the session cannot be checked, at boot and when the tab regains focus", async () => {
    const fetcher = session(null, {}, 500);
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    await Promise.resolve();
    expect(clients[0].setAuth).not.toHaveBeenCalled();
    const checks = () => fetcher.mock.calls.filter(([url]) => String(url).includes("get-session")).length;
    const before = checks();
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(checks()).toBe(before + 1));
    expect(clients[0].setAuth).not.toHaveBeenCalled();
    dispose();
  });

  it.each(["closes", "signs out elsewhere"] as const)("starts nothing when the page %s before the first session check answers", async ending => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => String(url).includes("get-session")
      ? new Promise<Response>(resolve => { answer = resolve; })
      : Promise.resolve(new Response(null, { status: 404 }))));
    const dispose = bootCommentorParentHost()!;
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    if (ending === "closes") dispose();
    else window.dispatchEvent(new Event("commentor-sign-out"));
    answer(new Response(JSON.stringify({ user: { id: "user-a" } })));
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(clients[0].setAuth).not.toHaveBeenCalled();
    if (ending !== "closes") dispose();
  });
});
