import { ConvexError } from "convex/values";
import { api } from "../convex/_generated/api";
import { fixture } from "./helpers/comment-fixture";
import { Window as StorageWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentorParentHost, type DocumentCommentBackend } from "../src/commentor/parent-host";
import { COMMENTOR_VIEWER_RELOAD, COMMENTOR_PARENT_READY, COMMENTOR_PARENT_RESPONSE, COMMENTOR_PARENT_REQUEST } from "../src/commentor/parent-protocol";
import { CommentMutationOutcomeUnknownError, ParentCommentTransport } from "../src/commentor/parent-transport";

function recoveryRuntime(scope = { organizationId: "org-a", projectId: "project-a" as string, documentPath: "guide.html" }, principal = "user-a", legacy = false) {
  vi.useFakeTimers();
  const hostListeners = new Set<EventListener>();
  const childListeners = new Set<EventListener>();
  const events = (listeners: Set<EventListener>) => ({
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
  });
  vi.stubGlobal("window", { sessionStorage: new StorageWindow().sessionStorage, ...events(hostListeners), setTimeout, clearTimeout });
  const deliver = (listeners: Set<EventListener>, source: unknown, data: unknown) => {
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener({ source, data } as MessageEvent);
    });
  };
  const parent = { postMessage: vi.fn((data: unknown) => deliver(hostListeners, child, data)) };
  const child = { postMessage: vi.fn((data: unknown) => deliver(childListeners, parent, data)) };
  let frameLoad!: () => void;
  const frame = {
    src: legacy ? `https://rendro.test/legacy-view/example/files/${scope.documentPath}` : `https://rendro.test/organizations/${scope.organizationId}/projects/${scope.projectId}/docs/files/${scope.documentPath}`,
    contentWindow: child,
    addEventListener: (_type: string, listener: () => void) => { frameLoad = listener; },
    removeEventListener: vi.fn(),
  } as unknown as HTMLIFrameElement;
  let finish!: () => void;
  let fail!: () => void;
  let publish!: Parameters<DocumentCommentBackend["subscribe"]>[1];
  const unsubscribes: ReturnType<typeof vi.fn>[] = [];
  const backend = {
    subscribe: vi.fn((_scope, onUpdate) => {
      publish = onUpdate;
      onUpdate([{ _id: "thread-1", resolved: false }], { canLoadMore: false, loading: false });
      const unsubscribe = vi.fn();
      unsubscribes.push(unsubscribe);
      return { unsubscribe, loadMore: () => false };
    }),
    subscribeReplies: vi.fn(),
    mutate: vi.fn<DocumentCommentBackend["mutate"]>(() => new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = () => reject(new Error("backend rejected"));
    })),
  } satisfies DocumentCommentBackend;
  const createHost = (userId = principal) => new CommentorParentHost(frame, "https://rendro.test", legacy ? { orgSlug: "example", convexUrl: "https://convex.test" } : {
    organizationId: scope.organizationId, projectId: scope.projectId as never, convexUrl: "https://convex.test",
  }, backend, userId);
  const transport = new ParentCommentTransport(parent, events(childListeners) as never, "guide.html");
  const dismissSlow = vi.fn();
  const slow = vi.fn(() => dismissSlow);
  const update = vi.fn();
  transport.subscribe(update, vi.fn(), vi.fn(), slow);
  const host = createHost();
  host.start(true);
  return {
    host, createHost, transport, backend, parent, child, slow, dismissSlow, update, unsubscribes, frame,
    foreignMessage: (data: unknown) => deliver(hostListeners, {}, data),
    reload: () => {
      transport.dispose();
      const next = new ParentCommentTransport(parent, events(childListeners) as never, scope.documentPath);
      next.subscribe(update, vi.fn(), vi.fn(), slow);
      frameLoad();
      return next;
    },
    finish: () => finish(), fail: () => fail(),
    publishRows: (rows: unknown[]) => publish(rows, { canLoadMore: false, loading: false }),
    publish: () => publish([{ _id: "thread-1", resolved: true }], { canLoadMore: false, loading: false }),
  };
}

