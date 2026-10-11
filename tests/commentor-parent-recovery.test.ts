import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentorParentHost, type DocumentCommentBackend } from "../src/commentor/parent-host";
import { COMMENTOR_PARENT_READY, COMMENTOR_PARENT_RESPONSE } from "../src/commentor/parent-protocol";
import { CommentMutationOutcomeUnknownError, ParentCommentTransport } from "../src/commentor/parent-transport";

function recoveryRuntime() {
  vi.useFakeTimers();
  const hostListeners = new Set<EventListener>();
  const childListeners = new Set<EventListener>();
  const events = (listeners: Set<EventListener>) => ({
    addEventListener: (_type: string, listener: EventListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: EventListener) => listeners.delete(listener),
  });
  vi.stubGlobal("window", { ...events(hostListeners), setTimeout, clearTimeout });
  const deliver = (listeners: Set<EventListener>, source: unknown, data: unknown) => {
    void Promise.resolve().then(() => {
      for (const listener of listeners) listener({ source, data } as MessageEvent);
    });
  };
  const parent = { postMessage: vi.fn((data: unknown) => deliver(hostListeners, child, data)) };
  const child = { postMessage: vi.fn((data: unknown) => deliver(childListeners, parent, data)) };
  const frame = {
    src: "https://rendro.test/organizations/org-a/projects/project-a/docs/files/guide.html",
    contentWindow: child,
    addEventListener: vi.fn(),
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
    mutate: vi.fn(() => new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = () => reject(new Error("backend rejected"));
    })),
  } satisfies DocumentCommentBackend;
  const createHost = () => new CommentorParentHost(frame, "https://rendro.test", {
    organizationId: "org-a", projectId: "project-a" as never, convexUrl: "https://convex.test",
  }, backend);
  const transport = new ParentCommentTransport(parent, events(childListeners) as never, "guide.html");
  const dismissSlow = vi.fn();
  const slow = vi.fn(() => dismissSlow);
  const update = vi.fn();
  transport.subscribe(update, vi.fn(), vi.fn(), slow);
  const host = createHost();
  host.start(true);
  return {
    host, createHost, transport, backend, parent, child, slow, dismissSlow, update, unsubscribes,
    finish: () => finish(), fail: () => fail(),
    publish: () => publish([{ _id: "thread-1", resolved: true }], { canLoadMore: false, loading: false }),
  };
}

// Flush both directions of the asynchronous postMessage bridge and promise handlers.
async function flushMessages() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

const methods = ["thread.create", "thread.resolve", "thread.archive", "thread.remove", "reply.add"] as const;
const args = { threadId: "thread-1", body: "Pending write", anchor: { kind: "element", path: ["main"] } };

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
