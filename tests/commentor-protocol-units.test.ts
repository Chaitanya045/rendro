import { Window as StorageWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingDeletionCoordinator } from "../src/commentor/delete-state";
import { normalizeMutationArgs, record, validAnchor } from "../src/commentor/mutation-args";
import { CommentOperationConflictError, CommentOperationState, mutationKey } from "../src/commentor/operation-state";
import {
  COMMENTOR_PARENT_ERROR, COMMENTOR_PARENT_READY, COMMENTOR_PARENT_REPLIES_UPDATE, COMMENTOR_PARENT_REQUEST, COMMENTOR_PARENT_RESPONSE,
  COMMENTOR_PARENT_UPDATE, COMMENTOR_PROTOCOL_VERSION, COMMENTOR_VIEWER_RELOAD,
  isCommentorParentError, isCommentorParentReady, isCommentorParentReadySignal, isCommentorParentRepliesUpdate,
  isCommentorParentRequest, isCommentorParentResponse, isCommentorParentUpdate,
} from "../src/commentor/parent-protocol";
import { CommentMutationRejectedError, ParentCommentTransport } from "../src/commentor/parent-transport";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("protocol message guards", () => {
  const junk = [null, undefined, "text", 7, true];
  it.each([
    ["request", isCommentorParentRequest, { type: COMMENTOR_PARENT_REQUEST, requestId: "r", method: "subscribe", args: {} },
      [{ type: "other" }, { type: COMMENTOR_PARENT_REQUEST, requestId: "", method: "subscribe" }, { type: COMMENTOR_PARENT_REQUEST, requestId: "x".repeat(161), method: "subscribe" },
        { type: COMMENTOR_PARENT_REQUEST, requestId: 4, method: "subscribe" }, { type: COMMENTOR_PARENT_REQUEST, requestId: "r", method: "drop.table" }, { type: COMMENTOR_PARENT_REQUEST, requestId: "r", method: 4 }]],
    ["response", isCommentorParentResponse, { type: COMMENTOR_PARENT_RESPONSE, requestId: "r", ok: true },
      [{ type: "other", requestId: "r", ok: true }, { type: COMMENTOR_PARENT_RESPONSE, requestId: 1, ok: true }, { type: COMMENTOR_PARENT_RESPONSE, requestId: "r", ok: "yes" }]],
    ["update", isCommentorParentUpdate, { type: COMMENTOR_PARENT_UPDATE, threads: [], canLoadMore: false, loading: false },
      [{ type: "other", threads: [], canLoadMore: false, loading: false }, { type: COMMENTOR_PARENT_UPDATE, threads: {}, canLoadMore: false, loading: false },
        { type: COMMENTOR_PARENT_UPDATE, threads: [], canLoadMore: 0, loading: false }, { type: COMMENTOR_PARENT_UPDATE, threads: [], canLoadMore: false, loading: "no" }]],
    ["replies update", isCommentorParentRepliesUpdate, { type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: "t", replies: [], canLoadMore: false, loading: false },
      [{ type: "other", threadId: "t", replies: [], canLoadMore: false, loading: false }, { type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: 1, replies: [], canLoadMore: false, loading: false },
        { type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: "t", replies: null, canLoadMore: false, loading: false }, { type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: "t", replies: [], canLoadMore: 1, loading: false },
        { type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: "t", replies: [], canLoadMore: false, loading: 1 }]],
    ["error", isCommentorParentError, { type: COMMENTOR_PARENT_ERROR, error: "x" }, [{ type: "other", error: "x" }, { type: COMMENTOR_PARENT_ERROR, error: 1 }]],
    ["ready", isCommentorParentReady, { type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "g" },
      [{ type: "other", protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "g" }, { type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION - 1, parentGeneration: "g" },
        { type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: 3 }, { type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "" }]],
    ["ready signal", isCommentorParentReadySignal, { type: COMMENTOR_PARENT_READY }, [{ type: "other" }, {}]],
  ] as const)("%s accepts its shape and rejects every other", (_name, guard, valid, invalid) => {
    expect(guard(valid)).toBe(true);
    for (const value of [...junk, ...invalid]) expect(guard(value), JSON.stringify(value)).toBe(false);
  });
});

