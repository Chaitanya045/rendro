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
    vi.stubGlobal("window", {
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
    expect(postMessage).toHaveBeenCalledWith({ type: COMMENTOR_PARENT_READY }, "*");
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
      { body: "Scoped comment", anchor: { kind: "element", path: ["main"] } },
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
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ requestId: "transition", ok: false }), "*");
    messageHandler({
      source,
      data: { type: COMMENTOR_PARENT_REQUEST, requestId: "transition-mutation", method: "thread.resolve", args: { threadId: "current-thread" } },
    } as MessageEvent);
    expect(mutate).toHaveBeenCalledTimes(1);
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
    vi.stubGlobal("window", {
      setTimeout,
      clearTimeout,
    });
    const onError = vi.fn();
    const transport = new ParentCommentTransport(parent, events as never, "guide.html");
    transport.subscribe(vi.fn(), vi.fn(), onError);
    expect(sent).toEqual([]);
    handler({ source: parent, data: { type: COMMENTOR_PARENT_READY } } as MessageEvent);
    const request = sent[0] as { requestId: string };
    handler({ source: parent, data: { type: COMMENTOR_PARENT_RESPONSE, requestId: request.requestId, ok: true } } as MessageEvent);
    handler({ source: parent, data: { type: COMMENTOR_PARENT_ERROR, error: "Comments could not be loaded" } } as MessageEvent);
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Comments could not be loaded" }));
    handler({ source: parent, data: { type: COMMENTOR_PARENT_READY } } as MessageEvent);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ method: "subscribe", args: { documentPath: "guide.html" } });
    transport.dispose();
  });
});
