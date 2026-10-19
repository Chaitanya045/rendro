// @vitest-environment happy-dom
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootCommentorParentHost, CommentorParentHost, ConvexDocumentCommentBackend, ConvexRepoCommentBackend, documentCommentScopeFromFrame, keepRepoCommentAccess,
  REPO_ACCESS_DENIED_RETRY_MS, REPO_ACCESS_MAX_RETRY_MS, REPO_ACCESS_MIN_RENEW_MS, sameScope, type DocumentCommentBackend, type DocumentCommentScope,
} from "../src/commentor/parent-host";
import { COMMENTOR_PARENT_READY, COMMENTOR_PARENT_REQUEST, COMMENTOR_PARENT_RESPONSE } from "../src/commentor/parent-protocol";

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
  });

  it("matches repository scopes by repository and page only", () => {
    const scope: DocumentCommentScope = { repoId: 1, documentPath: "a.md" };
    expect(sameScope(scope, { repoId: 1, documentPath: "a.md" })).toBe(true);
    expect(sameScope(scope, { repoId: 2, documentPath: "a.md" })).toBe(false);
    expect(sameScope(scope, { organizationId: "o", projectId: "p" as never, documentPath: "a.md" })).toBe(false);
    expect(sameScope({ organizationId: "o", projectId: "p" as never, documentPath: "a.md" }, scope)).toBe(false);
  });
});

describe("the repository comment host", () => {
  function setup(userId: string | null) {
    const posted: Array<Record<string, unknown>> = [];
    const child = { postMessage: vi.fn((message: Record<string, unknown>) => { posted.push(message); }) };
    let load = () => {};
    const frame = { src: frameUrl, contentWindow: child, addEventListener: (_type: string, listener: () => void) => { load = listener; }, removeEventListener: vi.fn() };
    const subscribe = vi.fn<DocumentCommentBackend["subscribe"]>(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) }));
    const mutate = vi.fn<DocumentCommentBackend["mutate"]>(() => Promise.resolve(null));
    const backend: DocumentCommentBackend = { subscribe, subscribeReplies: vi.fn(() => ({ unsubscribe: vi.fn(), loadMore: vi.fn(() => true) })), mutate };
    const host = new CommentorParentHost(frame as never, ORIGIN, config, backend, userId);
    host.start();
    load();
    const request = (requestId: string, method: string, args: unknown = {}) =>
      window.dispatchEvent(new MessageEvent("message", { data: { type: COMMENTOR_PARENT_REQUEST, requestId, method, args }, source: child as never }));
    const responses = () => posted.filter(message => message.type === COMMENTOR_PARENT_RESPONSE);
    const readies = () => posted.filter(message => message.type === COMMENTOR_PARENT_READY);
    return { host, subscribe, mutate, request, responses, readies };
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
    const next = { src: `${ORIGIN}/r/octo/docs/@${commit}/files/docs/other.md`, contentWindow: { postMessage: (message: Record<string, unknown>) => { posted.push(message); } },
      addEventListener: vi.fn(), removeEventListener: vi.fn() };
    host.replaceFrame(next as never);
    host.replaceFrame(next as never);
    expect(posted.filter(message => message.type === COMMENTOR_PARENT_READY)).toHaveLength(1);
    expect(readies()).toHaveLength(before);
    expect(next.addEventListener).toHaveBeenCalledTimes(1);
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
  const project = { organizationId: "o", projectId: "p" as never, documentPath: "a.html" };

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
    const common = { repoId: 9001, path: "docs/guide.md", ...operation };
    expect(value.mutation.mock.calls.map(([fn, args]) => [getFunctionName(fn as never), args])).toEqual([
      ["repoComments:createThread", { ...common, body: "Hi", anchor }],
      ["repoComments:resolve", { ...common, threadId: "t1", resolved: true }],
      ["repoComments:archive", { ...common, threadId: "t1", archived: false }],
      ["repoComments:removeThread", { ...common, threadId: "t1" }],
      ["repoComments:addReply", { ...common, threadId: "t1", body: "Reply" }],
      ["repoComments:removeReply", { ...common, threadId: "t1", replyId: "r1" }],
    ]);
    // Old widgets' toggles have no target; nothing here toggles.
    await expect(backend.mutate("thread.resolve", scope, { threadId: "t1" })).rejects.toThrow("Invalid input");
    await expect(backend.mutate("thread.archive", scope, { threadId: "t1" })).rejects.toThrow("Invalid input");
  });

  it("never mixes repository and project scopes", () => {
    const { backend } = client();
    expect(() => backend.subscribe(project, vi.fn(), vi.fn())).toThrow("Invalid repository scope");
    expect(() => backend.subscribeReplies(project, "t" as never, vi.fn(), vi.fn())).toThrow("Invalid repository scope");
    expect(() => backend.mutate("thread.remove", project, {})).toThrow("Invalid repository scope");
    const projects = new ConvexDocumentCommentBackend(client().value as never);
    expect(() => projects.subscribe(scope, vi.fn(), vi.fn())).toThrow("Invalid project scope");
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
    document.body.innerHTML = `<iframe id="content-frame"></iframe>`;
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