// Flush both directions of the asynchronous postMessage bridge and promise handlers.
async function flushMessages() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const methods = ["thread.create", "thread.resolve", "thread.archive", "thread.remove", "reply.add", "reply.remove"] as const;
const args = { resolved: true, archived: true, threadId: "thread-1", replyId: "reply-1", body: "Pending write", anchor: { kind: "element", path: ["main"] } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("comment recovery across parent subscriptions and generations", () => {
  it.each(methods)("refresh keeps one uncommitted %s and reconciles its late acknowledgement", async (method) => {
    const runtime = recoveryRuntime();
    const { host, transport, backend, child, slow, dismissSlow, update } = runtime;
    await flushMessages();
    const settled = vi.fn();
    const operation = transport.mutate(method, args);
    void operation.then(settled);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(slow).toHaveBeenCalledTimes(1);
    const stalePublish = update.mock.calls.length;
    await transport.refresh();
    await transport.refresh();
    // Repeated READY within the same host also only refreshes subscriptions.
    const ready = child.postMessage.mock.calls.map(([data]) => data)
      .find((data) => (data as { type: string }).type === COMMENTOR_PARENT_READY);
    child.postMessage(ready);
    await flushMessages();
    expect(update.mock.calls.length).toBeGreaterThan(stalePublish);
    expect(settled).not.toHaveBeenCalled();
    expect(transport.isMutationPending(method, args)).toBe(true);
    expect(transport.mutate(method, args)).toBe(operation);
    await flushMessages();
    expect(backend.mutate).toHaveBeenCalledTimes(1);
    runtime.publish();
    runtime.finish();
    await operation;
    await flushMessages();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(dismissSlow).toHaveBeenCalledTimes(1);
    expect(transport.isMutationPending(method, args)).toBe(false);
    expect(update).toHaveBeenLastCalledWith([{ _id: "thread-1", resolved: true }], false, false);
    expect(runtime.unsubscribes.slice(0, -1).every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
    transport.dispose();
    host.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers an explicit late rejection after refreshing", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    const result = runtime.transport.mutate("thread.resolve", args).catch((error: Error) => error.message);
    await runtime.transport.refresh();
    runtime.fail();
    expect(await result).toBe("Comment operation failed");
    expect(runtime.transport.isMutationPending("thread.resolve", args)).toBe(false);
    runtime.transport.dispose();
    runtime.host.dispose();
  });

  it.each(methods)("retires orphaned %s after host dispose/recreate without replaying it", async (method) => {
    const runtime = recoveryRuntime();
    const { host, transport, backend, child, dismissSlow } = runtime;
    await flushMessages();
    const result = transport.mutate(method, args).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_001);
    host.dispose();
    const replacement = runtime.createHost();
    replacement.start(true);
    await flushMessages();
    const error = await result;
    expect(error).toBeInstanceOf(CommentMutationOutcomeUnknownError);
    expect((error as Error).message).toContain("outcome is unknown");
    expect(dismissSlow).toHaveBeenCalledTimes(1);
    expect(transport.isMutationPending(method, args)).toBe(false);
    expect((transport as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
    expect(backend.mutate).toHaveBeenCalledTimes(1);
    const responseCount = () => child.postMessage.mock.calls
      .filter(([data]) => (data as { type: string }).type === COMMENTOR_PARENT_RESPONSE).length;
    const beforeLateResult = responseCount();
    runtime.finish();
    await flushMessages();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(responseCount()).toBe(beforeLateResult);
    expect(backend.mutate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    transport.dispose();
    replacement.dispose();
  });
});


describe("durable retries through the parent bridge and real Convex mutations", () => {
  it.each(methods.flatMap((method) => ["replace host", "reload iframe"].map((recovery) => ({ method, recovery }))))(
    "$method: $recovery before commit, then resubmit, has one backend effect",
    async ({ method, recovery }) => {
      const { backend: convex, viewers, scope, data } = await fixture();
      const threadId = await viewers.author.mutation(api.documentThreads.create, {
        ...scope, body: "Original", anchor: { kind: "element", path: ["main"] }, clientOperationId: "original-thread",
      });
      const replyId = await viewers.author.mutation(api.documentReplies.add, { ...scope, threadId, body: "Original reply", clientOperationId: "original-reply" });
      const runtime = recoveryRuntime(scope, String(data.users.find((user) => user.name === "author")!.userId));
      runtime.backend.subscribe.mockImplementation((_scope, onUpdate) => {
        onUpdate([{ _id: threadId, resolved: false, archived: false }], { canLoadMore: false, loading: false });
        return { unsubscribe: vi.fn(), loadMore: () => false };
      });
      const gates: Array<() => void> = [];
      const completed: Promise<unknown>[] = [];
      const functions = {
        "thread.create": api.documentThreads.create, "thread.resolve": api.documentThreads.resolve,
        "thread.archive": api.documentThreads.archive, "thread.remove": api.documentThreads.remove,
        "reply.add": api.documentReplies.add, "reply.remove": api.documentReplies.remove,
      };
      runtime.backend.mutate.mockImplementation((method, scope, args) => {
        const gate = new Promise<void>((resolve) => gates.push(resolve));
        const result = gate.then(() => viewers.author.mutation(functions[method], { ...scope, ...args as object } as never));
        completed.push(result);
        return result;
      });
      await flushMessages();
      let transport = runtime.transport;
      const action = { threadId, replyId, body: "Pending write", anchor: { kind: "element", path: ["main"] }, resolved: true, archived: true };
      const first = transport.mutate(method, action).catch((error: Error) => error);
      await flushMessages();
      const firstId = (runtime.backend.mutate.mock.calls[0][2] as { clientOperationId: string }).clientOperationId;
      expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
      let host = runtime.host;
      if (recovery === "replace host") {
        host.dispose();
        host = runtime.createHost();
        host.start(true);
      } else transport = runtime.reload();
      await flushMessages();
      expect(await first).toBeInstanceOf(Error);
      expect(runtime.backend.mutate).toHaveBeenCalledTimes(1);
      if (method === "thread.create") expect(transport.recovery.value.drafts.create.body).toBe(action.body);
      if (method === "reply.add") expect(transport.recovery.value.drafts[threadId].body).toBe(action.body);
      const retry = transport.mutate(method, action);
      await flushMessages();
      expect(runtime.backend.mutate).toHaveBeenCalledTimes(2);
      expect((runtime.backend.mutate.mock.calls[1][2] as { clientOperationId: string }).clientOperationId).toBe(firstId);
      // Commit the retry first, then the abandoned original request.
      gates[1]();
      await completed[1];
      await flushMessages();
      await retry;
      if (method === "thread.resolve") await viewers.member.mutation(api.documentThreads.resolve, { ...scope, threadId, resolved: false, clientOperationId: "newer-reopen" });
      if (method === "thread.archive") await viewers.admin.mutation(api.documentThreads.archive, { ...scope, threadId, archived: false, clientOperationId: "newer-unarchive" });
      gates[0]();
      await completed[0];
      await flushMessages();
      const threads = await convex.run((ctx) => ctx.db.query("documentThreads").collect());
      const replies = await convex.run((ctx) => ctx.db.query("documentReplies").collect());
      if (method === "thread.create") expect(threads.filter((row) => row.clientOperationId === firstId)).toHaveLength(1);
      if (method === "reply.add") expect(replies.filter((row) => row.clientOperationId === firstId)).toHaveLength(1);
      if (method === "thread.resolve") expect(threads.find((row) => row._id === threadId)?.resolved).toBe(false);
      if (method === "thread.archive") expect(threads.find((row) => row._id === threadId)?.archived).toBe(false);
      if (method === "thread.remove") expect(threads.find((row) => row._id === threadId)?.deletedAt).toEqual(expect.any(Number));
      if (method === "reply.remove") expect(replies.find((row) => row._id === replyId)?.deletedAt).toEqual(expect.any(Number));
      expect(Object.keys(transport.recovery.value.operations)).toHaveLength(0);
      if (method === "thread.remove") await convex.finishAllScheduledFunctions(() => vi.runAllTimers());
      transport.dispose();
      host.dispose();
    },
  );
});


describe("durable parent storage", () => {
  it.each(["thread.create", "reply.add"] as const)("an abandoned %s acknowledgement cannot erase the ID before a subsequent iframe reload", async (method) => {
    const runtime = recoveryRuntime();
    await flushMessages();
    const pending = runtime.transport.mutate(method, args).catch((error: Error) => error);
    await flushMessages();
    const original = runtime.backend.mutate.mock.calls[0][2] as { clientOperationId: string };
    runtime.host.dispose();
    const replacement = runtime.createHost();
    replacement.start(true);
    await flushMessages();
    await pending;
    runtime.finish();
    await flushMessages();
    runtime.transport.saveDraft(method === "thread.create" ? "create" : "thread-1", args);
    await flushMessages();
    const next = runtime.reload();
    await flushMessages();
    const retry = next.mutate(method, args).catch((error: Error) => error);
    await flushMessages();
    expect((runtime.backend.mutate.mock.calls[1][2] as { clientOperationId: string }).clientOperationId).toBe(original.clientOperationId);
    next.dispose();
    await retry;
    replacement.dispose();
  });

  it("does not dispatch a backend write when durable storage fails", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => { throw new Error("Storage full"); });
    await expect(runtime.transport.mutate("thread.create", args)).rejects.toThrow("recovery state could not be saved");
    expect(runtime.backend.mutate).not.toHaveBeenCalled();
    runtime.transport.dispose();
    runtime.host.dispose();
  });

  it.each(["thread.create", "reply.add"] as const)("subscription confirmation clears the stored %s draft and ID before an iframe reload", async (method) => {
    const runtime = recoveryRuntime();
    await flushMessages();
    const pending = runtime.transport.mutate(method, args).catch((error: Error) => error);
    await flushMessages();
    const sent = runtime.backend.mutate.mock.calls[0][2] as { clientOperationId: string };
    const row = { _id: "result", clientOperationId: sent.clientOperationId };
    runtime.publishRows(method === "thread.create" ? [row] : [{ _id: "thread-1", replies: [row] }]);
    await flushMessages();
    expect(runtime.transport.recovery.value).toEqual({ operations: {}, drafts: {} });
    const next = runtime.reload();
    await flushMessages();
    await pending;
    expect(next.recovery.value).toEqual({ operations: {}, drafts: {} });
    // A deliberately new action now gets a new identity.
    const newAction = next.mutate(method, args).catch((error: Error) => error);
    await flushMessages();
    expect((runtime.backend.mutate.mock.calls[1][2] as { clientOperationId: string }).clientOperationId).not.toBe(sent.clientOperationId);
    next.dispose();
    await newAction;
    runtime.host.dispose();
  });

  it("persists unsent drafts in the parent across iframe reload", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    runtime.transport.saveDraft("create", { body: "Unsent comment", anchor: args.anchor });
    runtime.transport.saveDraft("thread-1", { body: "Unsent reply" });
    await flushMessages();
    const next = runtime.reload();
    await flushMessages();
    expect(next.recovery.value.drafts).toMatchObject({ create: { body: "Unsent comment" }, "thread-1": { body: "Unsent reply" } });
    expect(runtime.backend.mutate).not.toHaveBeenCalled();
    next.dispose();
    runtime.host.dispose();
  });
});


describe("round-three recovery regressions", () => {
  it("does not hydrate another account's drafts or unresolved writes in the same tab", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    runtime.transport.saveDraft("create", { body: "A's private draft", anchor: args.anchor });
    const pending = runtime.transport.mutate("reply.add", args).catch(() => {});
    await flushMessages();
    runtime.host.dispose();
    const nextHost = runtime.createHost("user-b");
    nextHost.start(true);
    await flushMessages();
    await pending;
    expect(runtime.transport.recovery.value).toEqual({ drafts: {}, operations: {} });
    const values = Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.getItem(window.sessionStorage.key(i)!));
    expect(JSON.stringify(values)).not.toContain("private draft");
    expect(JSON.stringify(values)).not.toContain("Pending write");
    runtime.transport.dispose();
    nextHost.dispose();
  });

  it("sign-out clears all stored recovery and in-memory operations", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    runtime.transport.saveDraft("create", { body: "Secret", anchor: args.anchor });
    const pending = runtime.transport.mutate("reply.add", args).catch(() => {});
    await flushMessages();
    runtime.host.setUserId(null);
    await flushMessages();
    await pending;
    expect(window.sessionStorage.length).toBe(0);
    expect(runtime.transport.recovery.value).toEqual({ drafts: {}, operations: {} });
    const backendCalls = runtime.backend.mutate.mock.calls.length;
    await expect(runtime.transport.mutate("thread.create", args)).rejects.toThrow("scope is unavailable");
    expect(runtime.backend.mutate).toHaveBeenCalledTimes(backendCalls);
    runtime.transport.dispose();
    runtime.host.dispose();
  });

  it.each(["thread.resolve", "thread.archive"] as const)("a matching subscription boolean does not retire an unconfirmed %s ID", async (method) => {
    const runtime = recoveryRuntime();
    await flushMessages();
    const pending = runtime.transport.mutate(method, args).catch(() => {});
    await flushMessages();
    runtime.publishRows([{ _id: "thread-1", resolved: true, archived: true }]);
    await flushMessages();
    expect(Object.values(runtime.transport.recovery.value.operations)).toHaveLength(1);
    const next = runtime.reload();
    await flushMessages();
    await pending;
    expect(Object.values(next.recovery.value.operations)).toHaveLength(1);
    next.dispose();
    runtime.host.dispose();
  });

  it.each(["thread.create", "reply.add"] as const)("validates %s before preparing it, allowing an edited submission", async (method) => {
    const runtime = recoveryRuntime();
    await flushMessages();
    await expect(runtime.transport.mutate(method, { ...args, body: "x".repeat(10_001) })).rejects.toThrow("invalid");
    expect(runtime.backend.mutate).not.toHaveBeenCalled();
    expect(runtime.transport.recovery.value.operations).toEqual({});
    const corrected = runtime.transport.mutate(method, { ...args, body: "Corrected" });
    await flushMessages();
    expect(runtime.backend.mutate).toHaveBeenCalledTimes(1);
    runtime.finish();
    await corrected;
    runtime.transport.dispose();
    runtime.host.dispose();
  });

  describe.each([false, true])("legacy=%s error recovery", legacy => {
    it.each((["thread.create", "reply.add"] as const).flatMap(method => [
      ...[
        ["invalid_id", "This comment is unavailable"],
        ["not_found", "This comment is unavailable"],
        ["forbidden", "You do not have permission"],
        ["unauthenticated", "Sign in again"],
        ["invalid_input", "Check your comment"],
        ["conflict", "This comment operation changed"],
      ].map(([code, message]) => ({ method, data: { code, message: "private diagnostic must not reach the widget" }, message })),
    ]))("retires a definitively rejected $method identity for $data but keeps its editable draft", async ({ method, data, message }) => {
      const runtime = recoveryRuntime(undefined, undefined, legacy);
      await flushMessages();
      runtime.backend.mutate.mockRejectedValueOnce(new ConvexError(data));
      await expect(runtime.transport.mutate(method, args)).rejects.toThrow(message);
      const originalId = (runtime.backend.mutate.mock.calls[0][2] as { clientOperationId: string }).clientOperationId;
      expect(runtime.transport.recovery.value.operations).toEqual({});
      expect(Object.values(runtime.transport.recovery.value.drafts)[0].body).toBe(args.body);
      const next = runtime.reload();
      await flushMessages();
      expect(next.recovery.value.operations).toEqual({});
      const corrected = next.mutate(method, { ...args, body: "Edited" });
      await flushMessages();
      expect((runtime.backend.mutate.mock.calls[1][2] as { clientOperationId: string }).clientOperationId).not.toBe(originalId);
      runtime.finish();
      await corrected;
      next.dispose();
      runtime.host.dispose();
    });

    it.each((["thread.create", "reply.add"] as const).flatMap(method => [
      "unknown_code", "transient", "rate_limited", "legacy",
    ].map(code => ({ method, code }))))("preserves $method identity across reload and retry for $code", async ({ method, code }) => {
      const runtime = recoveryRuntime(undefined, undefined, legacy);
      await flushMessages();
      runtime.backend.mutate.mockRejectedValueOnce(new ConvexError(
        code === "legacy" ? "Permission denied" : { code, message: "Safe failure" },
      ));
      await expect(runtime.transport.mutate(method, args)).rejects.toThrow("Comment operation failed");
      const original = runtime.backend.mutate.mock.calls[0][2];
      expect(Object.keys(runtime.transport.recovery.value.operations)).toHaveLength(1);
      const next = runtime.reload();
      await flushMessages();
      expect(Object.keys(next.recovery.value.operations)).toHaveLength(1);
      await expect(next.mutate(method, { ...args, body: "Changed" })).rejects.toThrow("unconfirmed");
      const retry = next.mutate(method, args);
      await flushMessages();
      expect(runtime.backend.mutate.mock.calls[1][2]).toEqual(original);
      runtime.finish();
      await retry;
      expect(next.recovery.value.operations).toEqual({});
      next.dispose();
      runtime.host.dispose();
    });

  });

  it("keeps the identity and original payload when the backend outcome is unknown", async () => {
    const runtime = recoveryRuntime();
    await flushMessages();
    const failed = runtime.transport.mutate("thread.create", args).catch(() => {});
    await flushMessages();
    runtime.fail();
    await failed;
    await expect(runtime.transport.mutate("thread.create", { ...args, body: "Changed" })).rejects.toThrow("unconfirmed");
    const retry = runtime.transport.mutate("thread.create", args);
    await flushMessages();
    expect(runtime.backend.mutate.mock.calls[1][2]).toEqual(runtime.backend.mutate.mock.calls[0][2]);
    runtime.finish();
    await retry;
    runtime.transport.dispose();
    runtime.host.dispose();
  });
});