describe("mutation argument validation", () => {
  const anchor = { kind: "element", path: ["main"] };
  const text = { kind: "text-range", quote: "quote", path: ["main", "p"], startOffset: 0, endOffset: 5 };
  it("treats only plain objects as records", () => {
    expect(record({ a: 1 })).toEqual({ a: 1 });
    for (const value of [null, undefined, [], "x", 3]) expect(record(value)).toBeNull();
  });
  it.each([
    [anchor, true], [text, true], [{ ...text, startOffset: 1_000_000, endOffset: 0 }, true],
    [null, false], [{ kind: "element" }, false], [{ kind: "element", path: [] }, false], [{ kind: "element", path: Array(65).fill("p") }, false],
    [{ kind: "element", path: ["   "] }, false], [{ kind: "element", path: [3] }, false], [{ kind: "element", path: ["x".repeat(257)] }, false], [{ kind: "area", path: ["main"] }, false],
    [{ ...text, quote: 4 }, false], [{ ...text, quote: "  " }, false], [{ ...text, quote: "q".repeat(4097) }, false],
    [{ ...text, startOffset: 1.5 }, false], [{ ...text, startOffset: -1 }, false], [{ ...text, startOffset: 1_000_001 }, false],
    [{ ...text, endOffset: 0.5 }, false], [{ ...text, endOffset: -1 }, false], [{ ...text, endOffset: 1_000_001 }, false],
  ])("validAnchor(%j) is %s", (value, expected) => expect(validAnchor(value)).toBe(expected));
  it.each([
    ["thread.create", { body: "  hello  ", anchor }, { body: "hello", anchor }],
    ["thread.create", { body: "hi", anchor, clientOperationId: "op" }, { clientOperationId: "op", body: "hi", anchor }],
    ["thread.create", { body: "   ", anchor }, null], ["thread.create", { body: "x".repeat(10_001), anchor }, null], ["thread.create", { body: 4, anchor }, null],
    ["thread.create", { body: "hi", anchor: { kind: "element", path: [] } }, null],
    ["reply.add", { threadId: "t", body: " hi " }, { threadId: "t", body: "hi" }], ["reply.add", { threadId: "t", body: " " }, null], ["reply.add", { body: "hi" }, null], ["reply.add", { threadId: "", body: "hi" }, null],
    ["reply.remove", { threadId: "t", replyId: "r" }, { threadId: "t", replyId: "r" }], ["reply.remove", { threadId: "t" }, null], ["reply.remove", { threadId: "t", replyId: "" }, null],
    ["thread.resolve", { threadId: "t" }, { threadId: "t" }], ["thread.resolve", { threadId: "t", resolved: true }, { threadId: "t", resolved: true }],
    ["thread.resolve", { threadId: "t", resolved: "yes" }, null], ["thread.resolve", { threadId: "t", clientOperationId: "op" }, null],
    ["thread.archive", { threadId: "t", archived: false, clientOperationId: "op" }, { clientOperationId: "op", threadId: "t", archived: false }], ["thread.archive", { threadId: "t" }, { threadId: "t" }],
    ["thread.remove", { threadId: "t", clientOperationId: "op" }, { clientOperationId: "op", threadId: "t" }],
    ["thread.remove", { threadId: "t", clientOperationId: " " }, null], ["thread.remove", { threadId: "t", clientOperationId: 4 }, null], ["thread.remove", { threadId: "t", clientOperationId: "x".repeat(129) }, null],
    ["thread.remove", "not an object", null], ["thread.remove", [], null],
  ] as const)("normalizes %s %j", (method, value, expected) => expect(normalizeMutationArgs(method, value)).toEqual(expected));
});

