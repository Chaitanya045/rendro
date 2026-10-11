import { Window as StorageWindow } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommentorParentHost,
  documentCommentScopeFromFrame,
  type DocumentCommentBackend,
} from "../src/commentor/parent-host";
import {
  COMMENTOR_PARENT_ERROR,
  COMMENTOR_PARENT_READY,
  COMMENTOR_PARENT_REQUEST,
  COMMENTOR_PARENT_RESPONSE,
  COMMENTOR_PARENT_REPLIES_UPDATE,
  COMMENTOR_PARENT_UPDATE,
} from "../src/commentor/parent-protocol";
import { ParentCommentTransport } from "../src/commentor/parent-transport";

afterEach(() => vi.unstubAllGlobals());

describe("project comment parent transport", () => {
  it("derives its scope only from the trusted project frame URL", () => {
    const config = { organizationId: "org/a", projectId: "project-1" as never };
    expect(documentCommentScopeFromFrame(
      "https://rendro.test/organizations/org%2Fa/projects/project-1/docs/files/guide%2Fintro.html",
      "https://rendro.test",
      config,
    )).toEqual({ ...config, documentPath: "guide/intro.html" });
    expect(documentCommentScopeFromFrame("https://evil.test/files/guide.html", "https://rendro.test", config)).toBeNull();
    expect(documentCommentScopeFromFrame(
      "https://rendro.test/organizations/org%2Fa/projects/other/docs/files/guide.html",
      "https://rendro.test",
      config,
    )).toBeNull();
  });

  it("allowlists document operations and rejects stale or cross-document thread IDs", async () => {
    let messageHandler!: (event: MessageEvent) => void;
    let loadHandler!: () => void;
    vi.stubGlobal("window", { sessionStorage: new StorageWindow().sessionStorage,
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") messageHandler = listener;
      },
      removeEventListener: vi.fn(),
    });
    const postMessage = vi.fn();
    const source = { postMessage } as unknown as WindowProxy;
    const frame = {
      src: "https://rendro.test/organizations/org-a/projects/project-a/docs/files/guide.html",
      contentWindow: source,
      addEventListener: (type: string, listener: () => void) => { if (type === "load") loadHandler = listener; },
      removeEventListener: vi.fn(),
    } as unknown as HTMLIFrameElement;
    let publish!: Parameters<DocumentCommentBackend["subscribe"]>[1];
    let publishReplies!: Parameters<DocumentCommentBackend["subscribeReplies"]>[2];
    let fail!: (error: Error) => void;
    const unsubscribe = vi.fn();
    const loadMore = vi.fn(() => true);
    const subscribe = vi.fn<DocumentCommentBackend["subscribe"]>((_scope, onUpdate, onError) => {
      publish = onUpdate;
      fail = onError;
      return { unsubscribe, loadMore };
    });
    const replyUnsubscribe = vi.fn();
    const replyLoadMore = vi.fn(() => true);
    const subscribeReplies = vi.fn<DocumentCommentBackend["subscribeReplies"]>((_scope, _threadId, onUpdate) => {
      publishReplies = onUpdate;
      return { unsubscribe: replyUnsubscribe, loadMore: replyLoadMore };
    });
    const mutate = vi.fn().mockResolvedValue(undefined);
    const backend: DocumentCommentBackend = {
      subscribe,
      subscribeReplies,
      mutate,
    };
    const config = { organizationId: "org-a", projectId: "project-a" as never, convexUrl: "https://convex.test" };
    const host = new CommentorParentHost(frame, "https://rendro.test", config, backend);
    host.start();

    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "early", method: "subscribe", args: {} },
    } as MessageEvent);
    expect(subscribe).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "early", ok: false }),
      "*",
    );

    loadHandler();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: COMMENTOR_PARENT_READY, parentGeneration: expect.any(String) }), "*");
    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "sub", method: "subscribe", args: { documentPath: "guide.html", organizationId: "other" } },
    } as MessageEvent);
    expect(subscribe).toHaveBeenCalledWith(
      { organizationId: "org-a", projectId: "project-a", documentPath: "guide.html" },
      expect.any(Function),
      expect.any(Function),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: COMMENTOR_PARENT_RESPONSE, requestId: "sub", ok: true },
      "*",
    );

    publish([{ _id: "current-thread", body: "Visible" }], { canLoadMore: true, loading: false });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: COMMENTOR_PARENT_UPDATE,
        threads: [{ _id: "current-thread", body: "Visible" }],
        canLoadMore: true,
        loading: false,
      },
      "*",
    );

    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "threads-more", method: "threads.more", args: {} },
    } as MessageEvent);
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "threads-more", ok: true }), "*");

    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "replies-more", method: "replies.more", args: { threadId: "current-thread" } },
    } as MessageEvent);
    expect(subscribeReplies).toHaveBeenCalledWith(
      { organizationId: "org-a", projectId: "project-a", documentPath: "guide.html" },
      "current-thread",
      expect.any(Function),
      expect.any(Function),
    );
    publishReplies([{ _id: "older-reply" }], { canLoadMore: false, loading: false });
    expect(postMessage).toHaveBeenCalledWith({
      type: COMMENTOR_PARENT_REPLIES_UPDATE,
      threadId: "current-thread",
      replies: [{ _id: "older-reply" }],
      canLoadMore: false,
      loading: false,
    }, "*");

    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "foreign", method: "thread.remove", args: { threadId: "other-thread" } },
    } as MessageEvent);
    expect(mutate).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "foreign", ok: false }), "*");

    messageHandler({
      source,
      data: {
        type: COMMENTOR_PARENT_REQUEST,
        requestId: "create",
        method: "thread.create",
        args: {
          organizationId: "other",
          projectId: "other",
          documentPath: "other.html",
          body: "Scoped comment",
          anchor: { kind: "element", path: ["main"] },
        },
      },
    } as MessageEvent);
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledWith(
      "thread.create",
      { organizationId: "org-a", projectId: "project-a", documentPath: "guide.html" },
      { body: "Scoped comment", anchor: { kind: "element", path: ["main"] }, clientOperationId: expect.any(String) },
    );

    for (const args of [{ threadId: 42, replyId: "reply" }, { threadId: "current-thread" }]) {
      messageHandler({
        source,
        data: { type: COMMENTOR_PARENT_REQUEST, requestId: "invalid-reply-delete", method: "reply.remove", args },
      } as MessageEvent);
      expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "invalid-reply-delete", ok: false }), "*");
    }
    expect(mutate).toHaveBeenCalledTimes(1);
    messageHandler({
      source,
      data: {
        type: COMMENTOR_PARENT_REQUEST, requestId: "delete-reply", method: "reply.remove",
        args: { threadId: "current-thread", replyId: "older-reply", organizationId: "other", documentPath: "other.html" },
      },
    } as MessageEvent);
    await Promise.resolve();
    expect(mutate).toHaveBeenLastCalledWith(
      "reply.remove",
      { organizationId: "org-a", projectId: "project-a", documentPath: "guide.html" },
      { threadId: "current-thread", replyId: "older-reply", clientOperationId: expect.any(String) },
    );

    fail(new Error("backend details must not cross the boundary"));
    expect(postMessage).toHaveBeenCalledWith(
      { type: COMMENTOR_PARENT_ERROR, error: "Comments could not be loaded" },
      "*",
    );

    frame.src = "https://rendro.test/organizations/org-a/projects/project-a/docs/files/next.html";
    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "transition", method: "subscribe", args: {} },
    } as MessageEvent);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "transition", ok: false }), "*");
    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "transition-mutation", method: "thread.resolve", args: { threadId: "current-thread" } },
    } as MessageEvent);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "transition-mutation", ok: false }), "*");
    loadHandler();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    host.dispose();
  });

  it("delivers subscription failures after the subscribe acknowledgement", async () => {
    let handler!: (event: MessageEvent) => void;
    const events = {
      addEventListener: (_type: string, listener: EventListener) => { handler = listener as (event: MessageEvent) => void; },
      removeEventListener: vi.fn(),
    };
    const sent: unknown[] = [];
    const parent = { postMessage: (value: unknown) => sent.push(value) } as unknown as WindowProxy;
    vi.stubGlobal("window", { sessionStorage: new StorageWindow().sessionStorage,
      setTimeout,
      clearTimeout,
    });
    const onError = vi.fn();
    const transport = new ParentCommentTransport(parent, events as never, "guide.html");
    transport.subscribe(vi.fn(), vi.fn(), onError);
    expect(sent).toEqual([]);
    handler({ source: parent, data: { type: COMMENTOR_PARENT_READY, parentGeneration: "host-1" } } as MessageEvent);
    const request = sent[0] as { requestId: string };
    handler({ source: parent, data: { type: COMMENTOR_PARENT_RESPONSE, requestId: request.requestId, ok: true } } as MessageEvent);
    handler({ source: parent, data: { type: COMMENTOR_PARENT_ERROR, error: "Comments could not be loaded" } } as MessageEvent);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Comments could not be loaded" }));
    handler({ source: parent, data: { type: COMMENTOR_PARENT_READY, parentGeneration: "host-1" } } as MessageEvent);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ method: "subscribe", args: { documentPath: "guide.html" } });
    transport.dispose();
  });
});