describe("old widget through new parent and Convex", () => {
  it.each(["resolved", "archived"] as const)("preserves the absent-target %s toggle", async (field) => {
    const { viewers, scope, threadId, data } = await fixture();
    const runtime = recoveryRuntime(scope, String(data.users.find((user) => user.name === "author")!.userId));
    const fn = field === "resolved" ? api.documentThreads.resolve : api.documentThreads.archive;
    runtime.backend.subscribe.mockImplementation((_scope, update) => {
      update([{ _id: threadId, resolved: true, archived: true }], { canLoadMore: false, loading: false });
      return { unsubscribe: vi.fn(), loadMore: () => false };
    });
    const results: Promise<unknown>[] = [];
    runtime.backend.mutate.mockImplementation((_method, scope, args) => {
      expect(args).not.toHaveProperty(field);
      expect((args as { clientOperationId?: string }).clientOperationId).toBeUndefined();
      if ("orgSlug" in scope) throw new Error("Expected project fixture scope");
      const result = viewers.author.mutation(fn, { ...scope, threadId, ...args as object });
      results.push(result);
      return result;
    });
    await viewers.author.mutation(fn, { ...scope, threadId, [field]: true });
    await flushMessages();
    for (const target of [false, true]) {
      runtime.parent.postMessage({ type: COMMENTOR_PARENT_REQUEST, requestId: String(target), method: field === "resolved" ? "thread.resolve" : "thread.archive", args: { threadId } });
      await flushMessages();
      expect(await results.at(-1)).toBe(target);
      await flushMessages();
    }
    runtime.transport.dispose();
    runtime.host.dispose();
  });
});


