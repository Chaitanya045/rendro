import { mutationKey, type CommentRecoveryState } from "../src/commentor/operation-state";
import { buildSync } from "esbuild";
import { Window, type HTMLButtonElement, type HTMLTextAreaElement } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMENTOR_PARENT_READY,
  COMMENTOR_PROTOCOL_VERSION,
  COMMENTOR_VIEWER_RELOAD,
  COMMENTOR_UPGRADE_NOTICE,
  COMMENTOR_PARENT_REPLIES_UPDATE,
  COMMENTOR_PARENT_REQUEST,
  COMMENTOR_PARENT_RESPONSE,
  COMMENTOR_PARENT_UPDATE,
  type CommentorParentRequest,
} from "../src/commentor/parent-protocol";

const bundle = buildSync({
  entryPoints: ["src/commentor/commentor.ts"], bundle: true, write: false, format: "iife", platform: "browser",
}).outputFiles[0].text;
const windows: Window[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});

async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function widget(options: { canDelete?: boolean; replyCanDelete?: boolean; archived?: boolean; resolved?: boolean; recoveryState?: CommentRecoveryState; ready?: Record<string, unknown> | null } = { canDelete: true, replyCanDelete: true }) {
  vi.useFakeTimers();
  const win = new Window({ url: "https://rendro.test/guide.html", settings: { enableJavaScriptEvaluation: true } });
  windows.push(win);
  const requests: CommentorParentRequest[] = [];
  const reloadViewer = vi.fn();
  const parent = { postMessage: (data: CommentorParentRequest) => {
    if ((data as { type: string }).type === COMMENTOR_VIEWER_RELOAD) reloadViewer();
    if (data.type !== COMMENTOR_PARENT_REQUEST) return;
    requests.push(data);
    if (["draft.save", "operation.complete"].includes(data.method)) {
      void Promise.resolve().then(() => send({ type: COMMENTOR_PARENT_RESPONSE, requestId: data.requestId, ok: true }));
    }
    if (data.method === "subscribe") {
      void Promise.resolve().then(() => {
        send({ type: COMMENTOR_PARENT_RESPONSE, requestId: data.requestId, ok: true });
        publish();
      });
    }
  } };
  Object.defineProperty(win, "parent", { value: parent });
  Object.assign(win, {
    setTimeout, clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    COMMENTOR: { transport: "parent", organizationId: "org-a", projectId: "project-a", documentPath: "guide.html", canWrite: true },
  });
  win.document.body.innerHTML = "<main>Document</main>";
  const send = (data: unknown) => win.dispatchEvent(new win.MessageEvent("message", { source: parent as never, data }));
  const publish = () => send({
    type: COMMENTOR_PARENT_UPDATE, canLoadMore: false, loading: false,
    threads: [{
      _id: "thread-1", _creationTime: Date.now(), authorName: "Author", authorEmail: "author@test.com",
      body: "Comment", anchor: { kind: "element", path: ["main"] }, resolved: options.resolved ?? false,
      archived: options.archived ?? false, canDelete: options.canDelete,
      replies: [{ _id: "reply-1", _creationTime: Date.now(), authorName: "Reply author", body: "Reply", canDelete: options.replyCanDelete }],
    }],
  });
  win.eval(bundle);
  win.document.dispatchEvent(new win.Event("DOMContentLoaded"));
  if (options.ready !== null) send({ type: COMMENTOR_PARENT_READY, ...(options.ready ?? { protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host-1", recoveryState: options.recoveryState, userId: "user-a" }) });
  await flush();
  const root = win.document.getElementById("commentor-host")!.shadowRoot!;
  const button = (testId: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
  const mutations = () => requests.filter((request) => !["subscribe", "draft.save", "operation.complete"].includes(request.method));
  const finish = () => send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations()[0].requestId, ok: true });
  return { win, root, button, requests, mutations, send, publish, finish, reloadViewer };
}

describe("comment widget recovery controls", () => {
  it.each(["resolve", "archive", "unarchive", "delete-reply"])("Refresh preserves the %s guard across rendered controls and accepts the late result", async (action) => {
    const { root, button, requests, mutations, finish } = await widget({
      canDelete: true, replyCanDelete: true, archived: action === "unarchive",
    });
    if (action === "unarchive") root.querySelector<HTMLButtonElement>('[data-filter="history"]')!.click();
    const testId = `commentor-${action === "unarchive" ? "archive" : action}-btn`;
    button(testId).click();
    button(testId).click();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(root.querySelector(".toast")?.textContent).not.toMatch(/try(?:ing)? again/i);
    const refresh = root.querySelector<HTMLButtonElement>(".toast button")!;
    expect(refresh.textContent).toBe("Refresh");
    refresh.click();
    await flush();
    expect(requests.filter((request) => request.method === "subscribe")).toHaveLength(2);
    const replacement = button(testId);
    expect(replacement.disabled).toBe(true);
    replacement.click();
    expect(mutations()).toHaveLength(1);
    finish();
    await flush();
    expect(button(testId).disabled).toBe(false);
  });

  it.each(["refresh", "replace host"])("settles an in-flight thread deletion after %s without replaying it", async (recovery) => {
    const { root, button, mutations, send, finish } = await widget();
    const remove = button("commentor-delete-btn");
    remove.click();
    remove.click();
    await vi.advanceTimersByTimeAsync(65_001);
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0].method).toBe("thread.remove");
    if (recovery === "refresh") {
      root.querySelector<HTMLButtonElement>(".toast button")!.click();
      await flush();
      expect(root.querySelector('[data-testid="commentor-delete-btn"]')).toBeNull();
      finish();
      send({ type: COMMENTOR_PARENT_UPDATE, threads: [], canLoadMore: false, loading: false });
    } else {
      send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host-2" });
      await flush();
      expect(button("commentor-delete-btn")).not.toBeNull();
      expect(root.querySelector('.toast[role="alert"]')?.textContent).toContain("outcome is unknown");
      finish();
    }
    await flush();
    expect(mutations()).toHaveLength(1);
    expect(root.querySelector('.toast[role="status"]')?.getAttribute("data-state")).toBe("closed");
  });

  describe.each(["refresh", "replace host"])("permissions after %s", (recovery) => {
    it.each([
      [false, false], [undefined, undefined], [true, false], [false, true],
    ])("uses fresh thread (%s) and reply (%s) permissions even after a late ack", async (canDelete, replyCanDelete) => {
      const permissions = { canDelete: true as boolean | undefined, replyCanDelete: true as boolean | undefined };
      const { root, button, mutations, send, finish } = await widget(permissions);
      // An expanded reply page from the old subscription must not override
      // permissions supplied by the replacement subscription.
      send({ type: COMMENTOR_PARENT_REPLIES_UPDATE, threadId: "thread-1", canLoadMore: false, loading: false,
        replies: [{ _id: "reply-1", _creationTime: Date.now(), authorName: "Reply author", body: "Reply", canDelete: true }],
      });
      button("commentor-resolve-btn").click();
      await vi.advanceTimersByTimeAsync(60_001);
      permissions.canDelete = canDelete;
      permissions.replyCanDelete = replyCanDelete;
      if (recovery === "refresh") root.querySelector<HTMLButtonElement>(".toast button")!.click();
      else send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host-2" });
      await flush();
      const checkPermissions = () => {
        expect(Boolean(root.querySelector('[data-testid="commentor-delete-btn"]'))).toBe(canDelete === true);
        expect(Boolean(root.querySelector('[data-testid="commentor-archive-btn"]'))).toBe(canDelete === true);
        expect(Boolean(root.querySelector('[data-testid="commentor-delete-reply-btn"]'))).toBe(replyCanDelete === true);
        expect(button("commentor-resolve-btn")).not.toBeNull();
      };
      checkPermissions();
      finish();
      await flush();
      checkPermissions();
      expect(button("commentor-resolve-btn").disabled).toBe(false);
      expect(mutations()).toHaveLength(1);
    });
  });

  it.each(["refresh", "replace host"])("preserves a create draft and reconciles its pending controls on %s", async (recovery) => {
    const { win, root, button, mutations, send, finish } = await widget();
    button("commentor-comment-btn").click();
    win.document.querySelector("main")!.click();
    const input = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-composer-textarea"]')!;
    input.value = "New comment draft";
    button("commentor-composer-post").click();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(button("commentor-composer-post").disabled).toBe(true);
    if (recovery === "refresh") {
      root.querySelector<HTMLButtonElement>(".toast button")!.click();
      await flush();
      expect(button("commentor-composer-post").disabled).toBe(true);
      button("commentor-composer-post").click();
      // Trying to open another composer must retain the original guard/draft.
      button("commentor-comment-btn").click();
      win.document.querySelector("main")!.click();
      expect(root.querySelector('[data-testid="commentor-composer-textarea"]')).toBe(input);
      expect(input.value).toBe("New comment draft");
      finish();
      await flush();
      expect(root.querySelector('[data-testid="commentor-composer"]')?.getAttribute("data-state")).toBe("closed");
    } else {
      send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host-2" });
      await flush();
      expect(button("commentor-composer-post").disabled).toBe(false);
      expect(input.disabled).toBe(false);
      expect(input.value).toBe("New comment draft");
      const notice = root.querySelector('.toast[role="alert"]')?.textContent;
      expect(notice).toContain("outcome is unknown");
      expect(notice).not.toMatch(/try again/i);
    }
    expect(mutations()).toHaveLength(1);
  });

  it("clears a reply's pending UI on a new host generation and shows outcome unknown without replaying", async () => {
    const { root, button, mutations, send, finish } = await widget();
    const input = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!;
    input.value = "Draft to preserve";
    input.dispatchEvent(new windows[0].Event("input"));
    button("commentor-reply-send").click();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(button("commentor-reply-send").disabled).toBe(true);
    send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host-2" });
    await flush();
    expect(button("commentor-reply-send").disabled).toBe(false);
    const restored = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!;
    expect(restored.disabled).toBe(false);
    expect(restored.value).toBe("Draft to preserve");
    expect(root.querySelector('.toast[role="alert"]')?.textContent).toContain("outcome is unknown");
    expect(root.querySelector('.toast[role="status"]')?.getAttribute("data-state")).toBe("closed");
    expect(mutations()).toHaveLength(1);
    finish();
    await flush();
    expect(restored.value).toBe("Draft to preserve");
  });
});


describe("safe resubmission through rendered recovery controls", () => {
  it.each(["create", "reply", "resolve", "reopen", "archive", "unarchive", "delete", "delete-reply"])(
    "%s resubmits the original ID and target after BFCache host replacement",
    async (action) => {
      const { win, root, button, mutations, send } = await widget({ canDelete: true, replyCanDelete: true, archived: action === "unarchive", resolved: action === "reopen" });
      if (action === "unarchive") root.querySelector<HTMLButtonElement>('[data-filter="history"]')!.click();
      if (action === "reopen") root.querySelector<HTMLButtonElement>('[data-filter="resolved"]')!.click();
      if (action === "create") {
        button("commentor-comment-btn").click();
        win.document.querySelector("main")!.click();
        root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-composer-textarea"]')!.value = "Persist me";
      }
      if (action === "reply") root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!.value = "Persist me";
      const testId = action === "create" ? "commentor-composer-post" : action === "reply" ? "commentor-reply-send"
        : `commentor-${action === "unarchive" ? "archive" : action === "reopen" ? "resolve" : action}-btn`;
      button(testId).click();
      if (action === "delete") await vi.advanceTimersByTimeAsync(5001);
      expect(mutations()).toHaveLength(1);
      const original = mutations()[0].args as Record<string, unknown>;
      expect(original.clientOperationId).toMatch(/^[a-f0-9-]{36}$/);
      send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "restored-host" });
      await flush();
      expect(button(testId).disabled).toBe(false);
      button(testId).click();
      if (action === "delete") await vi.advanceTimersByTimeAsync(5001);
      expect(mutations()).toHaveLength(2);
      expect(mutations()[1].args).toEqual(original);
      if (action === "reopen") expect(original.resolved).toBe(false);
      if (action === "unarchive") expect(original.archived).toBe(false);
      expect(root.querySelector('.toast[role="alert"]')?.textContent).toContain("Resubmitting this action is safe");
    },
  );

  it.each(["create", "reply"])("restores the %s draft and operation ID in a new iframe widget", async (action) => {
    const first = await widget();
    if (action === "create") {
      first.button("commentor-comment-btn").click();
      first.win.document.querySelector("main")!.click();
    }
    const inputId = action === "create" ? "commentor-composer-textarea" : "commentor-reply-input";
    const buttonId = action === "create" ? "commentor-composer-post" : "commentor-reply-send";
    const input = first.root.querySelector<HTMLTextAreaElement>(`[data-testid="${inputId}"]`)!;
    input.value = "Draft across reload";
    input.dispatchEvent(new first.win.Event("input"));
    expect(first.requests.some((r) => r.method === "draft.save")).toBe(true);
    first.button(buttonId).click();
    const original = first.mutations()[0];
    const args = original.args as Record<string, unknown>;
    const method = action === "create" ? "thread.create" : "reply.add";
    const recoveryState: CommentRecoveryState = {
      operations: { [mutationKey(method, args)]: { method, args, clientOperationId: args.clientOperationId as string } },
      drafts: { [action === "create" ? "create" : "thread-1"]: args },
    };
    const next = await widget({ canDelete: true, replyCanDelete: true, recoveryState });
    expect(next.root.querySelector<HTMLTextAreaElement>(`[data-testid="${inputId}"]`)!.value).toBe("Draft across reload");
    next.button(buttonId).click();
    expect(next.mutations()).toHaveLength(1);
    expect(next.mutations()[0].args).toEqual(args);
  });

  it.each(["create", "reply"])("clears the recovered %s draft when its operation appears in the subscription", async (action) => {
    const method = action === "create" ? "thread.create" : "reply.add";
    const args = { body: "Confirmed draft", anchor: { kind: "element", path: ["main"] }, ...(action === "reply" ? { threadId: "thread-1" } : {}) };
    const recoveryState: CommentRecoveryState = {
      operations: { [mutationKey(method, args)]: { method, args, clientOperationId: "confirmed" } },
      drafts: { [action === "create" ? "create" : "thread-1"]: args },
    };
    const { root, send, requests } = await widget({ canDelete: true, replyCanDelete: true, recoveryState });
    send({ type: COMMENTOR_PARENT_UPDATE, canLoadMore: false, loading: false, threads: [{
      _id: "thread-1", _creationTime: Date.now(), authorName: "Author", body: "Confirmed draft",
      anchor: args.anchor, resolved: false, canDelete: true,
      ...(action === "create" ? { clientOperationId: "confirmed" } : {}),
      replies: action === "reply" ? [{ _id: "reply-2", _creationTime: Date.now(), authorName: "Author", body: "Confirmed draft", clientOperationId: "confirmed" }] : [],
    }] });
    await flush();
    expect(requests.some((r) => r.method === "operation.complete")).toBe(true);
    if (action === "create") expect(root.querySelector('.composer[data-state="open"]')).toBeNull();
    else expect(root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!.value).toBe("");
  });
});


