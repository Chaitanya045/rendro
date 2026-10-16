import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentOperationState } from "../src/commentor/operation-state";
import { clearCommentRecovery, renderCommentRecoveryLifecycle, syncCommentRecoveryUser } from "../src/commentor/recovery-session";
import { bootCommentorParentHost } from "../src/commentor/parent-host";
import { COMMENTOR_PARENT_READY } from "../src/commentor/parent-protocol";

const clients = vi.hoisted(() => ({ onUpdate: vi.fn(() => () => {}), setAuth: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }));
vi.mock("convex/browser", () => ({ ConvexClient: class {
  onUpdate = clients.onUpdate;
  setAuth = clients.setAuth;
  close = clients.close;
} }));
const windows: Window[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const win of windows.splice(0)) await win.happyDOM.close();
});
function windowFixture() {
  const win = new Window({ url: "https://rendro.test/docs", settings: { enableJavaScriptEvaluation: true, disableIframePageLoading: true } });
  windows.push(win);
  return win;
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe("comment recovery session ownership", () => {
  it("validates the envelope owner and discards mismatched or corrupt entries", () => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    for (const value of [JSON.stringify({ userId: "A", drafts: { create: { body: "Secret" } }, operations: {} }), "broken", JSON.stringify({ userId: "B", drafts: [] })]) {
      storage.setItem("key", value);
      expect(new CommentOperationState(storage, "key", "B").value).toEqual({ operations: {}, drafts: {} });
      expect(storage.getItem("key")).toBeNull();
    }
  });

  it("tolerates storage shrinking while recovery entries are being cleared", () => {
    const removeItem = vi.fn();
    clearCommentRecovery({ length: 1, key: () => null, removeItem } as unknown as Storage);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("publishes a completed sign-out immediately on the post-sign-out page", () => {
    const win = windowFixture();
    win.eval(renderCommentRecoveryLifecycle(null, "", true).replace(/^<script>|<\/script>$/g, ""));
    expect(win.document.documentElement.dataset.rendroSignedOut).toBe("true");
    expect(win.localStorage.getItem("rendro-sign-out")).toBeTruthy();
  });

  it("keeps drafts until successful sign-out and delivers local teardown only after success", async () => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    syncCommentRecoveryUser(storage, "A");
    storage.setItem('commentor-operations:["A","doc1"]', "private draft");
    storage.setItem("unrelated", "keep");
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 502 })).mockResolvedValueOnce(Response.json({ success: true }));
    Object.assign(win, { fetch });
    win.eval(renderCommentRecoveryLifecycle("A").replace(/^<script>|<\/script>$/g, ""));
    const teardown = vi.fn();
    win.addEventListener("commentor-sign-out", teardown);
    win.document.body.innerHTML = '<form method="post" action="/api/auth/sign-out"><button type="submit">Sign out</button></form>';
    const form = win.document.querySelector("form")!;
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(teardown).not.toHaveBeenCalled();
    expect(form.textContent).toContain("Please try again");
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(teardown).toHaveBeenCalledOnce();
    expect(storage.getItem('commentor-operations:["A","doc1"]')).toBe("private draft");
    expect(storage.getItem("unrelated")).toBe("keep");
    expect(win.document.getElementById("rendro-signed-out")?.textContent).toContain("Sign in");
  });

  it("keeps same-user recovery on navigation and clears it only on a different server-rendered identity", () => {
    const win = windowFixture();
    for (const userId of ["B", null]) {
      syncCommentRecoveryUser(win.sessionStorage as unknown as Storage, "A");
      win.sessionStorage.setItem("commentor-operations:legacy", "private");
      win.eval(renderCommentRecoveryLifecycle(userId).replace(/^<script>|<\/script>$/g, ""));
      expect(win.sessionStorage.getItem("commentor-operations:legacy")).toBe(userId ? null : "private");
    }
  });

  it("checks the live server session before BFCache hydration and handles iframe load while the check is pending", async () => {
    const win = windowFixture();
    const storage = win.sessionStorage as unknown as Storage;
    syncCommentRecoveryUser(storage, "A");
    storage.setItem("commentor-operations:legacy", "private");
    win.document.body.innerHTML = '<iframe id="content-frame"></iframe>';
    const frame = win.document.getElementById("content-frame")!;
    frame.setAttribute("src", "https://rendro.test/organizations/org/projects/project/docs/files/guide.html");
    const source = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: source });
    Object.assign(win, { RENDRO_SHARE_CONFIG: { organizationId: "org", projectId: "project", convexUrl: "https://convex.test" } });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", win.document);
    vi.stubGlobal("HTMLIFrameElement", win.HTMLIFrameElement);
    vi.stubGlobal("location", win.location);
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const dispose = bootCommentorParentHost()!;
    frame.dispatchEvent(new win.Event("load"));
    expect(source.postMessage).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/api/auth/get-session?disableCookieCache=true", expect.objectContaining({ cache: "no-store" }));
    finish(Response.json({ user: { id: "B" } }));
    await flush();
    expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: COMMENTOR_PARENT_READY, userId: "B", recoveryState: { operations: {}, drafts: {} } }), "*");
    expect(storage.getItem("commentor-operations:legacy")).toBeNull();
    // An actual sign-out event clears and invalidates this host immediately.
    storage.setItem("commentor-operations:B", "private");
    win.dispatchEvent(new win.Event("commentor-sign-out"));
    expect(storage.getItem("commentor-operations:B")).toBe("private");
    expect(source.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null, recoveryState: { operations: {}, drafts: {} } }), "*");
    dispose();
  });

  describe("session re-checks", () => {
    const persisted = (win: Window) => Object.assign(new win.Event("pageshow"), { persisted: true });
    function checks(userId: string | null = "A") {
      const win = windowFixture();
      const pending: Array<(response: Response | Error) => void> = [];
      const fetch = vi.fn(() => new Promise<Response>((resolve, reject) => {
        pending.push(result => result instanceof Error ? reject(result) : resolve(result));
      }));
      Object.assign(win, { fetch });
      win.eval(renderCommentRecoveryLifecycle(userId).replace(/^<script>|<\/script>$/g, ""));
      return { win, fetch, pending, signedOut: () => win.document.documentElement.dataset.rendroSignedOut === "true" };
    }

    it("runs another check for a trigger that arrives during an in-flight check", async () => {
      const { win, fetch, pending, signedOut } = checks();
      win.dispatchEvent(new win.Event("focus"));
      win.dispatchEvent(persisted(win));
      win.dispatchEvent(persisted(win));
      expect(fetch).toHaveBeenCalledTimes(1);
      // The first read predates the revocation; coalesced triggers get exactly one more.
      pending[0](Response.json({ user: { id: "A" } }));
      await flush();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(signedOut()).toBe(false);
      pending[1](Response.json({}, { status: 401 }));
      await flush();
      expect(signedOut()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
      win.dispatchEvent(new win.Event("focus"));
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("does not queue another check once the first resolves to a sign-out, and survives failed requests", async () => {
      const { win, fetch, pending, signedOut } = checks();
      win.dispatchEvent(new win.Event("focus"));
      win.dispatchEvent(new win.Event("focus"));
      pending[0](Response.json({ user: { id: "B" } }));
      await flush();
      expect(signedOut()).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);

      const retry = checks();
      retry.win.dispatchEvent(new retry.win.Event("focus"));
      retry.pending[0](new Error("offline"));
      await flush();
      retry.win.dispatchEvent(new retry.win.Event("focus"));
      expect(retry.fetch).toHaveBeenCalledTimes(2);
      retry.pending[1](Response.json({ user: { id: "A" } }));
      await flush();
      expect(retry.signedOut()).toBe(false);
      const anonymous = checks(null);
      anonymous.win.dispatchEvent(new anonymous.win.Event("focus"));
      expect(anonymous.fetch).not.toHaveBeenCalled();
    });
  });
});