describe("slow comment mutations", () => {
  afterEach(() => vi.useRealTimers());

  function transportRuntime() {
    vi.useFakeTimers();
    vi.stubGlobal("window", { sessionStorage: new StorageWindow().sessionStorage, setTimeout, clearTimeout });
    let handler!: (event: MessageEvent) => void;
    const events = {
      addEventListener: (_type: string, listener: EventListener) => { handler = listener as (event: MessageEvent) => void; },
      removeEventListener: vi.fn(),
    };
    const postMessage = vi.fn();
    const parent = { postMessage };
    const transport = new ParentCommentTransport(parent, events as never, "guide.html");
    const dismissSlow = vi.fn();
    const slow = vi.fn(() => dismissSlow);
    const update = vi.fn();
    transport.subscribe(update, vi.fn(), vi.fn(), slow);
    const respond = (ok: boolean, index = 0) => {
      const request = postMessage.mock.calls[index][0] as { requestId: string };
      handler({ source: parent, data: { type: COMMENTOR_PARENT_RESPONSE, requestId: request.requestId, ok } } as unknown as MessageEvent);
    };
    const publish = () => handler({ source: parent, data: {
      type: COMMENTOR_PARENT_UPDATE,
      threads: [{ _id: "thread-1", resolved: true }],
      canLoadMore: false,
      loading: false,
    } } as unknown as MessageEvent);
    return { transport, slow, dismissSlow, postMessage, respond, publish, update };
  }

  it("accepts a successful resolve after a 53-second delay", async () => {
    const { transport, slow, postMessage, respond } = transportRuntime();
    const settled = vi.fn();
    const operation = transport.mutate("thread.resolve", { threadId: "thread-1" }).then(settled);
    await vi.advanceTimersByTimeAsync(53_256);
    expect(settled).not.toHaveBeenCalled();
    expect(slow).not.toHaveBeenCalled();
    respond(true);
    await operation;
    expect(settled).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    transport.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["thread.create", "thread.resolve", "thread.archive", "thread.remove", "reply.add", "reply.remove"] as const)(
    "keeps %s pending after the soft deadline, offers recovery, and accepts a late result without retrying",
    async (method) => {
      const { transport, slow, dismissSlow, postMessage, respond, publish, update } = transportRuntime();
      const settled = vi.fn();
      const operation = transport.mutate(method, {}).then(settled);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(slow).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(postMessage).toHaveBeenCalledTimes(1);
      publish();
      expect(update).toHaveBeenCalledWith([{ _id: "thread-1", resolved: true }], false, false);
      respond(true);
      await operation;
      expect(settled).toHaveBeenCalledTimes(1);
      expect(dismissSlow).toHaveBeenCalledTimes(1);
      transport.dispose();
    },
  );

  it("guards each reply deletion independently within the same thread", async () => {
    const { transport, postMessage, respond } = transportRuntime();
    const firstArgs = { threadId: "thread-1", replyId: "reply-1" };
    const secondArgs = { threadId: "thread-1", replyId: "reply-2" };
    const first = transport.mutate("reply.remove", firstArgs);
    expect(transport.mutate("reply.remove", firstArgs)).toBe(first);
    expect(transport.isMutationPending("reply.remove", secondArgs)).toBe(false);
    const second = transport.mutate("reply.remove", secondArgs);
    expect(second).not.toBe(first);
    expect(postMessage).toHaveBeenCalledTimes(2);
    respond(true);
    await first;
    expect(transport.isMutationPending("reply.remove", firstArgs)).toBe(false);
    expect(transport.isMutationPending("reply.remove", secondArgs)).toBe(true);
    respond(true, 1);
    await second;
    expect(transport.isMutationPending("reply.remove", secondArgs)).toBe(false);
    transport.dispose();
  });

  it("still reports an explicit server rejection after a slow mutation", async () => {
    const { transport, respond, dismissSlow } = transportRuntime();
    const result = transport.mutate("thread.resolve", {}).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(61_000);
    respond(false);
    expect(await result).toBe("Comment operation failed");
    expect(dismissSlow).toHaveBeenCalledTimes(1);
    transport.dispose();
  });

  it("cleans up a pending mutation when its document transport closes", async () => {
    const { transport, slow } = transportRuntime();
    const result = transport.mutate("thread.resolve", {}).catch((error: Error) => error.message);
    transport.dispose();
    expect(await result).toBe("Comment transport closed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds unanswered read/control requests without suggesting a page reload", async () => {
    const { transport, slow } = transportRuntime();
    const result = transport.loadMoreThreads().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBe("Comments are taking longer to load. Still waiting for the connection.");
    expect(slow).not.toHaveBeenCalled();
    transport.dispose();
  });
});