describe("viewer reload bridge", () => {
  it.each([false, true])("only offers one notice for the current scoped document (legacy=%s)", async legacy => {
    const runtime = recoveryRuntime(undefined, undefined, legacy);
    const reload = vi.fn();
    const dom = new StorageWindow();
    dom.document.body.innerHTML = '<aside id="viewer-update-notice" hidden><span role="status" aria-live="polite"></span><button>Reload</button></aside>';
    Object.assign(window, { location: { reload }, document: dom.document });
    const notice = dom.document.querySelector("aside")!;
    await flushMessages();
    runtime.foreignMessage({ type: COMMENTOR_VIEWER_RELOAD });
    await flushMessages();
    expect(notice.hidden).toBe(true);
    runtime.parent.postMessage({ type: COMMENTOR_VIEWER_RELOAD });
    await flushMessages();
    expect(notice.hidden).toBe(false);
    const announcement = notice.querySelector('[role="status"]')!.firstChild;
    for (let i = 0; i < 1_000; i++) runtime.parent.postMessage({ type: COMMENTOR_VIEWER_RELOAD, userActivation: true });
    await flushMessages();
    expect(notice.querySelector('[role="status"]')!.firstChild).toBe(announcement);
    expect(dom.document.querySelectorAll("#viewer-update-notice")).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    notice.hidden = true;
    runtime.frame.src = "https://rendro.test/organizations/org-a/projects/other/docs/files/guide.html";
    runtime.parent.postMessage({ type: COMMENTOR_VIEWER_RELOAD });
    await flushMessages();
    expect(notice.hidden).toBe(true);
    runtime.host.dispose();
    runtime.parent.postMessage({ type: COMMENTOR_VIEWER_RELOAD });
    await flushMessages();
    expect(notice.hidden).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    runtime.transport.dispose();
    await dom.happyDOM.close();
  });
});