describe("editable rejected drafts and identity changes", () => {
  it.each(["create", "reply"])("allows a corrected %s after oversized validation and a definitive permission rejection", async (action) => {
    const { win, root, button, mutations, send } = await widget();
    if (action === "create") {
      button("commentor-comment-btn").click();
      win.document.querySelector("main")!.click();
    }
    const inputId = action === "create" ? "commentor-composer-textarea" : "commentor-reply-input";
    const buttonId = action === "create" ? "commentor-composer-post" : "commentor-reply-send";
    const input = () => root.querySelector<HTMLTextAreaElement>(`[data-testid="${inputId}"]`)!;
    input().value = "x".repeat(10_001);
    button(buttonId).click();
    await flush();
    expect(mutations()).toHaveLength(0);
    input().value = "Corrected";
    button(buttonId).click();
    await flush();
    expect(mutations()).toHaveLength(1);
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations()[0].requestId, ok: false, rejected: true, error: "Permission denied" });
    await flush();
    expect(input().value).toBe("Corrected");
    expect(Array.from(root.querySelectorAll('.toast[role="alert"]')).at(-1)?.textContent).toContain("Permission denied");
    input().value = "Edited after rejection";
    button(buttonId).click();
    await flush();
    expect(mutations()).toHaveLength(2);
    expect((mutations()[1].args as { clientOperationId: string }).clientOperationId).not.toBe((mutations()[0].args as { clientOperationId: string }).clientOperationId);
  });

  it.each(["user-b", null])("removes visible private drafts when the identity becomes %s", async (userId) => {
    const { win, root, button, send } = await widget();
    const reply = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')!;
    reply.value = "Private reply";
    reply.dispatchEvent(new win.Event("input"));
    button("commentor-comment-btn").click();
    win.document.querySelector("main")!.click();
    const composer = root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-composer-textarea"]')!;
    composer.value = "Private comment";
    composer.dispatchEvent(new win.Event("input"));
    send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "other-account", userId, recoveryState: { operations: {}, drafts: {} } });
    await flush();
    expect(root.querySelector('[data-testid="commentor-composer-textarea"]')).toBeNull();
    expect(root.querySelector<HTMLTextAreaElement>('[data-testid="commentor-reply-input"]')?.value ?? "").toBe("");
  });
});


