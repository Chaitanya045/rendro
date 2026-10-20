// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { CommentOperationConflictError } from "../src/commentor/operation-state";
import { CommentMutationOutcomeUnknownError } from "../src/commentor/parent-transport";
import { COMMENTOR_PARENT_READY, COMMENTOR_PARENT_RESPONSE, COMMENTOR_PARENT_UPDATE, COMMENTOR_PROTOCOL_VERSION, type CommentorParentRequest } from "../src/commentor/parent-protocol";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const anchor = { kind: "repo-text" as const, blobSha: "b".repeat(40), headingSlug: "", prefix: "", exact: "Comment target", suffix: "", offset: 0 };
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

it("renders a quota through the transport and preserves create/reply drafts until an explicit retry", async () => {
  vi.useFakeTimers();
  const requests: CommentorParentRequest[] = [];
  const parent = { postMessage(data: CommentorParentRequest) {
    requests.push(data);
    if (["subscribe", "draft.save", "operation.complete"].includes(data.method)) {
      queueMicrotask(() => send({ type: COMMENTOR_PARENT_RESPONSE, requestId: data.requestId, ok: true }));
    }
  } };
  Object.defineProperty(window, "parent", { configurable: true, value: parent });
  const script = document.createElement("script");
  script.setAttribute("data-commentor-config", JSON.stringify({ transport: "parent", repoId: 9101, blobSha: anchor.blobSha, documentPath: "index.md" }));
  Object.defineProperty(document, "currentScript", { configurable: true, get: () => script });
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { source: parent as never, data }));
  document.body.innerHTML = '<main>Comment target</main>';
  await import("../src/commentor/commentor");
  Reflect.deleteProperty(document, "currentScript");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "host", userId: "user-a", canWrite: true });
  await flush();
  const root = document.querySelector("#commentor-host")!.shadowRoot!;
  const button = (name: string) => root.querySelector<HTMLButtonElement>(`[data-testid="${name}"]`)!;
  const publish = () => send({ type: COMMENTOR_PARENT_UPDATE, canLoadMore: false, loading: false, threads: [{
    _id: "thread", _creationTime: Date.now(), authorName: "Author", body: "Saved", anchor, replies: [],
  }] });
  const mutations = () => requests.filter(request => ["thread.create", "reply.add"].includes(request.method));
  for (const action of ["create", "reply"]) {
    publish();
    if (action === "create") { button("commentor-comment-btn").click(); document.querySelector<HTMLElement>("main")!.click(); }
    // Parent reconnection re-renders the drawer, so always use the live field.
    const field = () => root.querySelector<HTMLTextAreaElement>(`[data-testid="${action === "create" ? "commentor-composer-textarea" : "commentor-reply-input"}"]`)!;
    const submitName = action === "create" ? "commentor-composer-post" : "commentor-reply-send";
    const toast = () => root.querySelector(".toast-region")!.lastElementChild!.textContent;
    const attempt = async (body: string) => {
      field().value = body;
      field().dispatchEvent(new Event("input"));
      button(submitName).click();
      await flush();
    };
    // Non-quota failures keep the existing toasts and never start a cooldown.
    await attempt("Draft");
    // Enter on an empty draft, or while this submission is still pending, sends nothing.
    const pending = mutations().length;
    const enter = () => field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    enter();
    field().value = "";
    enter();
    await flush();
    expect(mutations()).toHaveLength(pending);
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations().at(-1)!.requestId, ok: false, error: "private trace" });
    await flush();
    expect(toast()).toContain(action === "create" ? "Could not post comment" : "Could not post reply");
    const sent = mutations().length;
    await attempt("Edited while unresolved");
    expect(mutations()).toHaveLength(sent);
    expect(toast()).toContain(new CommentOperationConflictError().message);
    await attempt("Draft");
    send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: `${action}-replacement`, userId: "user-a", canWrite: true });
    await flush();
    expect(toast()).toContain(new CommentMutationOutcomeUnknownError().message);
    await attempt("Draft");
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations().at(-1)!.requestId, ok: false, error: "Comment rejected.", rejected: true });
    await flush();
    expect(toast()).toContain("Comment rejected.");
    expect(root.querySelector(".comment-quota")).toBeNull();
    expect(button(submitName).disabled).toBe(false);
    await attempt("Draft");
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations().at(-1)!.requestId, ok: false, error: "quota", rejected: true, retryAfter: 2100 });
    await flush();
    expect(field().value).toBe("Draft");
    expect(field().disabled).toBe(false);
    expect(button(submitName).disabled).toBe(true);
    expect(root.querySelector('.comment-quota')!.textContent).toContain("3 seconds");
    const denied = mutations().length;
    // Dismissal returns focus to the draft; Enter during the delay shows the reason again without sending.
    const focus = vi.spyOn(field(), "focus");
    root.querySelector<HTMLButtonElement>(".comment-quota button")!.click();
    expect(root.querySelector<HTMLElement>(".comment-quota")!.hidden).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(root.querySelector<HTMLElement>(".comment-quota")!.hidden).toBe(false);
    expect(mutations()).toHaveLength(denied);
    await vi.advanceTimersByTimeAsync(2100);
    expect(mutations()).toHaveLength(denied);
    expect(button(submitName).disabled).toBe(false);
    button(submitName).click();
    await flush();
    expect(mutations()).toHaveLength(denied + 1);
    send({ type: COMMENTOR_PARENT_RESPONSE, requestId: mutations().at(-1)!.requestId, ok: true });
    await flush();
    expect(root.querySelector('.comment-quota')).toBeNull();
  }
  send({ type: COMMENTOR_PARENT_READY, protocolVersion: COMMENTOR_PROTOCOL_VERSION, parentGeneration: "new", userId: "user-b" });
  await flush();
});