describe("recovery state", () => {
  const key = "operations:user-a";
  function storage(initial?: unknown) {
    const store = new StorageWindow().sessionStorage;
    if (initial !== undefined) store.setItem(key, typeof initial === "string" ? initial : JSON.stringify(initial));
    return store;
  }
  it.each([
    ["not JSON", "{"], ["another user's", { userId: "user-b", operations: {}, drafts: {} }], ["no operations", { userId: "user-a", drafts: {} }], ["no drafts", { userId: "user-a", operations: {} }],
    ["array operations", { userId: "user-a", operations: [], drafts: {} }], ["array drafts", { userId: "user-a", operations: {}, drafts: [] }], ["scalar operations", { userId: "user-a", operations: 3, drafts: {} }],
    ["scalar drafts", { userId: "user-a", operations: {}, drafts: "x" }],
  ])("discards %s saved state", (_name, saved) => {
    const store = storage(saved);
    const state = new CommentOperationState(store, key, "user-a");
    expect(state.value).toEqual({ operations: {}, drafts: {} });
    expect(store.getItem(key)).toBeNull();
  });
  it("restores its own state and persists operations and drafts for threads and replies", () => {
    const saved = { userId: "user-a", operations: {}, drafts: { create: { body: "x" } } };
    const store = storage(saved);
    const state = new CommentOperationState(store, key, "user-a");
    expect(state.value.drafts.create).toEqual({ body: "x" });
    const reply = state.prepare("reply.add", { threadId: "t1", body: "hello" });
    expect(state.value.drafts.t1).toEqual({ threadId: "t1", body: "hello" });
    expect(state.prepare("reply.add", { threadId: "t1", body: "hello" })).toBe(reply);
    expect(() => state.prepare("reply.add", { threadId: "t1", body: "changed" })).toThrow(CommentOperationConflictError);
    const thread = state.prepare("thread.create", { body: "new", anchor: {}, clientOperationId: "given" });
    expect(thread.clientOperationId).toBe("given");
    state.complete(mutationKey("reply.add", { threadId: "t1" }), "someone-else");
    state.complete(mutationKey("reply.add", { threadId: "t1" }), reply.clientOperationId);
    expect(state.value.drafts.t1).toBeUndefined();
    // An edited draft survives the completion of the earlier submission.
    const second = state.prepare("reply.add", { threadId: "t2", body: "first" });
    state.draft("t2", { body: "edited" });
    state.complete(mutationKey("reply.add", { threadId: "t2" }), second.clientOperationId);
    expect(state.value.drafts.t2).toEqual({ body: "edited" });
    const removal = state.prepare("thread.remove", { threadId: "t3" });
    state.reject(mutationKey("thread.remove", { threadId: "t3" }), "other");
    expect(state.value.operations[mutationKey("thread.remove", { threadId: "t3" })]).toBe(removal);
    state.reject(mutationKey("thread.remove", { threadId: "t3" }), removal.clientOperationId);
    state.complete(mutationKey("thread.create"), "missing");
    state.draft("t4", { body: "" });
    expect(JSON.parse(store.getItem(key)!).userId).toBe("user-a");
    expect(Object.keys(state.value.drafts)).not.toContain("t4");
  });
  it("keys removals by thread and reply, tolerating missing identifiers", () => {
    expect(mutationKey("reply.remove", { threadId: "t" })).toBe(JSON.stringify(["reply.remove", "t", null]));
    expect(mutationKey("reply.remove", { threadId: "t", replyId: "r" })).toBe(JSON.stringify(["reply.remove", "t", "r"]));
    expect(mutationKey("thread.remove")).toBe(JSON.stringify(["thread.remove", null, null]));
    expect(mutationKey("thread.create", { threadId: "ignored" })).toBe(JSON.stringify(["thread.create", null, null]));
  });
  it("works without storage", () => {
    const state = new CommentOperationState();
    state.prepare("thread.remove", { threadId: "t" });
    state.draft("t", { body: "x" });
    expect(Object.keys(state.value.operations)).toHaveLength(1);
  });
});