describe("comment widget asset skew", () => {
  it.each([
    {}, // v1 parent: no generation or protocol version
    { parentGeneration: "v4" }, // generation alone is not a durable-write contract
    { parentGeneration: "old", protocolVersion: COMMENTOR_PROTOCOL_VERSION - 1 },
    { parentGeneration: "future", protocolVersion: COMMENTOR_PROTOCOL_VERSION + 1 },
    { protocolVersion: COMMENTOR_PROTOCOL_VERSION }, // malformed READY
  ])("shows an accessible upgrade notice for incompatible READY %j", async (ready) => {
    const { root, button, requests, publish } = await widget({ ready });
    button("commentor-panel-btn").click();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(COMMENTOR_UPGRADE_NOTICE);
    expect(root.querySelector('[role="status"]')?.textContent).toContain("browser’s Reload button");
    expect(root.querySelector('a[target="_top"]')).toBeNull();
    expect(button("commentor-comment-btn").disabled).toBe(true);
    button("commentor-comment-btn").click();
    publish(); // Legacy snapshots cannot restore writable controls.
    await flush();
    expect(requests).toEqual([]);
    expect(root.querySelector('[data-testid="commentor-resolve-btn"]')).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(COMMENTOR_UPGRADE_NOTICE);
  });

  it("uses the advertised parent reload capability for an incompatible version", async () => {
    const { root, button, reloadViewer, requests } = await widget({ ready: {
      parentGeneration: "future", protocolVersion: COMMENTOR_PROTOCOL_VERSION + 1, canReloadViewer: true,
    } });
    button("commentor-panel-btn").click();
    const reload = root.querySelector<HTMLButtonElement>('[role="status"] button')!;
    expect(reload.textContent).toBe("Reload page");
    reload.click();
    expect(reloadViewer).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);
  });

  it("enables comments only after the compatible parent handshake", async () => {
    const { root, button, send, requests, mutations, finish } = await widget({ ready: null });
    expect(button("commentor-comment-btn").disabled).toBe(true);
    expect(requests).toEqual([]);
    send({ type: COMMENTOR_PARENT_READY });
    send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "new", userId: "user-a" });
    await flush();
    expect(root.querySelector('[role="status"]')).toBeNull();
    expect(button("commentor-comment-btn").disabled).toBe(false);
    button("commentor-resolve-btn").click();
    expect(mutations()).toHaveLength(1);
    finish();
    await flush();
  });
});