describe("pending deletions", () => {
  it("commits after the delay, reports failures and lets the owner undo or acknowledge", async () => {
    vi.useFakeTimers();
    const coordinator = new PendingDeletionCoordinator<string>();
    const commit = vi.fn().mockResolvedValue(undefined);
    const failure = vi.fn();
    expect(coordinator.begin("a", 100, commit, failure)).toBe(true);
    expect(coordinator.begin("a", 100, commit, failure)).toBe(false);
    expect([...coordinator.keys()]).toEqual(["a"]);
    expect(coordinator.undo("missing")).toBe("missing");
    expect(coordinator.undo("a")).toBe("undone");
    expect(coordinator.has("a")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(commit).not.toHaveBeenCalled();
    coordinator.acknowledge("missing");
    coordinator.begin("b", 100, commit, failure);
    coordinator.acknowledge("b");
    await vi.advanceTimersByTimeAsync(200);
    expect(commit).not.toHaveBeenCalled();
    // A deletion already committing can no longer be undone, and succeeds quietly.
    coordinator.begin("c", 100, commit, failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(coordinator.undo("c")).toBe("committing");
    coordinator.acknowledge("c");
    // A failed commit frees the key; one that was acknowledged and restarted does not disturb its successor.
    coordinator.begin("d", 100, () => Promise.reject(new Error("no")), failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(coordinator.has("d")).toBe(false);
    let reject!: (error: Error) => void;
    coordinator.begin("e", 100, () => new Promise((_resolve, fail) => { reject = fail; }), failure);
    await vi.advanceTimersByTimeAsync(100);
    coordinator.acknowledge("e");
    coordinator.begin("e", 100, commit, failure);
    reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toHaveBeenCalledTimes(2);
    expect(coordinator.has("e")).toBe(true);
  });
});

describe("parent transport edge cases", () => {
  function connect(subscribed = true) {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const listeners = new Set<(event: MessageEvent) => void>();
    const parent = { postMessage: vi.fn() };
    const transport = new ParentCommentTransport(parent, {
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener as never),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener as never),
    }, "guide.html");
    const errors: Error[] = [];
    if (subscribed) transport.subscribe(vi.fn(), vi.fn(), error => errors.push(error));
    const send = (data: unknown) => { for (const listener of [...listeners]) listener({ source: parent, data } as MessageEvent); };
    const ready = (extra: Record<string, unknown> = {}) => send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "g1", ...extra });
    const sent = (method: string) => parent.postMessage.mock.calls.map(([message]) => message).filter(message => message.method === method);
    return { transport, parent, errors, send, ready, sent };
  }

  it("rejects missing arguments, reports no pending work for them and ignores a reload request without the capability", async () => {
    const { transport, ready, parent } = connect();
    ready();
    await expect(transport.mutate("thread.remove", undefined)).rejects.toBeInstanceOf(CommentMutationRejectedError);
    expect(transport.isMutationPending("thread.remove", null)).toBe(false);
    expect(transport.isMutationPending("thread.remove")).toBe(false);
    parent.postMessage.mockClear();
    transport.requestViewerReload();
    expect(parent.postMessage).not.toHaveBeenCalled();
    ready({ canReloadViewer: true, parentGeneration: "g1" });
    transport.requestViewerReload();
    expect(parent.postMessage).toHaveBeenCalledWith({ type: COMMENTOR_VIEWER_RELOAD }, "*");
  });

  it("reports an unsaved draft, tolerates a failed completion and keeps a pending write without a slow-write handler", async () => {
    const { transport, ready, send, sent, errors } = connect();
    ready({ recoveryState: { operations: { [mutationKey("thread.create")]: { method: "thread.create", args: { body: "x", anchor: {} }, clientOperationId: "op1" } }, drafts: {} } });
    const fail = (method: string, error?: string) => send({ type: COMMENTOR_PARENT_RESPONSE, requestId: sent(method).at(-1).requestId, ok: false, ...(error ? { error } : {}) });
    transport.saveDraft("create", { body: "draft" });
    fail("draft.save");
    await vi.advanceTimersByTimeAsync(0);
    expect(errors.map(error => error.message)).toEqual(["Comment draft could not be saved"]);
    send({ type: COMMENTOR_PARENT_UPDATE, threads: [{ _id: "t", clientOperationId: "op1", replies: "none" }], canLoadMore: false, loading: false });
    fail("operation.complete", "Comment recovery state could not be saved");
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.recovery.value.operations).toEqual({});
    const write = transport.mutate("reply.add", { threadId: "t", body: "slow" });
    await vi.advanceTimersByTimeAsync(60_001);
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: sent("reply.add")[0].requestId, ok: true });
    await expect(write).resolves.toBeUndefined();
  });

  it("falls back to generic wording for empty parent errors and failures", async () => {
    const { transport, ready, send, sent, errors } = connect();
    ready();
    send({ type: COMMENTOR_PARENT_ERROR, error: "" });
    expect(errors.map(error => error.message)).toEqual(["Comments could not be loaded"]);
    const rejected = transport.mutate("thread.remove", { threadId: "t" });
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: sent("thread.remove")[0].requestId, ok: false, rejected: true });
    await expect(rejected).rejects.toThrow(new CommentMutationRejectedError("Comment operation failed"));
    const plain = transport.mutate("thread.archive", { threadId: "t", archived: true });
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: sent("thread.archive")[0].requestId, ok: false });
    await expect(plain).rejects.toThrow("Comment operation failed");
    await expect(plain).rejects.not.toBeInstanceOf(CommentMutationRejectedError);
  });

  it("loads older replies through the parent and rejects before the parent has announced itself", async () => {
    const { transport, ready, send, sent } = connect();
    await expect(transport.loadMoreReplies("t")).rejects.toThrow("Comments were updated");
    ready();
    const more = transport.loadMoreReplies("t");
    expect(sent("replies.more")[0].args).toEqual({ threadId: "t" });
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: sent("replies.more")[0].requestId, ok: true });
    await expect(more).resolves.toBeUndefined();
    const timeout = transport.loadMoreThreads();
    const settled = expect(timeout).rejects.toThrow("taking longer to load");
    await vi.advanceTimersByTimeAsync(10_001);
    await settled;
  });
});
